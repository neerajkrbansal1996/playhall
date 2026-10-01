# ADR-0013: Log every mutating entry point, and record the clock it ran on

- **Status:** Proposed
- **Date:** 2026-10-01
- **Author:** Platform Engineer (for CTO review)
- **Milestone:** M1
- **Issue:** [PER-176](/PER/issues/PER-176)

## Context

[ADR-0001](./0001-v1-stack.md) §6.1 makes the Postgres match log the sole tier of record and
says a room is fully reconstructible from

> `(seed, module version, ordered action log, last snapshot)`

**"Ordered action log" is the defect.** A turn-based match has four entry points that mutate
state, not one. All four return an `ApplyResult`:

| Entry point    | Returns       | Expressible in an action log?                                 |
| -------------- | ------------- | ------------------------------------------------------------- |
| `applyAction`  | `ApplyResult` | yes                                                           |
| `onTimer`      | `ApplyResult` | **no** — no action, and for a match-wide timer no seat either |
| `onDisconnect` | `ApplyResult` | **no**                                                        |
| `onReconnect`  | `ApplyResult` | **no**                                                        |

`GameContext.sequence` already documents the correct model — "each accepted action, timer
firing or lifecycle hook increments it" — so the SDK has always contemplated four sources. Only
the log shape and `replay()` were built for one.

The consequence is a **silent** crash-recovery bug, and that is why this is an ADR rather than a
type fix. A match restored from an action-only log comes back missing every timer-driven and
lifecycle-driven transition: a flagged clock un-flagged, a skipped turn un-skipped. Nothing
throws, no schema rejects it, and the replayed state is internally consistent — the player simply
sees a plausible, wrong board. Version pinning and blast radius both apply: the state is written
back to Redis and served as the reconnect snapshot.

Nothing is broken on `main` today. No game mutates state from `onTimer`, and `apps/realtime` has
no room runner. **That is the entire reason to decide it now:** the M1.6 room runner is about to
persist the first match log, and this shape is cheap to choose and expensive to migrate.

Two product principles are at stake: **server-authoritative** (the server is the source of truth
for every timer and result — but only if it can reload one) and the non-functional target
_turn-based games survive a server restart_.

## Decision

**The runner appends exactly one match-log entry for every game entry point it calls that
returned an `ApplyResult`.**

That invariant decides all three open questions at once, which is the point — deciding `onTimer`
alone would leave `onDisconnect` to reopen this next quarter. The shape follows from it:

```ts
export interface MatchLogEntryBase {
  readonly sequence: number
  readonly nowMs: number
}

export type MatchLogEntry<TAction> =
  | (MatchLogEntryBase & { kind: 'action'; seatId: SeatId; action: TAction })
  | (MatchLogEntryBase & { kind: 'timer'; timerId: TimerId; seatId: SeatId | null })
  | (MatchLogEntryBase & { kind: 'disconnect'; seatId: SeatId; reason: DisconnectReason })
  | (MatchLogEntryBase & { kind: 'reconnect'; seatId: SeatId })

export type MatchLog<TAction> = readonly MatchLogEntry<TAction>[]
```

Shipped as `packages/game-sdk/src/match-log.ts`. It lives in the SDK because `platform-core`
writes the log and `game-testkit` replays it, and under the ADR-0002 boundary rules `game-sdk` is
the only package both may depend on.

### 1. `ctx.now` is recorded on every entry, and replayed verbatim

`ctx.now` is an input to the reducer like `state` and `action`. A game that reads it — to stamp a
move time, to decide whether a grace window elapsed — diverges on replay unless the live value
comes back unchanged. `ctx.now` reconstruction, stated per kind as PER-176 asked:

| Kind         | Live `ctx.now`                               | On replay     |
| ------------ | -------------------------------------------- | ------------- |
| `action`     | instant the server accepted the message      | `entry.nowMs` |
| `timer`      | the timer's **deadline**                     | `entry.nowMs` |
| `disconnect` | instant the transport closed / grace expired | `entry.nowMs` |
| `reconnect`  | instant the socket re-attached               | `entry.nowMs` |

One rule, four kinds: **`ctx.now = entry.nowMs`**. Nothing is recomputed.

Recomputation is not available even in principle. A timer deadline cannot be re-derived from
`TimerCommand.delayMs`, because the runner may fire a timer _late_ under load — re-deriving
produces a deadline the live match never used. `TimerService.TimerExpiry.dueAtMs` already carries
the documented instruction "use this as `ctx.now` when replaying"; this ADR is where that stops
being a comment on an unmerged branch and becomes a persisted column.

### 2. There is no separate `dueAtMs` field

PER-176's sketch had `{ kind: 'timer'; …; dueAtMs: number }` alongside the implied clock. We ship
one field. For a timer entry the deadline **is** `ctx.now`, because that is what the runner passes
to `onTimer`. Two fields would let the writer and the replayer disagree about which one is the
clock, and that disagreement is unobservable in a test — it reproduces the exact class of bug
this ADR exists to close. One field cannot be used inconsistently.

### 3. `onDisconnect` / `onReconnect` get entries — **yes**

Asked explicitly on PER-176, answered explicitly. Both return an `ApplyResult`, so the argument
is the timer argument verbatim: an unlogged mutation is a lost mutation.

**This does not contradict [ADR-0008](./0008-game-sdk-contract-v1.md) §8**, which keeps
`isConnected` out of game state so that "every network blip" is not a logged mutation. The
distinction is the hook, not the event: an entry is written only when the game _implements_
`onDisconnect` / `onReconnect`, i.e. only when the drop changed **rules** state and therefore has
to survive a restart. A game that omits the hook logs nothing and consumes no sequence number —
which ADR-0008 §8 notes is almost every game. Presence remains platform state, rendered by
platform UI, never logged.

### 4. `createInitialState` is not an entry

Sequence 0 is reconstructed from `(seed, settings, roster, gameVersion)`, all of which the `matches`
row already carries. Logging it would duplicate the row and create a second place for the two to
disagree.

### 5. Sequence numbers are replayed, not re-counted

`sequence` is persisted per entry and fed back as `ctx.sequence`, because with `seed` it
determines `ctx.rng` (ADR-0008 §3). Re-deriving it from array position would shift every RNG
stream the moment a log is read from an offset — which is precisely what crash recovery does.

### 6. Scope: this ADR is the shape, not the DDL

`match_events` columns, indexes and the snapshot interval belong to the M1.6 room-runner issue.
What is binding here is the entry shape, the four kinds, and `nowMs`. The `kind` set ships as
`MATCH_LOG_ENTRY_KINDS` so a `zod` enum and a Postgres check constraint can share one list.

Real-time games are out of scope. A 30 Hz tick log is not a per-mutation log and gets its own
decision in M6; `MatchLogEntry` is a turn-based shape and is not to be stretched to cover ticks.

## Alternatives considered

### Keep the action-only log and have the runner re-simulate timers on replay

The replayer would reinstall the scheduler, re-derive each deadline from the `TimerCommand`s the
reducer returned, and fire them in order. No schema change.

It lost because it is wrong whenever the live match fired a timer at anything other than its exact
deadline — which is every match under load, and is the normal case for `grace`. Re-simulation
reconstructs the timeline the match _should_ have had instead of the one it did, so a player whose
flag fell 40 ms late comes back un-flagged. It also makes replay a different code path from
production, so the `determinism` check would stop testing the thing it is named after. This is the
same reason ADR-0008 rejected an imperative scheduler inside `applyAction`.

### A single `payload: unknown` column with the kind as a string

Fewer types, trivially extensible, and it is what a generic event-sourcing table looks like.

Rejected because `unknown` is where the next hole hides. The defect being fixed here is a mutation
that the type system could not express and therefore nobody noticed; replacing it with a type that
can express anything removes the compile error that catches the fifth entry point. A discriminated
union makes adding one a failure at every `switch`. ADR-0001 §4.1's "no message type may be defined
in a way that assumes JSON" cuts the same way: `unknown` assumes a JSON bag.

### `seatId: SeatId | null` on the shared base, dropping the per-kind seat fields

Flattens the union and lets a consumer read `entry.seatId` without narrowing.

Rejected because it weakens three of the four kinds to express the one that needs it: only a
match-wide `timer` has no seat. An `action` with a null seat and a `disconnect` with a null seat
are both unrepresentable states that would then compile, and the runner's `null` check would be
the only thing standing between them and the log.

## Evidence

Planted regression, `packages/game-testkit/test/match-log-replay.test.ts` — a two-seat game whose
`onTimer` sets a clock flag, driven live as `action → timer → action` and then replayed. The timer
fires at `1700000031500`, deliberately not the `1700000002000` a sequence-derived clock would
produce.

With `replay()` reverted to pre-ADR behaviour (sequence-derived clock; non-action entries
unrepresentable, therefore skipped), **9 of 10 tests fail**:

```
 ❯ test/match-log-replay.test.ts (10 tests | 9 failed)
   × reproduces the live match exactly
     → expected [ …(4) ] to deeply equal [ …(4) ]
   × restores the flag, so the recovered match is over rather than still live
     → expected null to be 'seat-2' // Object.is equality
   × replays the recorded deadline as ctx.now rather than recomputing it from the sequence
     → expected [ 1700000000000, 1700000001000, …(1) ] to include 1700000031500

  Array [
    Object {
      "dropped": Array [],
-     "flagged": "seat-2",
+     "flagged": null,
      "moves": 1,
      "nowsSeen": Array [
        1700000000000,
        1700000001000,
-       1700000031500,
      ],
    },
```

That diff is the production bug in one frame: the recovered match is missing the flag and missing
the clock it fell on, and `getResult` returns `null` where the live match returned a `timeout`
win — a finished match comes back live.

The tenth test asserts the divergence itself (`an action-only log — the pre-ADR-0013 shape —
silently diverges`) and so passes under both versions by design. It documents the defect; it is
not a gate.

With the decision implemented, the whole `game-testkit` suite is green at **121 passed, 4 skipped
(125)**, up from 111 passed — the 10 new tests, no change to the existing ones. Measured on
`per-176/match-log-entry-shape` at base `6a559ea`.

> **Measurement owed.** Clock-drift-under-replay and the "live match resumes within 10 s" target
> cannot be measured until the M1.6 room runner exists; they are acceptance criteria there, not
> here. Nothing in this ADR rests on an unmeasured number — the claim is about expressibility, and
> the failing output above is the proof.

## Consequences

- **Easier:** the room runner is written against a shape that already covers its four call sites,
  instead of discovering the gap after `match_events` has rows in it. `replay()` is now the same
  code path for crash recovery and for the `determinism` check.
- **Easier:** a fifth mutating entry point becomes a compile error at every `switch` rather than a
  silently dropped transition.
- **Harder:** the runner must thread the real `ctx.now` into every append — including, for a timer,
  the deadline rather than the wall clock at the moment it noticed. That is one line and one easy
  mistake, so it needs a test in M1.6, not just care.
- **Harder:** a game that starts mutating state from `onTimer` now changes what its match log
  contains. Within a pinned `gameVersion` that is fine; across versions it is `migrateState`'s
  problem, unchanged by this ADR.
- **Committed to:** `MatchLogEntry` as a persisted format. Changing it after M1.6 has rows means a
  migration, which is why the `onDisconnect` question is answered here rather than deferred.
- **Cost to reverse:** **cheap** today (no persisted rows exist); **expensive** after M1.6 ships.

### ADR-0001 §6.1 needs a one-line amendment

§6.1's `(seed, module version, ordered action log, last snapshot)` is now wrong on its third term:
it should read _ordered match log_. The code is right and the ADR is stale. Per
`docs/adr/README.md`, a change to what an ADR records is an amendment the **CTO** writes, so it is
not in this branch — flagged on [PER-176](/PER/issues/PER-176) for the CTO to take. ADR-0013
supersedes §6.1 on that term only; the tier-of-record decision itself is untouched.

## Revisit triggers

- **A mutating entry point is added to `TurnBasedGameServer` without a `kind`.** The invariant in
  §Decision is the test: if it returns an `ApplyResult`, it needs an entry.
- **A timer whose expiry must be logged even when it does not mutate state** — e.g. the match log
  becomes the audit trail for a disputed clock. Today an expiry a game ignores writes nothing.
- **The real-time runner wants to share this table.** It should not; see §6. If it does, that is a
  new ADR, not a widened union.
- **`nowMs` and a future `recordedAtMs` are both wanted.** Two clocks per entry is the thing §2
  rejected; wanting it back means the single-clock model broke and should be reopened, not patched.
