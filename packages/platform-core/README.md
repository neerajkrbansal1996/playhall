# `@playhall/platform-core`

Identity, the game registry, rooms, seats, chat, presence, spectating,
reconnection, timers and the match log. **Nothing here knows about a specific
game.** Games are plugins loaded through the registry; this package never
imports one, not even dynamically (ADR-0002 §3).

Everything ambient is an injected port — `Clock`, `RandomSource`, `IdSource`,
`RoomStore` — so no rule in this package depends on the wall clock, the system
CSPRNG or Redis being present. That is what makes a 30-minute expiry a test
that runs in a millisecond.

## What is in here today (M1.3)

| Module                   | Owns                                                        |
| ------------------------ | ----------------------------------------------------------- |
| `registry/`              | The game catalogue, built from dynamic-import thunks        |
| `rooms/code`             | Room-code generation, unbiased draw, collision retry        |
| `rooms/types`            | The room model and seat/membership helpers                  |
| `rooms/join`             | The join matrix — one pure decision, shared by every caller |
| `rooms/lifecycle`        | The three expiry deadlines and Redis TTLs                   |
| `rooms/store`            | The store port + an in-memory implementation                |
| `rooms/realtime-binding` | Code → realtime room handle, and the listing projection     |
| `rooms/service`          | The order in which the above are applied                    |
| `rate-limit/`            | Token buckets, the policy set, the per-IP failed-join cap   |
| `routing/`               | Route builders and parser, sitemap, `robots.txt`            |
| `flags`                  | Platform and per-game feature flags                         |

Seats, teams, host controls and ready checks ([PER-13](/PER/issues/PER-13))
extend `rooms/types` rather than replace it. Guest identity is
[PER-11](/PER/issues/PER-11); this package takes an opaque `playerId`.

## Room codes

Six characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` — 31 symbols, with
`0 O 1 I L` excluded so a code read aloud or typed on a phone cannot land on
the wrong room. That is **887,503,681** codes.

The draw uses rejection sampling: a byte at or above `31 × 8 = 248` is
discarded rather than folded, because `byte % 31` would make the first eight
characters ~3% more likely and a biased code space is a smaller one. Allocation
retries against an **atomic** reservation (`SET … NX` in Redis) and reports the
collision count so the metric stays visible.

Codes are **global across games**: `/r/ABC234` resolves its own game, so an
invitation needs no explanation.

## The join matrix

`resolveJoin` is pure and is the only place this decision is made.

| Situation                                    | Outcome               |
| -------------------------------------------- | --------------------- |
| Code fails alphabet/length after normalising | `invalid_code`        |
| No room for that code                        | `room_not_found`      |
| Room closed, or past a lifecycle deadline    | `room_expired`        |
| Registry cannot resolve the room's game      | `game_unavailable`    |
| Player already holds a seat                  | `rejoined`, same seat |
| Player already spectating                    | `spectating`          |
| Free seat, room in lobby or finished         | `seated`              |
| Match in progress                            | `spectating`          |
| No free seat, game allows spectators         | `spectating`          |
| No free seat, game forbids spectators        | `room_full`           |

Input is trimmed, upper-cased and stripped of separators, so `abc-234`,
`ABC 234` and `ABC234` are the same code. An excluded character is _dropped_
rather than guessed at — there is no in-alphabet character to fold `O` or `I`
to, so a genuine misread leaves five characters, fails the length check and
lands on the friendly not-found path. Never a wrong room.

The first three rejection codes are _terminal_: this link will never work. Only
terminal rejections charge the per-IP failed-join cap.

## Code → realtime room handle

The realtime framework generates its own opaque room id (ADR-0001 §4.1 rev 4).
Joining therefore has one more step than the code lookup:

```
raw input → canonicalizeRoomCode → getByCode → join matrix admits →
realtimeJoinTarget → { realtimeRoomId, seatIndex } → join by id
```

`joinByCode` returns that target inline, so a caller never has to assemble the
mapping itself. Four properties hold, and each is tested:

- **The code is still ours.** Six characters, global across games, the only
  identifier a player sees or types. The framework handle is internal plumbing;
  a game module sees neither.
- **The mapping rides on the room record**, not on a second key, so it inherits
  the room's TTL and cannot outlive it. A mapping with its own lifecycle would
  be a join capability that leaks after the room is gone.
- **Rebinding to a different handle is refused**, not overwritten. Two framework
  rooms claiming one platform room is how a lobby silently splits in half. Same
  handle twice is an idempotent no-op, so a retry is safe.
- **The handle only reaches an admitted client.** `realtimeJoinTarget` answers
  `not_admitted` for anyone the join matrix has not seated or accepted as a
  spectator, because joining by id needs nothing else.

`listPublic` returns `PublicRoomSummary`, never a `Room`: no code, no handle, no
player ids. A lobby code is a capability, not an identifier (ADR-0001 §6), so
the framework's own matchmaker room-listing driver stays **off** — and our
flag-gated listing is typed so the same leak is unrepresentable rather than
merely absent today.

## Room lifecycle

| Condition                         | After  | Outcome |
| --------------------------------- | ------ | ------- |
| Host alone, no second player ever | 30 min | expire  |
| Nobody connected                  | 5 min  | close   |
| Match finished                    | 15 min | close   |

All three are pure functions of `(room, now)` rather than `setTimeout`. A timer
held in one process dies with that process, and a room that outlives its timer
is a leaked Redis key. `nextRoomDeadline` is the score for a Redis sorted set;
`roomKeyTtlMs` is the key TTL, and **every** room gets one — a room with no
armed deadline still gets a 31-minute floor.

When more than one deadline is armed, the earliest wins: a host who opened a
lobby and closed the tab is both "no opponent" and "empty", and five minutes is
the right answer.

Closing a room never deletes a match record. Those live in Postgres.

## Rate limits

| Path                  | Limit                 | Keyed by |
| --------------------- | --------------------- | -------- |
| Room create           | 5 per 10 min, burst 5 | guest    |
| Room join             | 20 per min, burst 20  | guest    |
| **Failed** code joins | 10 per 10 min         | IP       |

The failed-join cap is inverted accounting: only failures cost, and a success
refunds the whole budget, so several friends behind one NAT never add up to a
block. It is checked **before** the room lookup, so a blocked IP cannot use the
response to learn whether a code exists.

## Wiring it up

Composition happens at the app root, which is the only place allowed to know
that games exist:

```ts
import { GAME_REGISTRATIONS } from './games.generated'
import {
  createFeatureFlags,
  createGameRegistry,
  createRoomService,
  flagOverridesFromEnv,
  randomIdSource,
  webCryptoRandomSource,
} from '@playhall/platform-core'

const flags = createFeatureFlags(flagOverridesFromEnv(process.env))
const registry = await createGameRegistry({ registrations: GAME_REGISTRATIONS, flags })
const random = webCryptoRandomSource()

const rooms = createRoomService({
  store, // Redis-backed in production
  registry,
  flags,
  clock: { now: () => Date.now() }, // the app root is exempt from the lint rule
  random,
  ids: randomIdSource(random),
})
```

`games.generated.ts` is written by `pnpm registry:generate` and is the one file
in the repository allowed to reference a game package. A game opts in by
declaring its entry point in its own `package.json`:

```json
{ "playhall": { "gameEntry": "./src/index.ts" } }
```

`pnpm registry:check` fails CI when the generated file is stale.

## Tests

`pnpm --filter @playhall/platform-core test`. The suite covers code-generation
collision handling and alphabet safety, the full join matrix, every lifecycle
timer, the failed-join IP cap, and the code → realtime-handle mapping.
