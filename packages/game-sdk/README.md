# `@atrium/game-sdk`

**The only package a game may import.**

A game imports from here and from third-party libraries. Never from
`@atrium/platform-core`, never from `apps/*`, never from another game. The
dependency-boundary rule fails the build on a violation, in either direction —
the platform may not import a game package either; games load through the
registry.

The rule behind the rule: **a game must never need a change outside its own
folder.** If you find yourself wanting one, that is an SDK ADR, not a patch.

---

## Contents

- [The shape of a game](#the-shape-of-a-game)
- [The manifest](#the-manifest)
- [The turn-based server contract](#the-turn-based-server-contract)
- [The real-time server contract](#the-real-time-server-contract)
- [Client contracts](#client-contracts)
- [The purity rule](#the-purity-rule)
- [Redaction](#redaction)
- [Timers](#timers)
- [Versioning and pinning](#versioning-and-pinning)
- [Package layout](#package-layout)

---

## The shape of a game

A game package default-exports one `GameModule`: a manifest, a server
implementation, and a set of lazily-imported client components.

```ts
import { defineTurnBasedGame } from '@atrium/game-sdk'

export default defineTurnBasedGame({
  manifest,
  server,
  client: {
    GameView: () => import('./client/GameView.js'),
    SettingsForm: () => import('./client/SettingsForm.js'),
  },
})
```

`defineTurnBasedGame` validates the manifest **at import time**. A preset that
fails its own settings schema, a duplicate timer id, a team count that does not
divide the seat count — all of these break the build and CI rather than the
first player who opens a dropdown.

Client components are import thunks, not components. That is structural, not
stylistic: adding a game must add zero bytes to every other bundle, and the only
way to guarantee it is for the registry to hold functions that import, rather
than modules that are imported.

---

## The manifest

The manifest is how the platform learns everything it needs about a game
without importing it. Core never branches on a game id; it branches on manifest
fields. That is what makes "games are plugins" true rather than aspirational.

| Field                                                 | Why the platform needs it                                 |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `id`, `slug`, `name`, `shortDescription`, `thumbnail` | Catalogue, URLs, link previews                            |
| `category`                                            | Lobby filtering                                           |
| `minPlayers`, `maxPlayers`, `teams`, `teamCount`      | Seat allocation, team picker, start gating                |
| `turnModel`                                           | Which room runner drives the match                        |
| `realtime`                                            | Tick rate, snapshot rate, 3D and client-capability gating |
| `hasHiddenInformation`                                | Spectator policy and replay gating                        |
| `usesRandomness`                                      | Whether a seed must be shown in the record                |
| `supportsSpectators`, `supportsBots`                  | Lobby controls                                            |
| `settingsSchema`, `defaultSettings`, `presets`        | The lobby settings form                                   |
| `timers`                                              | Declares every timer id the game may reference            |
| `status`                                              | `live` / `beta` / `coming-soon` / `hidden`                |
| `version`, `sdkContractVersion`                       | Version pinning; see below                                |

`settingsSchema` is a live zod schema, so a manifest is not JSON.
`toCatalogEntry(manifest)` produces the JSON-safe projection that crosses a
network boundary — the lobby catalogue, the registry index, `<HowToPlay>`.

`validateManifest(manifest)` returns every problem at once, including whether
`defaultSettings` and each preset actually satisfy `settingsSchema`.

---

## The turn-based server contract

A turn-based game is a reducer. The room runner owns the socket, the clock, the
seats, the match log and persistence. The game owns the rules.

For one player action the runner does:

1. parse the payload with **`actionSchema`** — a game never sees an
   unvalidated action, so `applyAction` may trust the shape of `action`;
2. call **`validateAction(ctx, state, seatId, action)`**; a rejection goes back
   to that one client and state is untouched;
3. call **`applyAction(ctx, state, seatId, action)`**, persist
   `{ state, events }` to the match log, apply any returned `timers`;
4. fan out, building each recipient's payload with **`getViewFor`** and
   filtering events by `audience`;
5. call **`getResult(state)`**; non-null ends the match.

Steps 2 and 3 are separate on purpose. Move hints and the client's optimistic
preview need to ask "is this legal?" without producing a state, and a runner
that only had `applyAction` would have to apply-and-discard — which is wrong the
moment a game consumes `ctx.rng`.

Optional: `getLegalActions` (hints, bots, the conformance fuzzer), `onTimer`,
`onDisconnect` / `onReconnect`, `exportRecord`, `migrateState`, `stateSchema`.

Required: `disconnectPolicy`, which is declarative — the platform runs the grace
window, the countdown UI and the reconnect token. Most games never need the
hooks; chess is `{ graceMs: 45_000, onGraceExpired: 'forfeit' }` and the
platform clock.

---

## The real-time server contract

**Types and shape only in M1.** The room runner, the netcode kit and the
game-server fleet are M6 and board-gated. The contract exists now so that every
M1 decision — the lobby, seats, the registry, the manifest, results — is made
against a platform that already knows real-time games exist. Retrofitting a tick
loop onto a request/response platform is the expensive mistake this package
prevents.

`inputSchema`, `inputCodec`, `snapshotCodec`, `createWorld`, `onInput`,
`tick(ctx, world, dtMs)`, `getSnapshotFor(world, viewer, options)`, player
lifecycle hooks, `getResult`, `disconnectPolicy`.

Three deliberate differences from the turn-based contract:

- **`tick` may mutate `world` in place.** At 30 Hz with a 12-player world and a
  < 5 ms p99 budget, allocating a fresh world per tick is not affordable.
  Determinism is preserved the way a lockstep engine preserves it: the same
  starting world plus the same ordered `(input, tick)` sequence must produce a
  byte-identical world. No I/O, no ambient clock, no ambient randomness.
- **Inputs and snapshots are binary.** The budget is < 30 KB/s down per client,
  about 1 KB per snapshot. JSON spends most of that on property names before a
  single position is encoded, and has no delta story. zod still validates every
  decoded input — binary is the wire format, not a reason to trust the client.
- **`getSnapshotFor` takes a baseline tick** so the codec can send a delta.

### The `shared/` convention

A real-time game splits into three folders:

```
games/<game>/src/server/   authoritative; may read the full world
games/<game>/src/client/   rendering, input capture, prediction
games/<game>/src/shared/   simulation that runs identically on both
```

`shared/` is the only code a client may re-execute for prediction and
reconciliation, so it obeys the strictest form of the purity rule: no I/O, no
ambient clock or randomness, no `window`, no `process`, and **no import from
`server/` or `client/`**. CI enforces the import direction.

A client predicting with `shared/` never becomes authoritative. The server
result always wins; the client reconciles.

---

## Client contracts

```ts
<GameView   {...{ view, mySeat, seats, dispatch, timers, isSpectator, reviewMode, lastError, legalActions }} />
<GameScene  {...{ snapshot, mySeat, seats, sendInput, renderTick, interpolationDelayMs, isSpectator }} />   // real-time
<HUD        {...{ snapshot, mySeat, seats, timers, isSpectator }} />                                        // real-time
<SettingsForm {...{ value, onChange, presets, disabled, errors }} />   // optional
<ResultPanel  {...{ result, seats, mySeat, onRematch, onExitToLobby, onDownloadRecord }} />   // optional
<HowToPlay    {...{ game, playerCount }} />   // optional
sounds: SoundMap                              // optional
```

The game never mounts a router, opens a socket, reads a cookie, or knows what a
room code is. It receives a view and a `dispatch`, and that is the whole
surface.

`dispatch` is fire-and-forget. The server is authoritative, so the next `view`
_is_ the answer; a rejection arrives as `lastError`.

`TimerView.remainingMs` is already corrected for clock skew and latency by the
platform's timer sync. Render it; do not run your own countdown against the
local clock.

**No React dependency.** These are plain types; `GameComponent<P>` is
`(props: P) => unknown`, which every React function component satisfies.
Depending on `@types/react` would drag React into `platform-core` and
`apps/realtime` purely so a type could be erased at build time. Write ordinary
React function components — nothing here stops you.

---

## The purity rule

Game modules are pure and deterministic.

| Never                               | Instead                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| `Date.now()`, `performance.now()`   | `ctx.now` — server-authoritative, constant for the whole call |
| `Math.random()`                     | `ctx.rng` — seeded from the match seed                        |
| `fetch`, `fs`, a database, a logger | Return `events`; the platform performs                        |
| scheduling a timer                  | Return `TimerCommand`s; the runner schedules                  |

CI enforces the first two by lint over `packages/**` and `games/**`.

`ctx.rng` is derived as a pure function of `(seed, sequence)` — **not** of how
many numbers a previous call consumed. That means a game never persists RNG
state, and replaying a match log from any point reproduces the same outcome.
`rng.fork(label)` gives an independent sub-stream so shuffling a deck cannot
shift the numbers spawn placement receives.

The match seed is created once, on the server, and stored on the match. It is
the only point in the system where non-determinism enters a game.

---

## Redaction

**Nothing leaves the server without passing through `getViewFor` (turn-based) or
`getSnapshotFor` (real-time).** The platform never serialises raw state to a
socket. A hidden-information leak is a correctness bug, not a polish item.

Two rules that are easy to get wrong:

- **Events leave the server too.** Redacting an opponent's hand from the view
  and then emitting `{ type: 'card_drawn', payload: { card } }` to everyone
  leaks it anyway. So `GameEvent.audience` is **required** — there is no
  default, and every author has to decide. Use `PUBLIC`, `toSeats(...)`,
  `SPECTATORS_ONLY` or `SERVER_ONLY`.
- **A spectator is an opponent of everyone.** The spectator stream is the
  easiest way to cheat — a player opens it in a second tab. `toSeats(...)` does
  not reach spectators, by design.

`Viewer` has a third kind, `replay`, which sees everything. The platform may
only construct one after `getResult(state)` is non-null.

---

## Timers

A game does not _start_ a timer, it _asks_ for one:

```ts
return { state: next, events, timers: [setTimer(MOVE_TIMER, 30_000, nextSeat)] }
```

If games could schedule directly they would need a handle to the runner — a
side effect inside a supposedly pure reducer, and a hole straight through the
plugin boundary. Delays are relative; the runner resolves them against the same
`ctx.now` it passed in, so the same input always produces the same deadline.

Every `timerId` must correspond to a `TimerSpec` declared in the manifest.

---

## Versioning and pinning

**A match in progress stays on the module version it started on.** A deploy must
never change the rules under a live game. The registry keeps every version any
live match is pinned to and resolves by **exact** version — not "latest", not a
semver range. `checkVersionPin` accepting a patch bump would mean a bug fix that
changes a legal-move set silently rewrites an in-flight game, and the client's
optimistic state would diverge with no way to tell.

`migrateState(state, fromVersion)` is for the other case: bringing a persisted,
**not running** match or a stored replay forward after a restart. It is never
called mid-match.

`SDK_CONTRACT_VERSION` is the contract major. It is bumped only when a contract
changes shape in a way that breaks existing games; the registry then refuses to
load a mismatch rather than failing at the first `applyAction`. After M2, a bump
needs an SDK ADR **and** board approval.

---

## Package layout

| Module          | What it holds                                                                          |
| --------------- | -------------------------------------------------------------------------------------- |
| `manifest.ts`   | `GameManifest`, zod schema, `validateManifest`, `toCatalogEntry`                       |
| `turn-based.ts` | `TurnBasedGameServer`, `ApplyResult`                                                   |
| `realtime.ts`   | `RealtimeGameServer`, `TickResult`, `SnapshotOptions`                                  |
| `binary.ts`     | `BinaryCodec` / `BinaryWriter` / `BinaryReader` (implemented in `@atrium/netcode`, M6) |
| `client.ts`     | Component props, `LazyComponent`, `SoundMap`                                           |
| `context.ts`    | `GameContext`, `RealtimeContext`, `createGameContext`                                  |
| `rng.ts`        | `Rng`, `createRng`, `createContextRng`, `deriveSeed`                                   |
| `events.ts`     | `GameEvent`, `EventAudience`                                                           |
| `seats.ts`      | `Seat`, `SeatRoster`                                                                   |
| `timers.ts`     | `TimerSpec`, `TimerCommand`                                                            |
| `viewer.ts`     | `Viewer`                                                                               |
| `result.ts`     | `MatchResult`, `Standing`                                                              |
| `disconnect.ts` | `DisconnectPolicy`                                                                     |
| `record.ts`     | `MatchRecord`                                                                          |
| `errors.ts`     | `Result`, `ActionError`, `ValidationResult`                                            |
| `versioning.ts` | Semver, `VersionPin`, `checkVersionPin`                                                |
| `define.ts`     | `defineTurnBasedGame`, `defineRealtimeGame`, `AnyGameModule`                           |

Entry points: `.`, `./client`, `./realtime`.

`test/fixtures/` contains a complete tic-tac-toe (turn-based) and Tag Arena
(real-time) written against these contracts, importing nothing but this package.
They are the compile-and-behaviour proof that the contracts are implementable;
the shipping examples live in `games/_examples/`.

---

## Decisions

Rationale, alternatives and consequences: [`docs/adr/0008-game-sdk-contract-v1.md`](../../docs/adr/0008-game-sdk-contract-v1.md).
