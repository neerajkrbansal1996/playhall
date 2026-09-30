# ADR-0006: Report a match that did not count with empty standings, not a per-seat sentinel

- **Status:** Accepted
- **Date:** 2026-09-30
- **Author:** CTO
- **Milestone:** M2
- **Issue:** [PER-42](/PER/issues/PER-42) (raised from [PER-23](/PER/issues/PER-23), PR #7)

## Context

Chess is the first real customer of `MatchResult`, and it immediately hit a hole in the
contract.

`MatchResult.standings` is documented as "one entry per seat in the match, including seats
that forfeited". `SeatOutcome` is `win | loss | draw | eliminated | forfeit | abandoned`.
A chess abort — allowed until both players have moved, or when nobody moves within 30 s —
must record **no result**: no seat won, lost or drew, and nothing lands in anyone's history.
None of the six outcomes mean "this did not count", so `games/chess/src/result.ts` shipped
`standings: []` against a "one entry per seat" contract, plus a game-authored
`detail.recorded: false` flag to say what the empty array meant.

This is not chess-specific. Every abortable lobby has it, and every lobby is abortable:
tic-tac-toe ([PER-18](/PER/issues/PER-18)) today, Prop Hunt in M7. `RESULT_REASONS` already
contains two reasons whose own docstrings say no winner is recorded — `'aborted'` ("ended
before it counted") and `'abandoned'` ("everyone left; no winner is recorded") — so the
platform already believes unrecorded matches exist. It just never said how to encode one.

Two things make this worth an ADR rather than a comment on the PR:

1. **Version pinning.** `MatchResult` is persisted with the match and replayed from the match
   log. Whatever we write today, matches on disk are encoded in it. Getting this wrong is not
   a refactor, it is a migration.
2. **M2 freezes the contracts.** After M2 a `MatchResult` change needs an ADR _and_ board
   approval (ADR-0002 §"Committed to"). The window where this is a few lines closes with M2.

The second question on [PER-42](/PER/issues/PER-42) is narrower: chess has eleven distinct
endings and `ResultReason` has seven values, so fivefold repetition, the fifty-move rule,
stalemate and insufficient material all collapse to `'completed'` with the real reason in
`detail.chessReason`. Chess asks whether `detail` is the sanctioned home for that or a
private field it should not rely on.

## Decision

### 1. Empty `standings` is the sanctioned encoding, and it becomes a typed total function

Option (a) from [PER-42](/PER/issues/PER-42), with one correction: an empty array on its own
is underspecified — it is indistinguishable from a game that forgot to fill standings in. So
the encoding is not "empty array is allowed"; it is **the set of reasons that produce empty
standings is declared in the SDK, and the invariant is total and checkable.**

```ts
/** Reasons for which the match did not count. `standings` is empty for exactly these. */
export const UNRECORDED_RESULT_REASONS = ['aborted', 'abandoned'] as const

export function isRecordedResult(result: MatchResult): boolean
export function validateMatchResult(
  result: MatchResult,
  seatIds: readonly SeatId[],
): MatchResultProblem[]
```

The invariant, enforced by `validateMatchResult` and by a new conformance check:

| `reason` in `UNRECORDED_RESULT_REASONS` | required `standings`                         |
| --------------------------------------- | -------------------------------------------- |
| yes                                     | exactly `[]`                                 |
| no                                      | exactly one entry per seat, no seat repeated |

Plus the ranking rules that were previously only prose: ranks start at 1, ties share a rank
and the next rank skips (1, 1, 3), and a seat id must appear at most once.

`SeatOutcome` does **not** grow a `'no_result'` / `'void'` member. Rejection reasoning is
under _Alternatives_; the short version is that a sentinel is silently mis-read by default and
an empty array cannot be.

### 2. Games do not author the "did this count" flag — the platform derives it

`detail.recorded` comes out of chess. "Does this match count towards a player's history" is a
platform fact about a platform record; a game asserting it is the **server-authoritative**
lens pointed at ourselves. If a game could set `recorded: true` on an aborted match, the
platform would have two answers and no tiebreak. There is one answer: `isRecordedResult()`,
computed from `reason`, which the game already had to pick correctly for the result panel to
say anything sensible.

### 3. `reason` and `outcome` are independent axes. One inference is sanctioned, no others

`reason` describes **how the match ended**. `outcome` describes **what each seat got**. The
platform must not derive either from the other, and chess is the proof that it cannot:
`timeout_vs_insufficient_material` is `reason: 'timeout'` with two `draw` standings, and
`abandonment_draw` is `reason: 'disconnect_forfeit'` with two `draw` standings. Any code that
assumes `timeout` implies a loser is already wrong.

The reason → recorded partition in §1 is the single exception, and it is a _declared_ total
function in the SDK rather than an inference a caller invents. Nothing else may be inferred.

### 4. `detail` is confirmed as the home for a game's own reason code — and it is public

Confirmed: `detail` is where `chessReason` belongs, and `ResultReason` stays at seven values.
Teaching the platform "fivefold repetition" fails the **generality test** on the first
question — no second, unlike game uses it — and a platform enum that grows a member per game
ending is the plugin boundary leaking inward one string at a time.

But "use `detail`" is not enough for the result panel and the match log to rely on it, so the
contract is now explicit:

- `detail` is a **game-owned public field**, not private scratch space. It is JSON-safe,
  persisted verbatim with the match, and returned to clients in the result payload.
- **The platform never reads any key of `detail`.** No key is reserved, no key is special.
  Platform surfaces (lobby result strip, match history row) render `reason` and `standings`
  only.
- The **game's own** `<ResultPanel>` may read any key it wrote. That is the intended consumer.
- Because `detail` is persisted and matches are version-pinned, **its keys are part of the
  game module's public surface.** Changing the meaning of a key is a breaking change to that
  game and needs `migrateState` / a record-version bump — same rule as its state shape.
  A game must document its `detail` keys in its own README.

So chess keeps `chessReason`, `description` and `moves`, drops `recorded`, and gains a
documented key list. No platform change, no enum growth.

## Alternatives considered

### (b) Add a `SeatOutcome` such as `'no_result'` / `'void'`

The option [PER-23](/PER/issues/PER-23) offered as the alternative, and the one that looks
tidier because it preserves "one entry per seat" unconditionally. It loses on three counts.

**It puts a match-level fact on a seat.** "This did not count" is true of the match, not of a
player. Encoding it per seat makes an inconsistent result _representable_:
`[{outcome: 'no_result'}, {outcome: 'win'}]` type-checks and means nothing. Option (a) makes
that state unconstructable — there are no standings to disagree.

**It is the unsafe default for every consumer, present and future.** This is the deciding
argument. Consider the shapes real code takes:

| Consumer code                                       | With `standings: []`  | With a `'no_result'` sentinel   |
| --------------------------------------------------- | --------------------- | ------------------------------- |
| `for (const s of standings) recordFor(s.seatId, s)` | 0 iterations, correct | records a bogus result per seat |
| `standings.filter(s => s.outcome === 'win')`        | `[]`, correct         | `[]`, correct                   |
| `standings.length` as "players who finished"        | `0`, correct          | `2`, wrong                      |
| `rank === 1 ? 'You won' : 'You lost'`               | not reached           | "You won" on an aborted match   |

An empty array is handled correctly by code that has never heard of aborts. A sentinel is
handled _incorrectly_ by exactly that code, and the failure is silent — a phantom win in a
match history, not a crash. Every future consumer, including third-party ones once the SDK is
public, has to learn the sentinel or be quietly wrong. We would be choosing the encoding whose
failure mode is a lie about a player's record over the one whose failure mode is nothing at
all. **Blast radius** decides it.

**It grows the enum that games switch on.** `SeatOutcome` appears in every game's `getResult`
and every result panel. Adding a member is a contract change that forces a new arm into
exhaustive switches in games that will never produce it.

### Allow empty `standings` for any reason, documented as "games may abort"

The literal reading of option (a) from the issue, and the cheapest. Rejected because it makes
the "one entry per seat" invariant unconditional-in-prose and unenforceable-in-code: the
testkit cannot distinguish a sanctioned abort from a game that forgot standings, which is
precisely the bug class the conformance suite exists to catch. Declaring the reason set costs
one exported array and buys a check.

### Add a match-level `recorded: boolean` to `MatchResult`

Explicit, and it survives adding a future reason we have not thought of. Rejected as
redundant-and-therefore-dangerous: it is derivable from `reason`, so it is a second source of
truth that can disagree with the first, authored by the party with the least authority over
the answer (the game). That is the same defect as `detail.recorded`, promoted to a typed
field. If a future reason genuinely does not partition — see _Revisit triggers_ — this comes
back as the replacement, not as a companion.

### Grow `ResultReason` with chess's endings

Rejected: fails the generality test, and puts chess vocabulary in the package that must know
no chess. See §4.

## Evidence

This decision is about representable states and consumer failure modes, not throughput, so
there is no latency or byte number to cite. The checkable claims:

- `RESULT_REASONS` has 7 members; `UNRECORDED_RESULT_REASONS` selects 2 of them, both of whose
  existing docstrings already state that no winner is recorded. The partition is a restatement
  of what the SDK already claimed, not a new concept.
- Chess has 11 `ChessEnding` arms mapping onto those 7 reasons; 1 of the 11 (`abort`) is
  unrecorded. Two arms (`timeout_vs_insufficient_material`, `abandonment_draw`) produce a
  `reason`/`outcome` pairing that no inference rule would predict — the measured basis for §3.
- Blast radius of the code change: `packages/game-sdk/src/result.ts` (+ its barrel), one
  conformance-check name in `packages/game-testkit`, and `games/chess/src/result.ts` (drop one
  `detail` key). No platform-core, no app, no other game.

> **Measurement owed.** Nothing numeric is owed for this decision. The enforcement is owed:
> the `result-standings-well-formed` conformance check must be _implemented_ (not just
> declared) in `packages/game-testkit` on [PER-47](/PER/issues/PER-47) before M2 is accepted.
> Until it is, this ADR rests on review rather than on CI, and review is not a gate.

## Consequences

**Easier**

- A game can end a match that does not count without inventing an encoding, and without a
  platform change. This is the one rule holding: chess needed a contract _decision_, not a
  contract _escape hatch_.
- The lobby, result panel, rematch flow, match history and leaderboard all get "did this
  count" from one function instead of four readings of an empty array.
- The testkit can assert standings well-formedness for every game unconditionally, which
  catches the forgotten-standings bug that the previous prose could not.

**Harder**

- Two places now encode the same partition: `UNRECORDED_RESULT_REASONS` and each game's choice
  of `reason`. A game that returns `reason: 'aborted'` with populated standings is now a
  conformance failure rather than a curiosity. That is the intended trade, but it is a new way
  to fail CI.
- A future reason that is _sometimes_ recorded cannot be expressed. We are betting that
  "recorded" is a property of how a match ended, not of who was in it. See below.

**Committed to**

- `SeatOutcome` stays at six members through M2. Growing it needs an ADR and, after M2, board
  approval.
- `detail` is a supported, persisted, game-owned public field. We will not start reading game
  keys from platform code later — if the platform ever needs a fact, it becomes a typed field
  on `MatchResult` through an ADR, never an agreed-by-convention `detail` key.
- The unrecorded partition is SDK-owned. A game never decides whether its result counts.

**Cost to reverse:** cheap now (a day: two exports, one testkit check name, four lines of
chess), moderate after M2 ships matches to disk (an ADR, board approval, and a migration over
persisted `MatchResult` blobs), which is exactly why it is being decided in this heartbeat.

## Revisit triggers

- **A game needs a match where some seats count and some do not.** A 12-player Prop Hunt round
  where two players are voided for a mid-round join, and the rest are ranked normally. The
  partition-by-reason breaks; the replacement is a per-`Standing` opt-out (`counted?: false`)
  rather than a whole-match sentinel, because at that point it genuinely _is_ a seat fact.
- **A third reason turns out to be unrecorded.** Cheap — add it to
  `UNRECORDED_RESULT_REASONS`. Included here so that change is understood as expected
  maintenance rather than a contract break.
- **The platform needs a fact currently sitting in `detail`.** Rating deltas are the likely
  candidate. That promotes to a typed `MatchResult` field via ADR; it does not get read out of
  `detail`.
- **`SeatOutcome: 'abandoned'` and `ResultReason: 'abandoned'` get confused in review.** The
  two mean different things (one seat walked away vs. everyone did) and share a spelling. If
  that costs us a real bug, rename one — noted here so the next person does not discover the
  collision alone.
