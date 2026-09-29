# ADR-0008: Fix the Game SDK contract at v1

- **Status:** Accepted
- **Date:** 2026-09-30
- **Author:** CTO
- **Milestone:** M1
- **Issue:** [PER-10](/PER/issues/PER-10)

## Context

`packages/game-sdk` is the only package a game may import, and it is the hinge the
whole "games are plugins" principle turns on. Chess (M2) is its first real customer;
Prop Hunt (M7) is its second and is real-time, 3D and 4–12 players.

Four constraints shape every decision below:

1. **Server-authoritative.** A modified client must not be able to change an outcome,
   a position or a clock.
2. **Determinism.** Same seed plus same inputs must reproduce the same outcome. This is
   what buys replays, crash recovery after a Redis restart, and reproducible tests.
3. **Real-time readiness.** 30 Hz tick, < 5 ms p99 tick for 12 players, < 30 KB/s down
   per client. A choice that makes those harder in M6 is a choice made wrong in M1.
4. **Version pinning.** A deploy must never break a match in progress.

Once M2 lands, changing any of this needs an ADR _and_ board approval, so the cost of
getting the shape wrong now is high. The cost of over-specifying is lower: unused
optional members are cheap; a missing seam is a rewrite.

## Decision

Ship contract major **1**, exported from `packages/game-sdk`, with the manifest, the
turn-based server contract, the real-time server contract (types only), and the client
contracts as specified in [PER-10](/PER/issues/PER-10). Nine decisions below depart from
the literal wording of the issue or resolve something it left open; each is listed with
what it cost and what it bought.

### 1. Timers are returned as commands, not scheduled by the game

`applyAction` returns `{ state, events, timers? }` rather than `{ state, events }`, and
a game asks for a timer with `setTimer(id, delayMs, seatId)` instead of calling a
scheduler.

A game that could schedule directly would need a handle to the room runner. That is a
side effect inside a reducer we need to be pure, and a hole straight through the plugin
boundary. Delays are relative and the runner resolves them against the same `ctx.now` it
passed in, so replaying an action lands on the same deadline.

### 2. `GameEvent.audience` is required, with no default

`getViewFor` alone does not close the leak. A game that redacts an opponent's hand from
the view and then emits `card_drawn` with the card to everyone has leaked it anyway.
Making `audience` a required field with no default forces the author to decide per
event, and makes the conformance testkit able to check the decision.

A spectator is treated as an opponent of everyone: `toSeats(...)` does not reach
spectators, because the spectator stream is the easiest way to cheat — a player opens it
in a second tab.

### 3. `ctx.rng` is derived from `(seed, sequence)`, not carried in state

`createContextRng(seed, sequence)` builds a fresh stream for every mutation. The stream
is a pure function of the match seed and the sequence number, never of how many numbers
a previous call consumed.

Games therefore never persist RNG state, and replaying a match log from any point — not
just from the start — reproduces the same outcome. `createContextRng` is the single
derivation point, called by both `platform-core` and `game-testkit`, so a replay in a
test and a replay on the server cannot drift.

Algorithm is splitmix32: 32-bit-integer arithmetic only, so it is bit-identical on every
JS engine, which a `Math.random`-derived or float-based generator is not.

### 4. Version pins are exact; there is no compatible-range resolution

`checkVersionPin` rejects a patch bump. Accepting one would mean a bug fix that changes a
legal-move set silently rewrites an in-flight game, and the client's optimistic state
would diverge from the server's with no way to detect it. The registry keeps every
version any live match is pinned to.

`migrateState` is scoped to persisted, **not running** matches and stored replays. It is
never called mid-match.

### 5. Real-time `tick` may mutate the world in place; turn-based `applyAction` may not

At 30 Hz with a 12-player world and a < 5 ms p99 budget, allocating a fresh world per
tick is not affordable. Determinism is preserved the way a lockstep engine preserves it:
same starting world plus the same ordered `(input, tick)` sequence must produce a
byte-identical world.

Turn-based games do not have that pressure — one action per human decision — so they keep
the stronger guarantee, which the runner relies on to hold the previous state for
rollback and for the match log.

### 6. Real-time inputs and snapshots are binary, and the codec interface ships in M1

`BinaryCodec` / `BinaryWriter` / `BinaryReader` are defined now and implemented by
`packages/netcode` in M6.

Defining them in M1 is the point: a JSON-only real-time path is on the "never ship" list,
and the way that gets shipped anyway is that the room runner, the transport adapter and
the match log all quietly assume JSON through M1–M5 and nobody notices until M6.

zod still validates every decoded input. Binary is the wire format, not a reason to
trust the client.

### 7. Client contracts carry no React dependency

`GameComponent<P>` is `(props: P) => unknown`, which every React function component
satisfies, instead of `ComponentType<P>` from `@types/react`.

Depending on React types would pull them into `platform-core` and `apps/realtime`, which
have no business knowing about React, purely so a type could be erased at build time.
Class components are excluded; nothing in v1 needs one.

Component slots are `LazyComponent` thunks returning a dynamic import, so "adding a game
adds zero bytes to other bundles" is structural rather than a review checklist item.

### 8. Presence is not game state

`Seat` carries no `isConnected`. Presence is platform state rendered by platform UI;
putting it in game state would make every network blip a state mutation that has to be
written to the match log and replayed. Games express disconnect behaviour declaratively
through `disconnectPolicy`, and only implement `onDisconnect` / `onReconnect` when a
disconnect changes _rules_ state.

### 9. Games return typed rejections; they do not throw

`validateAction` returns `ValidationResult`. A thrown error is indistinguishable from a
bug, leaving the room runner to choose between killing the match and swallowing it. A
returned rejection is a normal outcome the platform turns into a client response, a
metric and a log line. `ActionError.message` is developer-facing; player copy is resolved
by the platform from `code`, so games never ship UI strings.

## Alternatives considered

### Pass a `ctx.scheduleTimer()` callback instead of returning timer commands

Fewer moving parts and a more familiar API. It lost because it makes `applyAction`
impure: replaying the match log would re-fire every timer as a side effect, so crash
recovery would need the runner to install a no-op scheduler and hope no game ever noticed
the difference. Replay would then be testing a different code path from production.

### Default `GameEvent.audience` to public

Less boilerplate for the common case, which really is the common case. Rejected because
the default is wrong exactly where it matters: a hidden-information game leaks by
omission, and the author who forgot never sees an error. An explicit field costs one line
per event and converts a silent leak into a compile error.

### Thread `settings` into `applyAction` alongside `state`

Convenient — a game could read its time control without copying it. Rejected because it
splits the match's authoritative data across two values: replay, `migrateState` and the
state schema would each have to carry settings separately and keep them in sync. Games
copy what they need into state at `createInitialState`, so state stays the one
self-contained thing a replay has to load.

### Carry RNG state inside game state

The standard approach, and it makes each call's stream depend only on the previous call.
Rejected for two reasons: it puts a serialised generator into every game's state schema
and every match record, and it makes replay strictly sequential — you cannot reconstruct
sequence 400 without running 0–399. Deriving from `(seed, sequence)` gives random access
into the log for free.

### JSON for real-time snapshots in M1, binary in M6

Cheaper now. Rejected on the numbers: at 12 players, 30 Hz and a 30 KB/s budget, a
snapshot has ~1 KB. JSON spends a large fraction of that on repeated property names and
decimal float expansion before a single position is encoded, and offers no delta
mechanism. The structural cost is worse than the byte cost — by M6 the JSON assumption
would be spread across the runner, the transport adapter and the match log.

### `unknown` generics for the erased registry module type

The obvious erasure, and it is what the first implementation used. It does not compile:
component props are contravariant, so a component accepting `GameViewProps<ChessView,
ChessAction>` is not assignable to one accepting `GameViewProps<unknown, unknown>` — that
would be a promise to render props it cannot handle. `never` is the correct erasure and
is what shipped. Worth recording because the `unknown` version looks right and fails only
when a second, differently-typed game is added to the registry.

## Evidence

- **Contracts are implementable without platform internals.** Two complete games are
  implemented against them in `packages/game-sdk/test/fixtures/` — tic-tac-toe
  (turn-based: settings, presets, timers, resignation, timeout, draw, record export) and
  Tag Arena (real-time: tick loop, input clamping, distance-culled snapshots, binary
  codecs). Each imports `@atrium/game-sdk` and `zod`, and nothing else. This is the
  acceptance criterion in [PER-10](/PER/issues/PER-10) demonstrated in the same commit as
  the contracts.
- **120 tests pass; 100% statement, line and function coverage, 99.3% branch coverage** on
  the package (threshold: 80%). Determinism, `applyAction` immutability, redaction,
  legal-action/validation agreement, version pinning and server authority over input are
  each covered by named tests.
- **Two contract defects were found by the fixtures before any game was written**: the
  registry erasure described above, and `VALID` typed widely enough to collapse a game's
  error-code union to `string`. Both are fixed. This is the argument for keeping
  executable fixtures in the SDK package rather than only in `games/_examples`.

> **Measurement owed.** The < 5 ms p99 tick, < 30 KB/s down and snapshot-size figures in
> §5 and §6 are budgets from the roadmap, not measurements. They must be measured by QA
> Engineer against a real 12-player room before M6 opens, on the ADR for the real-time
> path ([PER-21](/PER/issues/PER-21)). Until then §5 and §6 rest on the structural
> argument that a retrofit is more expensive than an unused seam, not on numbers we have
> taken.

## Consequences

- **Easier:** a game is one folder with one import. Adding a second game cannot change
  the first, cannot change the platform, and cannot add bytes to another bundle.
- **Easier:** replay, crash recovery and conformance testing are the same mechanism —
  re-run the log through a pure reducer with a derived RNG.
- **Harder:** game authors must declare timers, event audiences and disconnect policy up
  front. This is deliberate friction at the points where silence is dangerous.
- **Harder:** a game needing real-time behaviour before M6 has nothing to run against.
  The contract compiles; the runner does not exist. That is the board's gate, not a gap.
- **Committed to:** contract major 1. After M2, any change here needs an ADR and board
  approval. `SDK_CONTRACT_VERSION` is the enforcement point — the registry refuses to
  load a game declaring a different major rather than failing at the first `applyAction`.
- **Cost to reverse:** **moderate** before M2 (two fixture games and no shipped game),
  **expensive** after (every game, every stored match state, every pinned version).

## Revisit triggers

- Chess (M2) needs anything the contract cannot express without a platform change. That
  is the contract failing its own test, and the change goes through an ADR.
- A measured 12-player tick exceeds 5 ms p99 with in-place mutation, which would mean the
  world representation, not the contract, is wrong — but reopen §5 before assuming that.
- Snapshot bytes exceed the 30 KB/s budget with the binary codec, which would push delta
  compression or interest management from "the game decides" into the platform.
- A second turn-based game wants a rejection code that is genuinely general, which would
  mean `STANDARD_ACTION_ERROR_CODES` is under-specified.
- Any game needs a seat's connection state inside its rules. One such game is a hook; two
  means §8 was wrong and presence belongs in the roster.
