# ADR-0005: The real-time path

- **Status:** Mixed, per decision — see the table below. Nothing here authorises implementation.
- **Date:** 2026-09-30
- **Author:** CTO
- **Milestone:** M1 (design only). Implementation is **M6**, which is a board gate.
- **Issue:** [PER-21](/PER/issues/PER-21) (epic [PER-9](/PER/issues/PER-9))
- **Amended:** 2026-09-30 (rev 2) — **citations only; no decision in this ADR changed.** The board
  decided [ADR-0001](./0001-v1-stack.md) §4 the other way (approval
  [15587c20](/PER/approvals/15587c20-53fb-499e-9b53-4718df50a5df), rejected 2026-09-30) and
  Colyseus is now the server framework. Two places here described `@colyseus/schema` as
  _rejected by ADR-0001 §4.2_, which after that reversal is a wrong instruction to whoever reads
  it next: the objection now lives in ADR-0001 §4.3 and the prohibition in its §4.2 condition 1.
  Corrected in §3.2 and §4.4. **§1 and §2 need no change** — `RoomRunner` / `RoomDriver` is
  precisely the seam that makes the hosting engine replaceable, and Colyseus sits underneath it
  rather than in place of it.

| §   | Decision                                    | Status                                                  |
| --- | ------------------------------------------- | ------------------------------------------------------- |
| §1  | Room runner: one runner, two drivers        | **Accepted** — binds [PER-15](/PER/issues/PER-15) in M1 |
| §2  | Transport adapter with a `channel` argument | **Accepted** — binds [PER-15](/PER/issues/PER-15) in M1 |
| §3  | The real-time SDK contract                  | **Accepted as a specification**, frozen with M2         |
| §4  | Netcode kit design                          | **Proposed** — builds in M6                             |
| §5  | Game-server fleet and allocation            | **Proposed** — builds in M6                             |
| §6  | 3D stack (Three.js + R3F + Rapier)          | **Proposed, conditional on a measurement** — see §6.4   |
| §7  | Asset pipeline                              | **Proposed** — builds in M6                             |
| §8  | Input service                               | **Proposed** — builds in M6                             |
| §9  | Fleet hosting                               | **Board-gated** — comparison only, the board picks      |

## Context

Game #2 is Prop Hunt: real-time, 3D, 4–12 players, physics, hidden information. The roadmap
builds it in M7, on a netcode kit built in M6, and both are behind a board gate. This ADR
exists in **M1** for one reason: to prove that when the board opens M6 we will not have to
re-architect the platform to get there — and to name, now, the seams M1 must leave behind so
that stays true.

The claim this document has to support is narrow and testable:

> Prop Hunt can be added to this platform as **a folder under `games/`** that imports only
> `packages/game-sdk` and third-party libraries, with no change to `packages/platform-core`,
> no change to the lobby, seats, invites, chat, presence, spectating or results, and no change
> to the Game SDK contract beyond what §3 specifies today.

If any section of this ADR needs a platform change that a second, unlike real-time game would
not also need, that section is wrong and has to be redesigned, not granted an exception.

### The targets this designs against

| Target                                               | Where it binds                                    |
| ---------------------------------------------------- | ------------------------------------------------- |
| 30 Hz server tick                                    | §1.2 scheduler, §4 snapshot cadence               |
| Tick < 5 ms p99 for a 12-player room                 | §1.3 budget decomposition, §6.3 physics           |
| < 30 KB/s down per client                            | §4.4 codec arithmetic                             |
| Playable at 150 ms RTT / 30 ms jitter / 2% loss      | §4.2 prediction, §4.3 interpolation, §2 transport |
| 60 fps desktop, ≥ 30 fps mid-range Android           | §6.4 spike protocol — the one we must **measure** |
| Adding a game adds zero bytes to other bundles       | §7.1, and ADR-0001 §3                             |
| Server is authoritative for every position and clock | §4.5 clock sync, §4.6 lag compensation            |

### What is deliberately not here

- **The hosting provider.** §9 presents the comparison. The board decides, and it decides at
  the M6 gate, not now. Cost per 1,000 concurrent players is derived in
  [ADR-0003](./0003-hosting-and-cost-model.md) §4; §9 supplies the design inputs that model
  runs on and corrects one of them.
- **Any implementation.** No code is written against this ADR before the board opens
  [PER-32](/PER/issues/PER-32). The three `Accepted` rows bind work M1 was already doing
  ([PER-15](/PER/issues/PER-15)); they do not add real-time work to M1.
- **Prop Hunt's game design.** Map, round structure, prop set and win conditions are
  [PER-33](/PER/issues/PER-33) and need a brief the board has not written.

---

## 1. The room runner: one runner, two drivers

### 1.1 Decision

`RoomRunner` in `packages/platform-core` stays **kind-agnostic**. It owns everything the two
kinds of game share — seats, teams, host controls, ready checks, presence, chat, spectators,
invites, the match log, results, reconnection — and it owns none of the pacing. Pacing lives
behind one interface:

```ts
interface RoomDriver {
  readonly kind: 'turn-based' | 'realtime'
  attach(room: RoomHandle): void
  onClientMessage(seatId: SeatId, frame: Uint8Array): void
  detach(reason: DetachReason): void
}
```

- `TurnBasedDriver` is **event-driven**. It wakes on an arriving action or a due timer, calls
  `validateAction` → `applyAction` → `getViewFor`, appends to the match log, and goes back to
  sleep. An idle room costs no CPU. This is what M1 builds.
- `RealtimeDriver` is **clock-driven**. It is registered with a process-wide fixed-tick
  scheduler (§1.2), drains an input queue, steps the simulation, and emits a snapshot per seat.
  This is what M6 builds.

The lobby, the seat model, the invite flow, the chat and the result model see a `RoomHandle` and
never learn which driver is attached. **That is the whole of "two kinds of games, one
platform."** It is one interface, and M1 must leave the seam even though M1 only fills one side
of it.

### 1.2 The scheduler: one timer per process, not one per room

```ts
// packages/netcode — TickScheduler
let next = monotonicNow()
function pass() {
  next += TICK_MS // 33.333…, accumulated — never `now + TICK_MS`
  for (const room of rooms) room.tick()
  const lateBy = monotonicNow() - next
  if (lateBy > TICK_MS) {
    metrics.tickSkipped.inc()
    next = monotonicNow()
  } // drop, never spiral
  setTimeout(pass, Math.max(0, next - monotonicNow()))
}
```

Three properties are load-bearing and are the reason this is written down rather than left to
whoever types it:

1. **The deadline accumulates.** `next += TICK_MS` keeps the tick rate exact over hours.
   `setTimeout(pass, 33)` drifts, because `setTimeout` guarantees a floor, not a period, and the
   error compounds. A clock that drifts is a clock a client cannot sync to (§4.5).
2. **We drop, we never catch up.** A process that has fallen more than one tick behind must not
   run two ticks back-to-back — that is how a loaded node turns a 5 ms overrun into a death
   spiral. It emits `tick_skipped_total` and resumes on the next deadline. A dropped tick is a
   visible 33 ms hitch; a spiral is a dead room.
3. **The pass is the backpressure signal.** If one pass over all rooms exceeds the budget, the
   node is over-subscribed. It marks itself non-allocatable (§5.3) rather than degrading every
   room it hosts.

### 1.3 The 5 ms p99 tick budget, decomposed

A budget with no line items cannot be missed by a known amount, so here are the line items for
a 12-player Prop Hunt room with ~80 dynamic bodies:

```
drain + validate + dedupe input queue (12 clients)      0.2 ms
apply inputs to the authoritative sim                   0.3 ms
Rapier physics step, fixed dt = 1/30                    1.5 ms   ← dominant, and the least certain
game tick() via the SDK (round logic, scoring)          0.5 ms
write hitbox history ring                               0.1 ms
getSnapshotFor × 12 → delta → encode (§4.4)             1.2 ms
socket writes                                           0.4 ms
                                                       ───────
                                                        4.2 ms   against a 5.0 ms p99 budget
```

**The p99 risk on Node is the garbage collector, not the arithmetic.** A 20 ms major GC pause
blows the budget by 4× regardless of how fast the code is. Three rules follow, and they are
requirements on the M6 implementation rather than advice:

- **Zero allocation on the tick path.** Snapshot buffers are preallocated `ArrayBuffer`s reused
  per client; entity records are struct-of-arrays typed arrays, not objects; the hitbox history
  is a preallocated ring. No `JSON`, no `Array.map`, no closure creation inside `tick()`.
- **`gc_pause_ms` is an SLI**, reported per node, not something we discover from a bug report.
- **If measured p99 fails on a single-threaded process, the escape hatch is `worker_threads`** —
  N rooms per worker, so a GC pause is contained to a fraction of the node's rooms. It is not
  the design, because it costs a serialisation boundary; it is the named fallback so nobody
  invents a worse one under pressure.

### 1.4 Simulate at 30 Hz, snapshot at 30 Hz

The simulation step and the snapshot cadence are the same 30 Hz.

**Alternative: simulate at 60 Hz, snapshot at 30 Hz.** Better contact resolution for fast
bodies and 16.7 ms rewind granularity instead of 33.3 ms. It lost because it **doubles the
physics line**, taking the budget from 4.2 ms to 5.7 ms — over the p99 target before we have
measured anything. Prop Hunt's fast movers are the players themselves, and those are kinematic
capsules with swept collision (§6.3), not ballistic rigid bodies, so the sub-stepping buys less
here than it would in a racing or shooting game. **Revisit** if the M4 spike measures tunnelling
or if the physics line comes in under 0.8 ms, in which case 60 Hz becomes affordable.

**Alternative: simulate at 30 Hz, snapshot at 15 Hz** to halve egress. Rejected: it adds 33 ms
to the interpolation buffer (§4.3), which we cannot afford on top of a 150 ms RTT target. Bytes
are the cheaper lever (§4.4 leaves ~89% of the budget unused); latency is not.

### 1.5 How the two kinds coexist — and where they deliberately do not

They share a runner. They **do not share a process.**

|                  | Turn-based                               | Real-time                     |
| ---------------- | ---------------------------------------- | ----------------------------- |
| Runs in          | `apps/realtime` (the lobby/turn service) | a game-server fleet node (§5) |
| Pacing           | event-driven                             | 30 Hz fixed tick              |
| Restart survival | **yes** — replay the match log           | **no** — see below            |
| Scaling unit     | rooms per instance (target 2,000)        | rooms per core (~16, §9.1)    |

A real-time room must not be co-tenanted with the lobby, and this is a **blast radius**
decision, not a performance preference: one room's physics overrun would add jitter to every
turn-based room on the box and to the lobby itself. The lobby's job during a real-time match is
to stay alive while the fleet node does the dangerous work.

**Real-time matches are not restart-survivable in M6 v1. Stated plainly rather than discovered
later.** If a fleet node dies mid-match, the match is over: the `RealtimeDriver` detaches, the
room is recorded with result `aborted`, and the players are returned to their **intact lobby** —
because seats, party, chat and history live in the lobby service, not on the fleet node. Players
see a correct end state, never a frozen world presented as live.

The alternative — snapshotting world state to Redis every N ticks — was considered and deferred.
It costs CPU and bandwidth on every tick of every room to buy recovery from an event we have not
yet measured the frequency of, and it still loses the in-flight inputs, so the recovered match
resumes at a state no player saw. Turn-based keeps its restart-survival guarantee because its
state is a small ordered action log and replay is exact (ADR-0001 §6.3); a 30 Hz physics world
is neither small nor cheaply replayable. **Revisit** when we have a measured node-failure rate
from M6 staging, or if a match length exceeds ~10 minutes, at which point an aborted match costs
a player enough to justify the tax.

---

## 2. Transport: WebSockets now, behind an adapter that already knows about unreliability

### 2.1 Decision

`packages/netcode` defines the transport seam, and it defines it with a delivery channel from
day one:

```ts
type Channel = 'reliable' | 'unreliable'

interface Transport {
  send(peer: PeerId, bytes: Uint8Array, channel: Channel): void
  readonly capabilities: { unreliable: boolean; maxDatagramSize: number }
  onMessage(cb: (peer: PeerId, bytes: Uint8Array) => void): void
  onOpen(cb: (peer: PeerId) => void): void
  onClose(cb: (peer: PeerId, reason: CloseReason) => void): void
}
```

v1 ships `WebSocketTransport` (`ws`), which maps **both** channels onto the same reliable
ordered stream and reports `capabilities.unreliable = false`. The argument is still there and
still used: snapshots and inputs go on `unreliable`, lobby/chat/results/acks go on `reliable`.

**The point of the argument existing before it does anything** is that it forces the protocol to
be written for the unreliable case — per-client acked baselines rather than a delta chain (§4.4),
redundant input frames rather than retransmission (§4.1) — while there is no pressure to cut the
corner. A protocol that silently depends on ordered reliable delivery cannot be moved to
datagrams later without a rewrite, and by then it is M6 and the rewrite is expensive.

### 2.2 Why WebSockets first, and the number that says we will replace them

WebSockets work everywhere that matters: every browser in our support matrix including iOS
Safari, through corporate proxies and mobile-carrier NAT, with no signalling server, no ICE, no
TURN relay and no certificate dance. For a share-first product where a stranger taps a WhatsApp
link on a phone, "it connects" beats "it connects with lower latency when it connects."

It also has a cost we should name in numbers rather than discover:

```
TCP head-of-line blocking at 2% loss, 150 ms RTT:
  a lost segment stalls the stream for one retransmission ≈ 150 ms = 4.5 snapshot intervals
  at 30 snapshots/s and 2% loss, a stall lands roughly every 50 ticks ≈ every 1.7 s
```

A 150 ms stall every 1.7 seconds is not "playable at 2% loss." **We should expect to replace the
WebSocket transport, and the seam is mandatory for that reason — not as good hygiene.** The
honest position is that WS is the transport that ships first because it always connects, not the
transport that is right.

### 2.3 Alternatives

- **WebTransport (HTTP/3 datagrams) now.** The right long-term answer: real unreliable
  unordered datagrams, one connection, no TURN. It lost on **browser reach** — Safari support
  has been the laggard and a mobile-first Indian audience reaches us through iMessage and Safari
  as well as Chrome. Adopting it now would mean shipping two transports in M6 instead of one.
  It is the **first** adapter we add, and §2.1 is what makes that additive.
- **WebRTC data channels (unordered, `maxRetransmits: 0`).** Works in Safari today and gives
  genuine unreliable delivery. It lost on operational cost: a signalling path, ICE, and a
  **TURN relay for the players behind symmetric NAT — which is an egress bill on the exact
  traffic §9 is trying to make cheap**, plus a connection setup that is slower and fails in ways
  that are hard to explain to a player. Kept as the fallback if WebTransport's browser coverage
  is still short at M6.
- **Raw UDP.** Not available to a browser. Listed because someone always asks.

**Decision rule, written now so it cannot be argued after the fact:** we move off WebSockets
when a loss test at 2% loss / 150 ms RTT / 30 ms jitter measures an effective end-to-end delay
more than **one snapshot interval (33 ms)** worse than the same test on an unreliable transport.
Owner: QA, in the M4 spike ([PER-30](/PER/issues/PER-30)).

---

## 3. The real-time SDK contract

### 3.1 Decision

The real-time half of the SDK is specified **now** and frozen at the same time as the turn-based
half. This is the single most important thing in this ADR for the one rule, and the reason is
procedural: after M2, any SDK contract change needs an ADR **and** board approval. If the
real-time contract is left blank until M6, then M6 opens with a board-gated SDK change on its
critical path, and every awkward thing Prop Hunt needs arrives as a request to change the
platform. Specifying it in M1 costs a document; specifying it in M6 costs a gate.

```ts
interface RealtimeGameModule<World, Input, Snapshot, Result> {
  manifest: GameManifest & { kind: 'realtime' }

  // wire
  inputSchema: ZodType<Input> // validated at the edge before it reaches the sim
  inputCodec: FieldSchema<Input> // binary layout, §4.4
  snapshotCodec: FieldSchema<Snapshot> // binary layout + quantisation + delta rules, §4.4

  // simulation — pure, deterministic, ctx.now and ctx.rng only
  createWorld(ctx: GameCtx, settings: Settings, seats: Seat[]): World
  onInput(ctx: GameCtx, w: World, seatId: SeatId, input: Input, seq: number): void
  tick(ctx: GameCtx, w: World, dt: number): void

  // the redaction boundary — the ONLY path to a client
  getSnapshotFor(ctx: GameCtx, w: World, seatId: SeatId): { viewKey: string; snapshot: Snapshot }

  // platform-owned lag compensation needs to see hitboxes; the game does not implement rewind
  getHitboxes?(w: World): HitboxSet

  // shared with the turn-based contract
  onPlayerJoin(ctx, w, seatId): void
  onPlayerLeave(ctx, w, seatId, reason): void
  onDisconnect(ctx, w, seatId): DisconnectPolicy
  getResult(ctx, w): Result
}
```

Plus **one** client-side export, which is the part that makes prediction possible:

```ts
// The same pure function the server calls inside tick() for that seat.
// Exported once, used by apps/realtime and by the browser. Determinism is the contract.
stepLocalPlayer(state: LocalState, input: Input, dt: number): LocalState
```

### 3.2 Three properties of this contract, and why each one is there

**`getSnapshotFor` returns a `viewKey`, and the default is the seat id.** Prop Hunt has hidden
information: a hunter must not learn which prop is a player. So the platform cannot encode one
buffer and broadcast it — every byte leaving the server passes through `getSnapshotFor`, per
**redaction completeness**. That costs 12 encodes per tick instead of 1. The `viewKey` recovers
most of it: when two seats return the same key the platform encodes once and sends the same
bytes to both, so "all four hunters see the same world" collapses 12 encodes to ~2.

The direction of the default is the whole design. **Sharing is opt-in; hiding is the default.**
This is the exact inversion of the `@filter()`-decorator model ADR-0001 §4.3 objects to: there,
a new field is visible unless someone remembers to hide it. Here, a new field is
per-seat unless the game deliberately declares two seats identical. A game that forgets to set a
`viewKey` pays CPU. A game that forgets a `@filter()` leaks the location of a hidden player.

> **Rev 2.** Since ADR-0001 rev 4 adopted Colyseus, that `@filter()` model is now **in the tree**
> rather than rejected, which makes this subsection binding rather than comparative. ADR-0001 §4.2
> condition 1 forbids Colyseus state sync from being the redaction path; `getSnapshotFor` plus
> `viewKey` is the path it must use instead. Reaching for `this.state` because the framework is
> already there requires a new ADR.

**The game declares a field schema; the platform writes the bytes.** `snapshotCodec` is a
declarative description of entity archetypes and their fields — type, range, quantisation — not
an encoder. The game never touches a `DataView`. **Generality test:** Tag Arena and Prop Hunt
are unlike games and both are served by the same generic encoder with different schemas, so the
encoder is platform. A hand-written Prop-Hunt encoder would be game-local and would have to be
written again for game #3.

**`getHitboxes` exists so that rewind is platform-owned.** Lag compensation is not a Prop Hunt
feature; it is what every real-time game with a hit test needs, and getting it wrong is a
fairness bug. The game describes where its bodies are; `packages/netcode` owns the history ring,
the rewind and the 200 ms cap (§4.6). If each game implemented its own rewind, each game would
have its own subtly different unfairness.

### 3.3 What this contract does **not** let a game do

- **No I/O, no `Date.now()`, no `Math.random()`** — mechanically enforced by ADR-0002 §4 and the
  `no-game-node-builtins` rule. Time is `ctx.now`; randomness is `ctx.rng`, seeded server-side
  with the seed stored on the match.
- **No transport access.** A game never sees a socket, a peer, or a byte count. It cannot choose
  a channel, force a flush, or address a client.
- **No physics engine supplied by the platform.** A real-time game brings its own physics as a
  third-party dependency (§6.3). This is deliberate: physics is a _game_ concern, and a platform
  that supplied one would be picking the second game's engine today.

> **The boundary check that matters, run against the M6 design.** A real-time game needs: a
> fixed tick, a binary wire, prediction, interpolation, lag compensation, an asset loader, an
> input service, a fleet node. **All eight are platform**, all eight pass the generality test,
> and none of them requires a game to import anything but `packages/game-sdk`. Prop Hunt's own
> needs — a map, props, a disguise mechanic, a round timer — are all expressible inside
> `createWorld`/`tick`/`getSnapshotFor`. I have not found a Prop Hunt requirement that needs a
> platform-core change. If one is found in M7, it goes through an SDK ADR, and the default
> answer is "put it in the game."

### 3.4 Alternatives

- **Leave the real-time contract unspecified until M6.** Rejected above: it converts a design
  document into a board gate on M6's critical path, and it guarantees the contract gets shaped
  by whatever Prop Hunt happened to need first — which is how a platform acquires a special case.
- **One unified contract covering both kinds of game.** Rejected on the **plugin boundary**:
  Chess would carry `tick`, `inputCodec` and `getHitboxes` as dead members, and a turn-based
  author would have to understand netcode to implement a board game. Two contracts, one runner,
  one lobby.
- **Let the game own its own wire format** (hand it a socket, let it encode). Rejected on
  **redaction completeness** and **server-authoritative**: the moment a game writes bytes, the
  platform can no longer guarantee that everything leaving the server went through
  `getSnapshotFor`, and the one audit point becomes N.

---

## 4. The netcode kit

All of this lives in `packages/netcode`. None of it is game-specific.

### 4.1 Input sequencing and acks

Each client sends one **input frame** per tick:

```
seq        u16   wrapping sequence number
buttons    u8    bitmask, game-declared action map (§8)
move       i8×2  normalised movement axes
look       i16×2 accumulated look delta since the last frame, radians × 10⁴
                                                             ────────
                                                              9 bytes
```

Three rules:

- **The frame carries the last 3 unacked frames as well** (~27 B + header ≈ 30 B). At 2% loss,
  the probability that all three copies of a given input are lost is 8 × 10⁻⁶ — roughly once
  every 4 hours of play per client. Redundancy is far cheaper than retransmission at 30 Hz, and
  it is what lets §2.1's `unreliable` channel become real without a protocol change.
- **The look delta is accumulated, never sampled.** Summing the mouse/touch movement between
  ticks and sending the sum means a 1000 Hz mouse loses no motion. Sampling the instantaneous
  pointer position drops 96% of the samples and feels like input lag on exactly the hardware
  that should feel best.
- **The server acks the highest contiguous `seq` it has processed, in every snapshot header.**
  That one `u16` is what drives reconciliation (§4.2), the input RTT metric, and the client's
  decision to stop storing an input.

Server side: inputs land in a per-seat bounded queue, are `zod`-validated at the edge, and are
**clamped, not trusted** — a `move` vector is normalised server-side, a `look` delta beyond a
plausible per-tick maximum is clamped, and at most one frame per seat is consumed per tick. A
client that sends 300 frames/s gets its queue drained at 30/s and the excess dropped. **A
modified client can send anything; it cannot make the server do more work per tick than an
honest one, and it cannot move faster.**

### 4.2 Client-side prediction and server reconciliation

Only the **local player** is predicted. Everything else is interpolated (§4.3).

1. The client applies the input locally through `stepLocalPlayer` (§3.1) the instant it is
   produced, and pushes `{ seq, input, resultingState }` onto a ring.
2. Every snapshot carries `ackSeq`. The client drops everything at or below it.
3. The client compares its stored state at `ackSeq` against the server's authoritative state for
   that seat. Within tolerance — **5 cm of position, 2° of orientation** — it does nothing.
4. Outside tolerance, it snaps to the server state and **replays** every unacked input through
   the same `stepLocalPlayer`. The correction is applied to the simulation state, while the
   _rendered_ position is smoothed toward it over ~100 ms so the player sees a slide, not a
   teleport.

Two consequences worth stating:

- **The tolerance is not a fudge factor; it is what stops a correction storm.** With a zero
  tolerance, floating-point divergence between the browser's and Node's evaluation of the same
  function produces a correction every tick, and every correction costs a replay.
- **`reconciliation_corrections_total` and the correction-magnitude histogram are the real
  quality signal for the whole netcode kit.** Frequent large corrections mean prediction is
  wrong — which usually means the server is doing something to the local player that the client
  cannot predict. This metric is how we find that, rather than by reading a bug report that says
  "it feels rubbery."

**Alternative: predict remote entities too** (dead reckoning / extrapolation). Rejected for M6
v1: Prop Hunt's props stop and change direction abruptly, and a misprediction that has to be
visibly retracted looks worse than 67 ms of interpolation delay. It is additive later — per
entity archetype, declared in `snapshotCodec` — if measurement says otherwise.

**Alternative: no prediction at all** (render only acked server state). Rejected: at a 150 ms
RTT target the player would see their own movement 150 ms after pressing the key. That is not a
tuning problem, it is unplayable.

### 4.3 The interpolation buffer

Remote entities are rendered at `serverTime − D`, where

```
D = 2 × snapshotInterval + jitterEstimate(p95)   clamped to [67 ms, 150 ms]
```

- **Two intervals (67 ms) is the floor** because it absorbs exactly one dropped snapshot. At 2%
  loss, two consecutive losses occur with probability 0.04% — about once every 2,500 ticks, or
  83 seconds — and that case falls back to extrapolation for at most 100 ms before the entity is
  frozen rather than allowed to drift somewhere it never was.
- **The jitter term adapts**, tracking the p95 inter-arrival gap over a sliding 2 s window, so a
  player on a good connection gets 67 ms of delay and a player on a bad one gets up to 150 ms
  instead of constant stutter.
- **150 ms is the ceiling** because past that the delay is worse than the artefact it is hiding.

**Alternative: a fixed 100 ms buffer.** Simpler, and wrong at both ends — it penalises the good
connection and still stutters on the bad one. **Alternative: snapshot extrapolation instead of
interpolation** (render the present, predicted). Rejected: it makes every entity's position a
guess, which breaks the property that what you shoot at is where the server says it was.

### 4.4 Delta-compressed binary snapshots, and the arithmetic

```
header    tick u16 | baselineTick u16 | ackSeq u16 | flags u8          =  7 B
per entity  idDelta varint | fieldMask u8
            pos 3 × u16 quantised (128 m map ÷ 65536 ≈ 2 mm)
            yaw u8 | pitch u8 | stateFlags u8                          = 10 B full, 4–6 B typical

12 players, all visible, all fields changed:  7 + 12 × 10             = 127 B  per tick per client
                                            × 30 Hz                    = 3.8 KB/s
plus ~80 props, mostly static, ~2 changing:   + ~20 B                  = 4.4 KB/s
plus events (shots, sounds, prop changes), budgeted                    ≈ 5.0 KB/s
plus TCP/IP + WebSocket framing, ~44 B × 30                            ≈ 6.3 KB/s

                                                design point ≈ 6.3 KB/s against a 30 KB/s ceiling
```

**We land at ~21% of the budget, and JSON would not fit at all** — ADR-0001 §7 puts the same
payload at 1.5–3.0 KB per tick, 1.5–3× over the 1,000 B/tick ceiling before a single delta
baseline or event is added. This is the arithmetic that makes the `Codec` seam non-optional.

**Baselines are per client and acked, not "the previous tick."** The server keeps a ring of the
last 32 snapshots it sent each client; each snapshot deltas against the newest one that client
has acknowledged. A lost snapshot therefore costs a _slightly larger next snapshot_, not a
desync — which is the property that lets §2's `unreliable` channel become real later without
touching this format.

**Codec choice: a hand-rolled `DataView` encoder generated from the game's `snapshotCodec`
schema**, writing into a preallocated reused `ArrayBuffer`.

| Alternative            | Why it lost                                                                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| msgpackr               | Self-describing — field names on the wire — and allocates per encode. Loses on both bytes (~3–5× ours) and on the §1.3 zero-allocation rule.                                                                                                                                                                               |
| Protobuf               | Field tags cost bytes, no delta support, and a runtime we would carry into the client bundle for a format we would still have to delta by hand.                                                                                                                                                                            |
| FlatBuffers            | Zero-copy reads are genuinely good, but there is no delta story and the generated surface is large. Wins only if we needed random access into a big payload; we read every field every tick.                                                                                                                               |
| `@colyseus/schema`     | Loses here for the reason ADR-0001 §4.3 gives: it solves binary + delta well, but puts a framework type hierarchy inside game state, so a game would depend on the platform's netcode library. **Still excluded after ADR-0001 rev 4** — adopting Colyseus makes this package _present_, not permitted (§4.2 condition 1). |
| Bit-packing everything | Squeezing the 10 B entity to ~6 B is possible. Rejected on **budget before optimisation**: we are at 21% of the ceiling. Spending CPU in the tick loop to save bytes we are not short of is the wrong trade.                                                                                                               |

### 4.5 Clock sync

NTP-style, on the `reliable` channel, out of band from the tick:

```
client → server  ping{ t0 = client monotonic }
server → client  pong{ t0, t1 = server tick clock }
client           rtt = t2 − t0 ;  offset = t1 − (t0 + rtt/2)
```

Keep the 20 lowest-RTT samples in a sliding window and use the **median offset** — the low-RTT
samples are the ones least polluted by queueing delay. Re-sync every 2 s for the first 10 s of a
match, then every 10 s. The estimate is slewed, never stepped, so interpolation does not jump.

**The rule that matters: a client-supplied timestamp is never authoritative for anything.** The
server stamps the tick; the synced clock exists only so the client knows _which_ server time to
render at (§4.3) and so the server can estimate one-way delay for rewind (§4.6). A client that
lies about its clock can make its own rendering worse and can, at most, request a rewind — which
is capped and clamped in §4.6.

**Alternative: send only a tick number and let the client infer.** Rejected: it gives no
estimate of one-way delay, which lag compensation requires. **Alternative: `Date.now()` on both
ends.** Rejected: unsynchronised wall clocks, and the client's is attacker-controlled.

### 4.6 Lag compensation, with the rewind capped at 200 ms

`packages/netcode` keeps a **hitbox history ring** per room: 12 ticks (400 ms) of every seat's
hitbox set, written each tick from `getHitboxes` (§3.1).

```
memory  12 ticks × 12 seats × ~32 B  ≈ 4.6 KB per room     (negligible; the ring is 2× the cap
                                                            so the cap is policy, not capacity)
```

When the server processes a hit test for seat S:

```
rewind = clamp(rtt(S)/2 + interpolationDelay(S), 0, 200 ms)
```

— computed from the **server's** RTT measurement and the client's _reported_ interpolation
delay, both clamped. The world's hitboxes are reconstructed at `now − rewind`, interpolating
between the two stored ticks that bracket it (which is why 33 ms granularity is sufficient
without simulating at 60 Hz, §1.4). The hit test runs against that reconstruction; everything
else — scoring, state changes — happens in the present.

**The consequence, stated rather than buried: lag compensation means you will sometimes be hit
after you reach cover.** That is the trade every server-authoritative shooter makes, and the cap
is what bounds it. At 200 ms the worst case is ~6 ticks of "I was already behind the wall."

| Alternative                             | Why it lost                                                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No lag compensation (favour the target) | A player at our stated 150 ms RTT target would have to lead by ~11 cm per m/s of target speed to hit anything. That is our _design_ audience, not an edge case. |
| Uncapped rewind (favour the shooter)    | A 600 ms player kills you most of a second after you broke line of sight, and it is trivially exploitable by inflating reported delay. The cap is the control.  |
| Cap at 100 ms                           | Under-serves the 150 ms RTT target — a player exactly at target would still be partially uncompensated. 200 ms covers 150 ms RTT + a 67 ms buffer with margin.  |

### 4.7 Metrics — each one against a target

Every metric goes through the `packages/shared` telemetry facade (ADR-0001 §8): no call site
names a vendor, the hot path is sampled, and a snapshot payload is never logged.

| Target                          | Metric                                                                   | Gate                                    |
| ------------------------------- | ------------------------------------------------------------------------ | --------------------------------------- |
| tick < 5 ms p99, 12-player room | `tick_duration_ms` (histogram, per node and per room)                    | node refuses allocation over p99        |
| 30 Hz                           | `tick_jitter_ms` (scheduled − actual), `tick_skipped_total`              | alert on any sustained skip             |
| < 30 KB/s down per client       | `snapshot_bytes` (histogram), `downstream_bytes_per_second` (per client) | M6 acceptance criterion                 |
| playable at 150 ms / 30 ms / 2% | `input_rtt_ms`, `snapshot_gap_total`, `interpolation_buffer_ms`          | loss-test acceptance                    |
| prediction is actually correct  | `reconciliation_corrections_total` + correction magnitude histogram      | the quality signal of §4.2              |
| rewind stays bounded            | `rewind_ms` histogram, `rewind_capped_total`                             | fairness audit                          |
| ≥ 30 fps mid-range Android      | `client_fps` p5 / p50, reported by the client sampler                    | held in production, not just in a spike |
| p99 is not GC                   | `gc_pause_ms`, `heap_used`, `rooms_hosted` per node                      | §1.3 escape-hatch trigger               |

The last one is the point of the table: **`client_fps` p5 from real devices is the only way the
≥ 30 fps target survives contact with the actual phone population.** A lab spike (§6.4) decides
the engine; this metric is how we find out we were wrong.

---

## 5. The game-server fleet and allocation

### 5.1 Shape

```
          ┌──────────────┐   allocate(region, gameId, version)   ┌───────────┐
  host ──►│ lobby / web  │ ────────────────────────────────────► │ allocator │
          │ apps/realtime│ ◄──────── { nodeUrl, roomId, ticket } └─────┬─────┘
          └──────┬───────┘                                            │ health, load
                 │ seats, chat, invites, results (stay here)          │ every 5 s
   players ──────┴──────────────── direct WS ──────────────► ┌────────┴────────┐
                                    + ticket                 │ fleet node (30 Hz)│
                                                             └──────────────────┘
```

The fleet is **separate from the lobby, autoscaled independently, and allocated per room**.
Clients connect **directly** to the allocated node — the lobby is not in the media path, because
proxying 12 × 6.3 KB/s per room through the lobby would double the egress bill (§9) and put the
lobby's health on the real-time path.

### 5.2 Allocation and the ticket

`allocate()` returns a **short-lived signed ticket**: audience-scoped to `{roomId, nodeId}`,
~60 s TTL, single use, signed with the same key as guest tokens ([PER-11](/PER/issues/PER-11)).
The node verifies the signature locally and **never calls back to the lobby to authenticate a
join**. That keeps the lobby off the hot path and means a lobby hiccup cannot stop players
joining a match that is already allocated.

Region: **nearest to the host, Mumbai first.** The host opens the lobby and shares a link; their
friends are usually near them, and allocating before everyone has arrived is what keeps
"landing page to playable lobby in ≤ 2 taps and < 10 s" true.

**Alternative: allocate to the region nearest the median player.** Fairer when a room is
geographically spread, and rejected for M6 v1 because it cannot be computed until every player
has arrived — which means either allocating late (a visible wait after "start") or migrating a
running room. **Revisit** when `input_rtt_ms` shows an intra-room spread above 100 ms on a
meaningful share of rooms.

### 5.3 Capacity, scale-out, and draining

- Each node reports `rooms_hosted`, `tick_duration_ms` p99 and CPU to the allocator every 5 s.
- Allocation is **least-loaded under a threshold**, not round-robin: the p99 tick budget is a
  per-node property, so an even spread of rooms across uneven nodes is the wrong objective.
- A node whose tick pass exceeds budget (§1.2) **marks itself non-allocatable** without dropping
  anything it is already hosting.
- Scale-out when fleet p95 utilisation > 70%. The 30% headroom is not conservatism — it is the
  time it takes a new node to boot and load a game module, during which the fleet must absorb
  new rooms.
- **Scale-in is by drain, never by termination.** A node is marked non-allocatable and removed
  only when its room count reaches zero.

**Draining is also how version pinning works** (ADR-0001 §7). A node keeps the game-module
version it booted with for the life of its rooms. A deploy adds nodes on the new version and
drains the old ones; a match in progress finishes on the version it started on. **A deploy must
never restart a node with a live room** — with no restart survival for real-time (§1.5), a
rolling restart would kill every match in flight. This is the single operational rule that has
to survive from this ADR into whatever M6 actually builds.

### 5.4 Alternatives

- **Run real-time rooms inside the lobby process.** Cheapest, and rejected on **blast radius**
  (§1.5): a physics overrun would jitter every turn-based room and the lobby, and a fleet node
  crash would take the lobby with it.
- **Agones on Kubernetes.** The industry-standard answer and genuinely correct at scale — fleet
  CRDs, allocation, draining, all solved. It lost on operational surface and cost for a fleet of
  ~8 cores: we would be running a Kubernetes control plane to schedule a handful of processes,
  against a **$0 standing budget**. **Revisit at > 50 nodes**, where hand-rolled allocation stops
  being cheaper than adopting the thing that already works.
- **Serverless / edge functions.** Rejected structurally: no long-lived stateful process, no
  fixed-tick loop. Cloudflare Durable Objects are the one serverless shape that _can_ hold state
  and a loop, and they are costed in §9.2 rather than dismissed.
- **Peer-to-peer / host-authoritative** (one player's browser simulates). Rejected outright on
  **server-authoritative**: it hands the outcome, the positions and the clock to a client. It is
  also the cheapest option by an order of magnitude, which is exactly why it needs to be written
  down as rejected rather than left to be rediscovered as a cost saving.

---

## 6. The 3D stack

### 6.1 Decision (conditional — see §6.4)

**Three.js, driven by react-three-fiber, with Rapier (Rust → WASM) for physics.** This is a
_proposal with a measurement attached_: the engine choice is settled by measured p5 fps on a
mid-range Android in the M4 spike ([PER-30](/PER/issues/PER-30)), not by this paragraph.

### 6.2 Why this is the candidate to beat

- **The client contract is React.** `<GameView>`, `<GameScene>`, `<HUD>`, `<SettingsForm>`,
  `<ResultPanel>`, `<HowToPlay>` are React components and `apps/web` is Next.js App Router.
  react-three-fiber makes `<GameScene>` an ordinary React subtree; an imperative engine needs a
  hand-written bridge for lifecycle, resize, context loss and HUD overlay. That bridge is
  platform code written to serve one engine — precisely the kind of thing that later gets in the
  way of game #3.
- **Bundle.** three ~150 KB gz core + R3F ~15 KB, against Babylon's ~350 KB gz core
  [unverified — to be measured in the spike against the real import graph]. The 250 KB
  turn-based budget does **not** apply to a real-time game (§7.2), but bytes are still the first
  thing between a tapped link and a playable match.
- **Licence.** Three.js, R3F and Rapier are MIT/Apache-2.0. No GPL enters the repo (ADR-0001 §3).
- **Ecosystem for the pipeline we need.** glTF + meshopt + KTX2/Basis loaders are first-class
  and maintained (§7).

### 6.3 Rapier, and the determinism trap we are designing around

Rapier is the physics candidate because **the same WASM binary runs in Node and in the browser**
— one implementation, server-authoritative, with the client able to run the identical code for
prediction. `@dimforge/rapier3d-compat` inlines its WASM, so a game can depend on it without
touching `fs` and without violating ADR-0002's `no-game-node-builtins` rule. That is not a
detail: a physics engine that needed `fs` to load would arrive in M6 as a request to weaken a
boundary rule.

**We do not rely on bit-exact client/server physics, and the design is arranged so we never need
to.** Cross-platform floating-point determinism for a full rigid-body solver is achievable in
principle and fragile in practice. So:

- **The local player is a kinematic capsule with swept collision** — position integration and a
  shape cast, no solver, no contact islands. That _is_ reproducible across engines, and it is
  the only thing `stepLocalPlayer` (§3.1) has to reproduce.
- **Rigid-body dynamics — props tumbling, objects being pushed — run on the server only** and
  reach the client as interpolated snapshot data (§4.3). Nobody predicts them, so nobody has to
  reproduce them.

This is the **determinism** lens applied as a design constraint rather than a hope: we shrank
the surface that has to be deterministic until it is a surface that actually is.

**Physics alternatives.** _cannon-es_: pure JS, no WASM step, but materially slower and we would
be running it inside a 5 ms server budget. _ammo.js_ (Bullet): mature and battle-tested, but a
large emscripten build and an awkward manual-memory API. _Jolt (WASM)_: excellent engine with
newer JS bindings — the closest competitor, and the one to re-check at M6 if Rapier disappoints.
Rapier wins today on the combination of small WASM (~1 MB), first-class TypeScript bindings, an
opt-in deterministic mode, and the same binary on both sides.

### 6.4 The spike that actually decides this — protocol written before the result

Stated now so the result cannot be argued with afterwards. Owner: Frontend Engineer with QA, in
the M4 real-time spike ([PER-30](/PER/issues/PER-30)).

**Devices.** Two mid-range Androids, defined by class rather than by name: a Snapdragon
6-series / Dimensity 700-class SoC with a 1080p display, Chrome stable, on battery, not plugged
in and not freshly rebooted. Plus one desktop reference for the 60 fps target.

**Scene**, identical in all three engines, built once and ported:

- 12 animated humanoid capsules with skeletal animation
- ~80 static props, ~80k triangles total
- one shadow-casting directional light, 2048² shadow map
- KTX2/Basis textures, `devicePixelRatio` clamped to 1.5 on mobile
- 60 s of scripted camera motion through the scene, identical path per engine

**Measure:** median fps, **5th-percentile fps**, time-to-first-frame, peak JS heap, and total
transferred bytes.

**Pass bar:**

|                   | Bar                                 |
| ----------------- | ----------------------------------- |
| Mid-range Android | **p5 ≥ 30 fps** and median ≥ 40 fps |
| Desktop reference | median ≥ 60 fps                     |

**p5, not median, is the bar.** A median of 30 fps with dips to 12 is not a game that anyone
enjoys; the target says "≥ 30 fps on a mid-range Android" and the honest reading of that is the
bad frames, not the average one.

**Decision rule.** Adopt the highest-scoring engine that also clears the React-integration and
licence constraints in §6.2. If Three.js fails the bar and Babylon.js or PlayCanvas clears it,
**we take the other engine and pay the bridge cost.** The bridge is a week; shipping a game that
stutters on the phones our players actually own is not recoverable.

> **Measurement owed.** Every fps number in this section is a bar, not a result. Nothing in §6
> is settled until [PER-30](/PER/issues/PER-30) reports measured p5 fps per engine on named
> devices. Until then §6.1 rests on the structural arguments in §6.2–6.3, and those are
> arguments about integration and licensing, **not** about performance.

### 6.5 Engine alternatives, and the reason each lost

- **Babylon.js.** Apache-2.0, batteries included — its own physics plugins, GUI, inspector,
  strong WebGL2/WebGPU story, and arguably better out-of-the-box mobile defaults. It loses on
  two constraints we actually have, not on preference: it is **imperative**, so satisfying the
  `<GameScene>` React contract needs a bespoke bridge that becomes platform code; and its core
  bundle is materially larger. **If it wins §6.4 on measured p5 fps, we take it and write the
  bridge** — that is what the decision rule is for.
- **PlayCanvas.** MIT engine with an excellent mobile performance record and the smallest
  runtime of the three. It loses on **where the game lives**: PlayCanvas's real advantage is its
  hosted editor, which is a paid vendor (board-gated at $0) and which puts scene authoring
  _outside the repository_ — at which point a game stops being "a folder" and the plugin
  boundary is no longer checkable in a diff. Used engine-only it gives up the thing that makes
  it better. Still measured in §6.4, because if it wins by a wide margin that changes the
  calculus.
- **Unity or Godot exported to WASM.** Rejected on **zero friction**: 5–20 MB of runtime before
  the first frame, against "landing page to playable lobby in < 10 s" on mobile data. No amount
  of engine quality survives that download.
- **Hand-rolled WebGL2.** Rejected on effort and on the asset pipeline we would have to write
  from scratch (§7). We would spend M6 rebuilding glTF loading.

---

## 7. The asset pipeline

### 7.1 Decision

**Per-game, content-hashed, immutable CDN bundles**, addressed by game _and module version_:

```
/<cdn>/games/<gameId>/<moduleVersion>/<content-hash>.<ext>
Cache-Control: public, max-age=31536000, immutable
```

Versioning the path is **version pinning applied to assets** (ADR-0001 §7): a match in progress
keeps loading the assets of the module version it started on, so a deploy cannot change the
geometry under a live match. It also makes caching trivially correct — nothing is ever
revalidated, because nothing at a given URL ever changes.

**Geometry: glTF 2.0 with meshopt (`EXT_meshopt_compression`), not Draco.** Draco compresses
roughly 10–20% smaller. Meshopt decodes an order of magnitude faster and ships a ~20 KB decoder
against Draco's ~200 KB WASM decoder [both figures unverified — confirm in the spike]. **On a
mobile-first target, decode time on a weak CPU and decoder size on a metered connection both
beat file size**, and the difference we are giving up is 10–20% of a budget we are inside.
**Revisit** if total download exceeds the §7.2 budget while CPU sits idle — that is the
condition under which the trade inverts.

**Textures: KTX2 + Basis Universal**, transcoded on-device to the GPU's native format (ASTC on
mobile, BC7 on desktop). This is not a download-size decision, it is a **VRAM** decision:

```
a 2048² texture, decoded in VRAM
  PNG/JPG → RGBA8                 16 MB
  KTX2 → ASTC 4×4                  4 MB      4× less, on the device with the least to spare
```

On a mid-range Android with on the order of 1 GB of usable graphics memory, a dozen PNG textures
is the difference between running and having the tab killed. Download size improves too; that is
the secondary benefit.

### 7.2 Budgets, and the loader

|                                                           | Budget       |
| --------------------------------------------------------- | ------------ |
| Real-time game **code** bundle, gzipped, excluding assets | **≤ 600 KB** |
| Real-time game **assets**, first playable                 | **≤ 3 MB**   |
| Real-time game assets, total                              | **≤ 8 MB**   |
| Bytes added to any _other_ game's bundle, or to the lobby | **0**        |

The 250 KB turn-based bundle budget does not apply to a 3D game and pretending otherwise would
just mean missing it. The **zero** row is the one that is non-negotiable and it is the existing
rule (ADR-0001 §3, ADR-0002 §3): games load through the generated registry via dynamic
`import()`, so a player who only ever plays Chess downloads none of this.

**The loader is platform, not game.** `AssetLoader` in `packages/netcode` (or `packages/ui` —
settled at implementation) reports `{ loaded, total, phase }`, the platform renders the progress
UI, and `<GameScene>` cannot mount before phase `ready`. **Generality test:** every 3D game needs
a progress-reporting loader, so a game writing its own loading screen is a platform gap, not a
game feature. Assets are declared in the game manifest; the loader fetches them.

**Licences.** Models, textures and sounds must be **CC0 or commercially licensed**, logged in
`ASSET_LICENSES.md`, checked at review. Code licences go in `THIRD_PARTY_LICENSES.md`. An asset
with an unclear provenance does not enter the repository.

### 7.3 Alternatives

- **Bundle assets into the JS bundle.** Rejected: destroys caching granularity, and a code
  change would invalidate megabytes of unchanged geometry.
- **Serve assets from the app origin.** Rejected on cost and on §5.1: static egress is ~1.7× the
  WebSocket egress ([ADR-0003](./0003-hosting-and-cost-model.md) I12), and paying instance-tier
  egress rates for it — while adding load to a box holding a 5 ms tick budget — is the wrong
  place to put it. A CDN in front is the difference between a rounding error and a line item.
- **Stream everything progressively, no budget.** Rejected: a budget that is never stated is
  never met, and "playable before fully loaded" is what the ≤ 3 MB first-playable row buys.

---

## 8. The input service

### 8.1 Decision

Input is **platform** (`packages/netcode`), and a game declares an **action map** — named
actions with default bindings — never raw key codes.

```ts
// declared by the game, consumed by the platform input service
const actions = {
  move: { kind: 'axis2' },
  look: { kind: 'delta2' },
  use: { kind: 'button', keyboard: 'KeyE', touch: { label: 'Use', slot: 1 } },
  taunt: { kind: 'button', keyboard: 'KeyT', touch: { label: 'Taunt', slot: 2 } },
}
```

The service produces exactly one `InputFrame` (§4.1) per tick from whichever device is present.

**Keyboard and mouse.** Pointer Lock for look, WASD for move, mouse buttons and keys for
actions. Pointer-lock loss (Esc, tab switch, an OS dialog) **auto-pauses and shows a
click-to-resume overlay** — the player must never be shooting at nothing because the browser
took the pointer back. Look delta is accumulated between ticks (§4.1).

**Touch — the one we actually have to get right,** since most players arrive on a phone:

- **Left half: a dynamic-origin virtual joystick.** The thumb-down point becomes the centre.
  A fixed on-screen stick is wrong on a device population with a 4.5"–7" range of screens and
  two hand sizes; a dynamic origin works on all of them.
- **Right half: drag-to-look**, with sensitivity as a **platform** setting (per player, across
  games), not a per-game one.
- **Action buttons** placed from the action map's `slot`, laid out by the platform inside the
  safe-area insets so a notch or a gesture bar never eats a button.
- No interaction may depend on hover, and no cue may rely on colour alone.

**Gamepad is deliberately deferred to post-M6.** The action map is what makes it additive: a
Gamepad API source feeds the same named actions and **no game changes**. That is the generality
test passing in advance.

### 8.2 Alternatives

- **Let each game read raw DOM events.** Rejected on **plugin boundary** — a game reaching into
  `document` and `PointerEvent` is a game reaching into the platform's surface — and on
  duplication: every game would re-implement a virtual joystick, and each would get the safe-area
  insets subtly wrong.
- **Raw key codes in the game instead of an action map.** Rejected: it makes rebinding, gamepad
  support and non-QWERTY layouts a per-game change. A platform that cannot add gamepad support
  without editing every game has the boundary in the wrong place.
- **A separate mobile control scheme per game.** Rejected on the same generality test: the
  joystick and the look-drag are identical for Prop Hunt and Tag Arena.

---

## 9. Fleet hosting — **board-gated, comparison only**

### 9.1 What this design contributes to the cost model

The cost comparison itself belongs to [ADR-0003](./0003-hosting-and-cost-model.md) §4, which
prices five providers per 1,000 concurrent players and is already in front of the board. This
ADR's job is to supply the two design inputs that model runs on — and to correct one of them.

| ADR-0003 input                    | Value used there                          | What this design says                                           |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| **I10** real-time down per client | 30 KB/s ceiling, **10 KB/s** design point | **≈ 6.3 KB/s** including framing (§4.4) — a further ~37% below  |
| **I11** real-time CPU per room    | 2 ms mean per tick, ~16 rooms/core        | **4.2 ms budgeted, p99 < 5 ms** (§1.3) — consistent, still owed |

**The egress consequence is large enough that the board should see it.** Re-running ADR-0003 §4
at the §4.4 design point of 6.3 KB/s instead of its 10 KB/s assumption:

```
egress per 1,000 concurrent players, sustained 24/7 (730 h)
  at 30 KB/s ceiling     78.8 TB/month
  at 10 KB/s (ADR-0003)  26.3 TB/month
  at  6.3 KB/s (§4.4)    16.6 TB/month     ← what this design actually produces
```

Which moves the monthly egress bill per 1,000 concurrent players to roughly:

| Provider | @ 30 KB/s | @ 10 KB/s | **@ 6.3 KB/s (this design)** |
| -------- | --------: | --------: | ---------------------------: |
| Hetzner  |     $0–76 |     $0–23 |                    **$0–14** |
| Fly.io   |    $1,577 |      $526 |                     **$332** |
| Railway  |    $3,942 |    $1,314 |                     **$830** |
| AWS      |    $6,329 |    $2,276 |                   **$1,436** |
| Render   |   $11,822 |    $3,938 |                   **$2,483** |

All prices are ADR-0003's published list prices as of 2026-09-30, re-scaled. They are **quotes,
not measurements**, and the byte figure they are scaled by is a **budget, not a measurement**.

> **Measurement owed.** 6.3 KB/s is derived arithmetic (§4.4), not counted bytes. The M4 spike
> ([PER-30](/PER/issues/PER-30)) owes measured bytes/s per client and measured CPU ms/tick for a
> 12-player room. When it lands, this table and ADR-0003 §4 are **replaced, not amended**.

**The finding that survives all three columns:** the spread between providers is dominated by
egress and is roughly two orders of magnitude, and **shrinking the snapshot is a second,
independent lever worth ~$1,245/month on Fly and ~$4,900/month on AWS** — work we are doing
anyway, for correctness reasons, under §4.4.

### 9.2 The candidate ADR-0003 flagged for this ADR: Cloudflare Durable Objects

ADR-0003 §7c asked for Durable Objects to be evaluated here against the actual fleet design.

**What fits.** A Durable Object is a single-threaded stateful actor with a WebSocket endpoint —
structurally, that is a room. Cloudflare charges **no egress**, which on a workload where egress
is 80–98% of every other provider's bill is the headline fact. Rough compute arithmetic at
published rates [unverified]:

```
30 ticks/s × 2 ms CPU = 60 ms CPU/s per room × 2,628,000 s = 157.7 M CPU-ms per room-month
at $0.02 per million CPU-ms                                 ≈ $3.15 per room-month
84 rooms per 1,000 concurrent players                       ≈ $265/month  + $0 egress
                                                            ≈ $0.27 per concurrent player-month
```

That would place it second only to Hetzner, and ahead of Fly.io by ~7×.

**What does not fit, and these are the questions the board's decision has to survive:**

1. **Placement.** DO location hints are coarse (`apac`), and **Mumbai is not selectable.** §5.2's
   "nearest to the host, Mumbai first" is a latency decision for an India-first audience; a
   Singapore placement adds roughly 40–60 ms RTT [unverified] to every player in a room.
2. **A sustained 30 Hz loop is not the workload the platform is shaped for.** WebSocket
   hibernation, per-invocation CPU limits and the billing model all assume request-shaped,
   bursty work. Nothing says a tick loop is forbidden; nothing says its p99 scheduling is
   guaranteed either, and a 5 ms p99 budget lives or dies on scheduling.
3. **No unreliable transport.** §2's migration path to WebTransport datagrams does not exist
   here, so we would be committing to the transport whose head-of-line blocking §2.2 quantifies
   as a 150 ms stall every 1.7 s at 2% loss.
4. **Rapier WASM inside a Worker** must fit the script-size and startup limits, unverified.

**Recommendation on Durable Objects: keep as a live candidate, disqualify on measurement, not on
description.** Items 1 and 2 are the ones that would disqualify it, and both are measurable in a
half-day spike at $0 on the free tier. That spike belongs in M4 ([PER-30](/PER/issues/PER-30)).

### 9.3 What the board is being asked — and what it is _not_ being asked

**Not asked for now: any M6 spend.** The standing infrastructure budget is $0, M6 is itself a
board gate ([PER-32](/PER/issues/PER-32)), and no provider has been signed up for. No card, no
trial, no account on a paid tier has been opened in the course of writing this.

**Asked for, at the M6 gate and not before:**

1. **The fleet provider**, from ADR-0003 §4 as re-scaled in §9.1, with Durable Objects added as
   a sixth candidate (§9.2). The provisional direction remains ADR-0003's: **Hetzner dedicated
   vCPU**, at ~$0.11–0.13 per concurrent player-month against Fly's $1.85 and AWS's $6.62.
2. **A monthly infrastructure budget for M6** that covers a fleet with dedicated vCPU. The
   number depends on (1) and on the M4 measurements, and it is not $0.
3. **Acknowledgement of the constraints the fleet imposes on the choice**, because they
   disqualify providers independently of price: dedicated (not burstable) vCPU; direct
   client-to-node connections without a per-room proxy; graceful drain rather than rolling
   restart (§5.3); a region in or near Mumbai; and a path to UDP-based transport (§2.3) that
   does not require changing provider again.

The comparison is posted to the board on [PER-2](/PER/issues/PER-2). **I am not picking the
provider here, and neither is ADR-0003.**

---

## Evidence

| Claim                                                            | Basis                                                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Snapshot fits the 30 KB/s budget at ~21%                         | Derived, §4.4. **Budget, not measurement**                                                                  |
| JSON does not fit                                                | Derived, ADR-0001 §7 — 1.5–3× over a 1,000 B/tick ceiling                                                   |
| Tick budget decomposes to 4.2 ms against 5 ms p99                | Derived, §1.3. **Every line is a budget**; the physics line is the least certain                            |
| Input triple-redundancy loses a frame ~1 per 4 h at 2% loss      | Derived, §4.1 — 0.02³                                                                                       |
| Two-interval buffer absorbs one loss; 2 consecutive ≈ 1 per 83 s | Derived, §4.3 — 0.02² at 30 Hz                                                                              |
| TCP HOL costs ~150 ms every ~1.7 s at 2% loss / 150 ms RTT       | Derived, §2.2                                                                                               |
| KTX2/ASTC is 4× less VRAM than RGBA8                             | Format arithmetic, §7.1                                                                                     |
| Hitbox ring costs ~4.6 KB per room                               | Derived, §4.6                                                                                               |
| Provider prices                                                  | [ADR-0003](./0003-hosting-and-cost-model.md) published list prices, 2026-09-30, **quotes not measurements** |
| Durable Objects ≈ $0.27 per concurrent player-month              | Derived from published rates, **[unverified]**, §9.2                                                        |
| Engine bundle sizes, decoder sizes, Babylon/PlayCanvas fps       | **[unverified]** — §6.4 owes all of it                                                                      |

> **Measurement owed — the full list, so none of it is quietly forgotten.** Owner: the M4
> real-time spike, [PER-30](/PER/issues/PER-30), before M6 opens.
>
> 1. **p5 fps on two named mid-range Androids** for Three.js, Babylon.js and PlayCanvas, per the
>    §6.4 protocol. Until this lands, §6 is a structural argument about React integration and
>    licensing, not a performance claim.
> 2. **Measured bytes/s down per client** for a 12-player room. Replaces §4.4 and §9.1.
> 3. **Measured tick ms p50/p99** for a 12-player room, including the physics line and
>    `gc_pause_ms`. Replaces §1.3 and decides the `worker_threads` escape hatch.
> 4. **A loss test** at 150 ms RTT / 30 ms jitter / 2% loss, giving the §2.3 decision rule its
>    number.
> 5. **A half-day Durable Objects spike** on the free tier: measured tick jitter under a
>    sustained 30 Hz loop, and actual placement latency from India (§9.2).
>
> Nothing in this ADR is binding on an implementer where it conflicts with one of these
> measurements. That is the point of listing them.

---

## Consequences

**Easier**

- M6 starts with a specification instead of a design phase, and without an SDK contract change
  on its critical path (§3.1).
- Prop Hunt is a folder. The eight platform capabilities it needs (§3.3) all pass the generality
  test, so game #3 gets them for free.
- The turn-based and real-time paths share one lobby, one seat model, one invite flow and one
  result model, and neither knows about the other (§1.1).
- The fleet can be sized, priced and scaled independently of the lobby (§5).

**Harder, and worth saying plainly**

- **Real-time matches do not survive a server restart** (§1.5). Turn-based does. This is an
  asymmetry in the product's reliability story and it will need to be explained to players as an
  "match ended" state, not hidden.
- **Per-seat encoding costs 12× a broadcast**, and we are paying it deliberately for redaction
  completeness (§3.2). The `viewKey` recovers most of it, and a game that forgets to set one
  silently pays CPU.
- **Deploys become drains** (§5.3). A rolling restart is no longer a safe operation on the fleet,
  and that is an operational rule that has to be enforced by the deploy pipeline rather than
  remembered.
- **We should expect to replace the WebSocket transport** (§2.2). The seam makes that additive,
  but it is still a second transport to build and test.
- **The engine decision is not actually made** (§6.4), and if Three.js loses the spike we owe a
  React bridge for the winner.

**Committed to**

- One `RoomRunner`, two `RoomDriver`s — M1 leaves the seam ([PER-15](/PER/issues/PER-15)).
- A `Transport` interface carrying a `channel` argument before any unreliable transport exists.
- Redaction by default, sharing by opt-in `viewKey`.
- Lag-compensation rewind capped at 200 ms, platform-owned.
- Zero allocation on the tick path.
- Version pinning extended to assets via the CDN path (§7.1).
- Asset licences CC0 or commercial, logged in `ASSET_LICENSES.md`.

**Cost to reverse**

| Decision                                    | Cost                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| Transport adapter / `channel` argument (§2) | **Cheap** — that is what the seam is for                                   |
| `RoomDriver` split (§1.1)                   | **Cheap now** (the code is unwritten), expensive after M2                  |
| Real-time SDK contract (§3)                 | **Cheap now**, **board-gated** after M2 — which is why it is specified now |
| Snapshot wire format (§4.4)                 | Moderate — versioned, so a swap is a migration, not a rewrite              |
| 3D engine (§6)                              | Moderate _before_ Prop Hunt's scene is authored; **expensive** after       |
| Fleet provider (§9)                         | Moderate — this is why §5 keeps allocation behind an `Allocator` interface |
| No restart survival for real-time (§1.5)    | Moderate — adding periodic world snapshots later is additive               |

---

## Revisit triggers

- **The M4 spike measures p5 fps below 30 on a mid-range Android for Three.js** → §6, adopt the
  engine that clears the bar and pay the bridge cost. This is the trigger §6.4 exists for.
- **Measured tick p99 exceeds 5 ms for a 12-player room** → §1.3, take the `worker_threads`
  escape hatch; if it is the physics line, revisit §1.4 and §6.3.
- **Measured `gc_pause_ms` p99 exceeds 5 ms** → §1.3; the arithmetic was never the risk.
- **Measured downstream exceeds 15 KB/s per client** → §4.4 (bit-pack, or add interest
  management) and §9.1 (re-price).
- **A loss test shows WebSocket effective delay more than one snapshot interval worse than an
  unreliable transport** at 2% / 150 ms / 30 ms → §2.3, bring the WebTransport adapter forward.
- **`reconciliation_corrections_total` shows frequent large corrections** → §4.2; prediction is
  wrong, and the usual cause is the server doing something to the local player the client cannot
  predict.
- **Intra-room `input_rtt_ms` spread above 100 ms on a meaningful share of rooms** → §5.2,
  revisit host-nearest allocation.
- **Fleet exceeds ~50 nodes** → §5.4, adopting Agones becomes cheaper than maintaining our own
  allocator.
- **A measured node-failure rate makes aborted matches a visible product problem**, or typical
  match length exceeds ~10 minutes → §1.5, add periodic world snapshots.
- **A Prop Hunt requirement is found that needs a `platform-core` change** → this ADR's central
  claim (§3.3) is wrong. It goes through an SDK ADR and board approval, and the default answer
  is still "put it in the game."
- **The infrastructure budget rises above $0** → §9 reopens with real options; below that, M6 is
  not startable regardless of design.
