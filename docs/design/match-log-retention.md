# Match log retention and compaction

- **Serves:** [PER-15](/PER/issues/PER-15) (schema + invariants) and its follow-up under
  [PER-29](/PER/issues/PER-29) (the job that enforces the policy)
- **Owner:** Platform Engineer
- **Status:** Specified, not yet implemented
- **Sources:** [ADR-0001](../adr/0001-v1-stack.md) §§5, 6.1, 6.2; ADR-0003 §2.1

## 1. The problem, with the numbers restated

ADR-0003 §2.1 measures the log at **~31.5 GB/month per 1,000 concurrent players**
(100 actions/s × 730 h × ~120 B/row = 262.8 M rows/month). That figure is the heap only. With
the `(match_id, seq, created_at)` primary key at ~40 B/entry including page overhead, budget:

```
rows      100 actions/s × 730 h                = 262.8 M rows/month
heap      262.8 M × 120 B                      =  31.5 GB/month
PK index  262.8 M × 40 B                       =  10.5 GB/month   (PK is 3 columns, see §3)
                                                ──────────────────
total                                          ≈  42 GB/month per 1,000 concurrent players
```

Cross-check against the match rate below: 262.8 M actions ÷ 2.19 M matches ≈ 120 actions per
match, i.e. 60 moves a side. That is a plausible chess game, so the two independent figures agree.

Nothing currently deletes any of it, and it cannot simply be dropped. ADR-0001 §6.1 (rev 2) makes
this stricter than it was: Redis now holds **only derived or cheap-to-lose data**, so the Postgres
match log is the *sole* tier of record and the only recovery source for a live match. Retention
therefore sits directly on top of the restart-survival guarantee, which is why §4 below is a hard
precondition rather than hygiene.

## 2. Policy

**Retain the full event log for at least 30 days; then compact a finished match to its exported
record.** Adopted as proposed by the CTO on PER-15. Compaction is a delete, never a rewrite.

### What survives compaction

`match_records` holds the game's own `exportRecord` output, which for a turn-based game includes
the RNG seed and the ordered action list. **A compacted match is still fully replayable**, because
determinism means seed + ordered actions reproduce every intermediate state exactly (ADR-0001 §6).
That is the whole reason this policy is safe and not a feature deletion.

### What is lost, stated plainly

Per-event metadata that is not part of the exported record: the wall-clock timestamp of each
event, the actor's connection identity, the view version each event produced, and the audit trail
of rejected actions. So:

- A feature that needs per-move *times* older than 30 days must put them in the exported record,
  not rely on `match_events`. For chess that is free — a PGN with `[%clk]` comments carries move
  times inside the record ([PER-27](/PER/issues/PER-27)).
- This is the generality lens working correctly: core guarantees **seed + ordered actions**
  forever. A game that wants more durability buys it by putting the data in its own record
  through the SDK. Core does not grow a column for it.

### What it is worth

```
before   42 GB/month, unbounded
after    2.19 M matches/month × ~400 B         ≈ 0.9 GB/month  (≈ 45× reduction)
         (500 concurrent matches at a ~10 min mean, per 1,000 concurrent players)
```

`match_records` still grows without bound, ~45× slower. That is out of scope here and needs its
own policy before it matters; it is named so it is not forgotten.

## 3. Why retention must be designed into the PER-15 migration

A 30-day policy implemented as a monthly bulk `DELETE` would remove ~262 M rows per cycle,
generating ~42 GB of WAL, the same again in dead tuples, an autovacuum storm on the hot table, and
a `pg_repack` to get the space back. That is not operable.

Therefore `match_events` is **RANGE-partitioned weekly on `created_at` from the first migration**,
and compaction is `DETACH PARTITION` + `DROP TABLE`: O(1), no WAL proportional to data, no
vacuum, space returned immediately.

```
per partition   262.8 M ÷ 4.35 weeks × 160 B   ≈ 10 GB
retain          5 partitions                   → window 30–37 days, ~50 GB steady state
```

**Two consequences of partitioning that the schema has to absorb, not hide.**

- Postgres requires every unique constraint on a partitioned table to contain all partition
  columns, so the primary key is `(match_id, seq, created_at)` — not `(match_id, seq)`. Uniqueness
  of `(match_id, seq)` is therefore **not** enforced by the database for a match that spans a week
  boundary. It is enforced upstream instead: ADR-0001 §6 gives exactly one lock holder per room,
  and that writer assigns `seq` monotonically. Written down because "the PK guarantees it" is the
  natural assumption and it is false here.
- Recovery reads `WHERE match_id = ? ORDER BY seq`, which without a `created_at` bound scans every
  retained partition. Recovery must pass `created_at >= matches.started_at` so pruning leaves one
  or two partitions. A recovery path that quietly scans five is a 10-second-budget regression.

**Two things partitioning must not break, because the append is on the hot path.** ADR-0001 §6.2
puts the log insert inside the < 150 ms round-trip budget at ≤ 10 ms p95:

- Insert routing to the current partition costs microseconds and does not move that budget — but
  it must be measured alongside the unpartitioned baseline, not assumed.
- A partitioned table with no partition covering `now()` **rejects the insert**. A missed
  maintenance run would therefore fail every action write in the system. So the migration creates
  a `DEFAULT` partition as a backstop and maintenance pre-creates partitions a month ahead: a
  missed run degrades to "rows landed in `DEFAULT`" (recoverable, alertable) instead of "the
  platform stopped accepting moves".

Weekly rather than monthly because monthly partitions can only guarantee "at least 30 days" by
keeping two of them, i.e. up to 60 days and ~84 GB. Partitioning cannot be retrofitted cheaply
once the table holds hundreds of millions of rows, which is why it belongs in PER-15's migration
even though the job that drops partitions ships later.

## 4. The invariant that makes compaction safe for crash recovery

**Recovery reads `match_events` only for matches with `finished_at IS NULL`.** A finished match is
recovered from `match_records`, never from the log. Under ADR-0001 §6.1 there is no Redis copy to
fall back on, so for a live match these rows are the only thing standing between a restart and a
lost game. Two consequences, both testable:

1. Deleting every event row of a finished match must not change any observable behaviour —
   `exportRecord` output, replay, or match history.
2. `exportRecord` must be written to `match_records` **at `game:over`**, from the live in-memory
   log. Nothing downstream may require `match_events` in order to produce a record. If record
   writing were lazy, compaction would silently destroy records.

### The hazard: a live match older than the retention window

A partition drop is time-based; the invariant is match-state-based. Those diverge if a match can
stay unfinished for longer than the retention window — and it can: `casual-no-clock`
(`timeControl: 'unlimited'`) is a shipped chess preset, so no clock bounds a live match, and two
players who keep reconnecting can hold one open indefinitely. Room-lifecycle expiry only closes
rooms that are *abandoned*.

**Precondition on every drop:** a partition may be dropped only if it contains no row belonging to
a match with `finished_at IS NULL`. If it does, skip the drop this cycle and re-check next cycle;
alert if a partition has been undroppable for more than 7 days. Skipping costs at most one extra
partition (~10 GB) and requires no data movement, which is why it beats migrating the stragglers'
rows forward. If it ever fires often enough to matter, the alternatives are forward-migration of
those few rows, or a product rule that adjudicates an abandoned unlimited game — the second is a
product decision, not mine to take.

## 5. Split of work

**In PER-15** (schema and invariants — cheap now, expensive later):

1. `match_events` RANGE-partitioned weekly on `created_at`, with a `DEFAULT` partition; PK
   `(match_id, seq, created_at)`; recovery queries bounded by `created_at`; append-only, no `UPDATE` path. Measured insert p95 reported against the
   ADR-0001 §6.2 budget of ≤ 10 ms.
2. `matches.log_compacted_at timestamptz NULL` — compaction state is a recorded fact, because the
   absence of event rows is ambiguous with a match that produced no actions.
3. The §4 invariant and its two tests.

**In the follow-up under PER-29** (the enforcement job): weekly partition maintenance (pre-create
next, drop the sixth), the §4 precondition check, dry-run mode reporting rows and bytes it *would*
reclaim, a feature flag defaulting to off, and reclaimed-bytes metrics.

**Board gate.** Arming the job in production permanently deletes production rows, which is
board-gated. It ships disabled, with dry-run evidence, and enabling it needs board approval on
[PER-2](/PER/issues/PER-2). Nothing is being asked of the board now — the gate applies when the
job is ready to arm, not while it is dark.

## 6. Done when

- PER-15: a test that deletes every `match_events` row for a finished match and asserts the record
  still replays to the same final state and result; a test that a live match's recovery is
  unaffected by compaction of neighbouring matches; the migration shown to be non-destructive.
- Follow-up: dry-run output on a seeded table reporting the measured bytes reclaimed by one
  partition drop, and a test that a partition containing a live match's events is **not** dropped.
