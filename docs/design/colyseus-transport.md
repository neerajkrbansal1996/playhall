# Colyseus transport: framing, keepalive, egress

- **Serves:** [PER-15](/PER/issues/PER-15) — lobby/turn-based protocol + room runner
- **Owner:** Platform Engineer
- **Status:** Specified, not yet implemented (PER-15 is blocked on
  [PER-12](/PER/issues/PER-12) and [PER-14](/PER/issues/PER-14))
- **Sources:** [ADR-0001](../adr/0001-v1-stack.md) rev 4 §§4.1, 4.3, 4.5, 6, 7; ADR-0003 §5.2;
  [ADR-0005](../adr/0005-the-real-time-path.md) §1.1
- **Supersedes:** `transport-keepalive.md` (rev 1 of this spec), written before the board
  confirmed Colyseus. §9 lists what was withdrawn and why.

## 1. What ADR-0001 rev 4 changed here

The board rejected the amendment on 2026-09-30, so Colyseus is the server framework from M1.
Rev 1 of this spec assumed we owned the socket. We do not. The message _contracts_ in PER-15
survive unchanged; the framing and keepalive layer underneath them is replaced.

Rev 1 built a bidirectional application heartbeat because both halves of a quiet connection
were ours to keep alive. Colyseus already sends a native WebSocket ping on a timer and
terminates clients that stop answering, which covers the server→client half and the server's
own death detection. What it does **not** cover is the client's side of the same problem —
`colyseus.js` has no liveness probe and browser JavaScript cannot send a ping — so exactly one
application-level frame survives from rev 1, in one direction, for one reason.

Everything in this document is measured against the numbers in §2, which were read out of the
installed source rather than the documentation.

## 2. Verified Colyseus behaviour (`@colyseus/core` 0.18.8, `@colyseus/ws-transport` 0.18.4)

Read from package source, not from docs. Re-verify on every Colyseus major/minor bump; the
assertion in §4.2 is what makes a silent change loud.

| Behaviour                                                                                | Default          | Source                                                     |
| ---------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------- |
| Server sends a native WS ping to every client every `pingInterval` ms                    | `3_000`          | `WebSocketTransport.ts` `autoTerminateUnresponsiveClients` |
| Client terminated when `pingCount >= pingMaxRetries` (a pong resets the count to 0)      | `2`              | same                                                       |
| Ping loop is **disabled entirely** when `pingInterval` or `pingMaxRetries` is `0`        | —                | `WebSocketTransport.ts` constructor guard                  |
| Death is `socket.terminate()` — abrupt, **no close frame, no close code**                | —                | same                                                       |
| Max **inbound** frame size; a larger frame is killed by `ws`, not by us                  | `4 * 1024` bytes | `WebSocketTransport.ts` constructor                        |
| `perMessageDeflate`                                                                      | `false`          | same                                                       |
| `Room.maxMessagesPerSecond` — exceeding it **force-closes the client**, no typed error   | `Infinity`       | `Room.ts` `_onMessage`                                     |
| Non-consented close routes to `onDrop` when defined, else `onLeave`                      | —                | `Room.ts` `_onLeave`                                       |
| `Protocol.PING` exists server-side but **no released `colyseus.js` sends or handles it** | unused           | `Room.ts` / `colyseus.js` `Room.js`                        |

Three of these are load-bearing and easy to miss:

- **`terminate()` with no close code** means the client learns nothing about _why_ it was
  dropped. Rev 1's `4008 heartbeat_timeout` close code cannot be delivered by this path. The
  client therefore treats any unexplained close as retryable (§5.3), which is the behaviour we
  wanted anyway.
- **`maxPayload` is 4 KB inbound.** An oversized client message never reaches our zod schema —
  `ws` closes the connection with 1009 first. Our own size caps must be strictly tighter (§6).
- **`maxMessagesPerSecond` defaults to no limit, and its enforcement is a hard close.** It is a
  backstop, not our rate limiter; ours must fire first (§6).

## 3. Framing: our envelope is a payload, not a frame

One Colyseus message type carries every Playhall message:

```ts
// outbound, from colyseusEgress() only (§7)
client.sendBytes(PLAYHALL_MSG, codec.encode(envelope))
// inbound
this.onMessage(PLAYHALL_MSG, (client, bytes) =>
  runner.ingest(client.sessionId, codec.decode(bytes)),
)
```

`PLAYHALL_MSG` is a single numeric type code. The envelope keeps its own `t` (message type),
`v`, `seq` and `clientMsgId` — the fields PER-15 already specifies — and Colyseus sees an opaque
byte string.

**Why one type and not one Colyseus message type per protocol message.** The envelope has to
survive a transport that is not Colyseus: ADR-0005 §5 keeps a separate M6 real-time fleet on the
table, and ADR-0001 §4.1 keeps the `Transport`/`Codec` seam for WebTransport. If the message
type lives in Colyseus's framing, every message contract becomes Colyseus-shaped and the seam is
decorative. One opaque type keeps the protocol portable at the cost of one byte per frame.

`sendBytes` rather than `send`: `send` msgpack-encodes the payload, which would wrap our already
encoded bytes in a second encoding. `sendBytes` hands them through. This is also what lets the
`Codec` swap from JSON (M1) to binary (M4 spike, [PER-30](/PER/issues/PER-30)) without touching a
single message definition.

**`Codec` is narrowed, and the rule still binds.** It encodes the payload, not the frame. No
message type may be defined in a way that assumes JSON: no bare `any`, no unbounded string maps,
every message versioned (ADR-0001 §4.1, §7).

## 4. Keepalive: one job per owner

### 4.1 Six jobs, six owners

ADR-0003 §5.2 is the requirement: a managed edge proxy closes a connection idle for ~30 s (Fly)
or 60 s (default ALB), **idle means no bytes in that direction**, and a turn-based game with an
`unlimited` time control can produce no application bytes in either direction for minutes.

| Job                                       | Owner                                                    | Latency   |
| ----------------------------------------- | -------------------------------------------------------- | --------- |
| Keep the server→client half non-idle      | Colyseus native ping                                     | every 8 s |
| Keep the client→server half non-idle      | the browser's automatic pong to that ping (RFC 6455)     | every 8 s |
| Server detects a dead client              | Colyseus `pingMaxRetries` → `terminate()` → `onDrop`     | ≤ 32 s    |
| Client detects a dead or half-open server | `sys:ping` probe (§5) — **the only surviving app frame** | ≤ 25 s    |
| Presence `away`                           | room-level `lastInboundAt` (§5.4)                        | 25 s      |
| Seat hold after a drop                    | `allowReconnection` grace ([PER-13](/PER/issues/PER-13)) | unchanged |

**The assumption this rests on, stated so it can be tested:** a proxy idle timer counts TCP
bytes, so a WS control frame resets it. That is how Fly's proxy and ALB idle timeouts are
documented to work, and the test in §10.3 asserts it against a stub that closes on 30 s of
directional byte silence. If a real deployment is ever found to count only _data_ frames, the
fallback needs no protocol change: `sys:ping` is defined symmetrically and `SERVER_APP_BEAT_MS`
(§5.2) turns the server half on.

### 4.2 Transport config we set, and assert

```ts
new WebSocketTransport({
  pingInterval: 8_000, // was 3_000
  pingMaxRetries: 3, // was 2  → dead at 32 s
  maxPayload: 4 * 1024, // explicit, not inherited
})
```

- **8 s** keeps 22 s of margin against the 30 s proxy budget: two consecutive lost pings (24 s)
  still clear it, three (32 s) do not — and that case is a drop, which is reconnection's problem,
  not the proxy's. It also holds the per-client cost at the ~7 B/s that rev 1 budgeted and
  ADR-0001 §6's capacity model assumes.
- **32 s to death** preserves rev 1's `PEER_DEAD_MS = 35_000` intent. Colyseus's default 9 s is
  too eager for a mobile-first product: a 10 s tunnel hiccup that the socket would have survived
  becomes a forced reconnect and a fresh snapshot over mobile data.
- **Asserted at boot**, in the same place and the same spirit as the `maxmemory-policy` assertion
  in the Redis client factory ([PER-12](/PER/issues/PER-12)): the effective `pingInterval` and
  `pingMaxRetries` are read back after construction and a `pingInterval` of `0`, or one above
  20 s, fails startup. A disabled ping loop is a silently broken quiet match, and §2 shows it is
  one config value away.

### 4.3 What this costs

At the 2,000-rooms-per-instance target, 5,000 connections, all quiet (traffic suppresses the
probe, so quiet is the maximum):

```
native ping    5,000 ÷ 8 s                 = 625 /s each way
  wire         2 B WS frame + ~52 B TCP/IP ≈ 54 B down, 58 B up (masked)
  aggregate    625 × 54                    ≈ 34 KB/s down, 36 KB/s up
client probe   5,000 ÷ 15 s                = 333 /s each way
  wire         ~50 B payload + framing     ≈ 108 B
  aggregate    333 × 108                   ≈ 36 KB/s each way
per client     (54 + 108) ÷ ~11 s          ≈ 14 B/s each way
packets        625 + 625 + 333 + 333       ≈ 1,900 /s of pure keepalive
```

14 B/s against the 30 KB/s per-client real-time budget is 0.05%. The number that actually needs
watching is **1,900 packets/s of syscall and wakeup load on one instance** — bandwidth is free,
packet rate is not, and it is owed a measurement (§10.6).

**The Redis budget must not move.** ADR-0001 §6 counts presence at ~400 ops/s. Neither the native
pong (invisible to the room — `ws` handles it below Colyseus) nor a `sys:ping` writes to Redis: a
probe updates an **in-memory** `lastInboundAt`, and the presence key refresh stays coalesced to
at most one write per member per 10 s.

## 5. `sys:ping` / `sys:pong` — the client liveness probe

### 5.1 Frames

```
sys:ping  { v: 1, seq: number, sentAt: number }                       // either peer, client-only in M1
sys:pong  { v: 1, seq: number, echoSentAt: number, sentAt: number }   // reply
```

`seq` is monotone per connection per direction. `echoSentAt` is copied from the ping being
answered, so the prober gets an RTT sample without keeping a table. Both ride the §3 envelope
like every other message.

**Why our own frames and not `Protocol.PING`.** Colyseus's server answers `Protocol.PING`, but no
released `colyseus.js` sends or handles it (§2), so it is unreachable from a browser. And the
probe has to keep working over a non-Colyseus transport, which is the same argument as §3.

### 5.2 Constants

| Constant             | Value    | Why                                                                               |
| -------------------- | -------- | --------------------------------------------------------------------------------- |
| `PROBE_IDLE_MS`      | `15_000` | Client probes after this much inbound **application** silence. < `AWAY_MS`.       |
| `PROBE_JITTER_MS`    | `±1_000` | Stops 5,000 reconnecting clients probing on the same tick.                        |
| `PROBE_TIMEOUT_MS`   | `5_000`  | An unanswered probe past this is missed; retry immediately, do not re-wait.       |
| `PROBE_MAX_MISSED`   | `2`      | → client declares the socket dead at ≈ 25 s, just inside the server's 32 s.       |
| `AWAY_MS`            | `25_000` | Server-side presence `away` on inbound silence (§5.4). Seat is **not** released.  |
| `SERVER_APP_BEAT_MS` | `0` off  | The §4.1 fallback. Enables the server half of `sys:ping` with no contract change. |

The client gates on inbound _application_ silence because the native ping it receives is
invisible to browser JavaScript — there is no API to observe a pong, which is the whole reason
this frame exists.

Timers and jitter come from the injected clock/random seam the room runner already uses, never
from `Date.now()` / `Math.random()` at the call site, so §10 can run on fake timers.

### 5.3 What the client does when the probe fails

Two missed probes → treat the connection as dead, do not wait for a close event (a half-open
socket never delivers one), reconnect with the Colyseus reconnection token, receive a fresh
snapshot. **This is the same path as a version gap** — snapshot, then versioned deltas — so
there is no separate recovery mode to design or test. Any unexplained close is likewise
retryable, which is forced on us by `terminate()` carrying no close code (§2).

### 5.4 Presence `away` has to be re-derived

Rev 1 derived `away` from missed application beats. Under Colyseus the room cannot see pongs at
all, so presence must be derived from what the room _can_ see: `lastInboundAt`, advanced by any
inbound Colyseus message including a probe. A healthy quiet client is inbound every ~15 s, so
25 s marks `away` without false positives and the drop at 32 s arrives as `onDrop`.

`onDrop` (non-consented) → presence `away` + `allowReconnection` grace. `onLeave` (consented)
→ the explicit `room:leave` path. Distinguishing them is what keeps a deliberate leave from
holding a seat for the grace window.

## 6. Rate limits must fire before Colyseus's guillotines

Colyseus has two hard limits that end the connection without a typed error, and PER-15 promises a
typed error on every rejected client message. Ours must therefore be strictly tighter:

| Limit                      | Colyseus                             | Ours                                                                 |
| -------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| Inbound frame size         | `maxPayload` 4 KB → `ws` 1009 close  | Envelope capped at **2 KB** in zod; over → typed `message_too_large` |
| Inbound message rate       | `maxMessagesPerSecond` → force close | Set it to **30/s** as a flood backstop; token buckets per path below |
| `sys:ping` from the client | none                                 | Bucket capacity 3, refill 1 per 5 s (expected rate 0.07/s)           |
| `game:action`, `chat:send` | none                                 | PER-15's existing per-path buckets, all well under 30/s              |

Chat text length, action payload size and every other inbound bound must be set so that a
_valid_ message cannot approach 2 KB. A keepalive path with no limit is a free amplification
primitive: without the bucket, a client makes the server write one pong per inbound frame.

Over-budget returns the typed `error` envelope; sustained abuse closes the connection. The
ordering rule is the point — **a client must always learn why it was rejected**, and it only
learns that if our limit is the one that trips.

## 7. Egress: one funnel, and the hole in it

ADR-0001 §4.5 layers 1–3: no `this.state`, one funnel, `broadcast` banned by lint.
`colyseusEgress()` accepts a branded `RedactedView<T>` that only `getViewFor` /
`getSnapshotFor` output can produce, so raw match state does not typecheck.

**`sys:pong` is not a view, and neither is an ack, a typed error or a `timer:sync`.** A funnel
that only accepts `RedactedView<T>` cannot emit them, so the implementation will either widen
the brand until it means nothing or add a second, unguarded send path. Both defeat the funnel.
The fix is a narrow, explicitly enumerated second entry point in the _same_ module:

```ts
// the only two functions in the repo that may reach client.sendBytes / raw / broadcast
export function sendView<T>(client, view: RedactedView<T>): void
export function sendControl(client, frame: ControlFrame): void
```

`ControlFrame` is a closed discriminated union of `sys:pong`, `error`, the `clientMsgId` ack,
`presence:update`, `chat:message`, `timer:sync` and `game:over`'s result envelope. Each member's
type is built from primitives, ids and enums only — **no member may contain a game-state or
view-shaped field**, and §8 asserts that structurally rather than trusting review. Anything
that carries game state goes through `sendView` or it does not go.

`this.clock` may host the probe-reply and idle timers: they are liveness, they are worthless
after the room dies, and dying with the room is correct. It may **not** host a clock deadline, a
turn timeout, a room TTL or anything else correctness-bearing (ADR-0001 §4.1) — those are the
timer service's ([PER-14](/PER/issues/PER-14)).

## 8. The egress capture test — ADR-0001 §4.5 layer 6

New required deliverable. Layer 5 (the testkit) proves `getViewFor` is correct. It cannot prove
the server only ever sends what `getViewFor` returned. This test does, and it is the only layer
that catches a leak added through a path nobody thought to guard.

**Capture at the socket, not at the port.** Recording at our `Egress` interface would miss
exactly the leaks worth catching — a stray `this.broadcast`, an accidental `setState`, a
framework-emitted patch. The tap therefore sits on the client side of a real connection:
`@colyseus/testing` boots the real `PlayhallRoom`, and the recorder hooks the raw
`connection.events.onmessage` — below `room.onMessage` — so **every** frame is captured with its
Colyseus protocol code, including frames our code never produced.

Three assertions, in order of what they prove:

1. **Protocol-code allowlist.** Every captured frame's code is in
   `{ JOIN_ROOM, LEAVE_ROOM, ERROR, ROOM_DATA_BYTES(PLAYHALL_MSG) }`. A `ROOM_STATE` or
   `ROOM_STATE_PATCH` frame fails the test. This is what turns "we never set `this.state`" from
   a convention into a checked fact.
2. **View frames are reproducible.** Every `snapshot` / `delta` frame sent to seat A carries the
   `version` it was derived from. The test replays the match log to that version — deterministic,
   seeded, which is why this is possible at all — and asserts a snapshot deep-equals
   `getSnapshotFor(state@version, A)`, and that a delta applied to the previously reconstructed
   view deep-equals `getViewFor(state@version, A)`. A frame naming a version the log cannot reach
   fails.
3. **Control frames are exhaustively classified.** Every other frame's type is in §7's
   `ControlFrame` union, and the union's members are walked to assert no member declares a field
   whose type is the game's state or view. A new message type is unclassified until someone
   classifies it, and unclassified fails.

**The fixture must have hidden information.** Tic-tac-toe has none, so it passes this test
trivially and proves nothing about redaction. The run therefore uses a testkit fixture game in
which each seat holds a secret the other must not see (alongside tic-tac-toe, which is still
worth running for the protocol-code assertion). 200 random playouts, fuzzed viewers including
spectators, seeds recorded on failure.

## 9. Withdrawn from rev 1

| Rev 1                                                    | Now                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Bidirectional application heartbeat at 10 s              | Server half is Colyseus's native ping at 8 s; client half is the §5 probe at 15 s          |
| Per-direction idle gating of our own frames              | Only the client probe is gated, on inbound application silence                             |
| `HEARTBEAT_INTERVAL_MS`, `PEER_STALE_MS`, `PEER_DEAD_MS` | Transport config (§4.2) + `PROBE_*` / `AWAY_MS` (§5.2). Intent preserved, owners changed   |
| Close code `4008 heartbeat_timeout`                      | Impossible: Colyseus `terminate()` sends no close code. Any unexplained close is retryable |
| Native WS ping as a "redundant backstop"                 | Inverted — the native ping is now the primary mechanism and our frame is the supplement    |
| Free RTT sample on every connection from the beat        | Only on connections that actually probe. `timer:sync` remains the authoritative sync       |

**Still open, and narrower than it was:** the `clientMsgId` carve-out for `sys:ping` / `sys:pong`.
They mutate nothing, so a replay is already a no-op, and enrolling them would push permanently
useless entries through the idempotency cache. Under this revision that is ~333 entries/s rather
than ~500, and one message type rather than two directions. Flagged to the CTO for veto rather
than assumed.

## 10. Done when

1. Fake-timer unit test: a client that receives no application message emits `sys:ping` within
   16 s, and any inbound application message resets the gate.
2. Boot assertion test: `pingInterval: 0` and `pingInterval: 25_000` both fail startup, and the
   effective values are read back from the constructed transport, not from our own options object.
3. Integration test against a socket stub that closes on 30 s of directional byte silence: a
   5-minute quiet match survives. With `pingInterval: 0` **this test must fail** — verify that it
   does, because that is the assertion that encodes ADR-0003 §5.2.
4. A half-open socket (frames stop, no close ever arrives) → presence `away` at 25 s, `onDrop`
   by 32 s, seat held for the reconnect grace window, and the client independently reconnects at
   ≈ 25 s and receives a snapshot equal to live state.
5. A 3 KB inbound envelope returns the typed `message_too_large` error and the connection stays
   open — i.e. our 2 KB cap trips before `maxPayload`. A 5 KB frame is the transport's to kill.
6. Measured, reported as numbers: keepalive packets/s and Redis ops/s for a quiet 2,000-room
   instance. The Redis figure must sit inside ADR-0001 §6's ~400 ops/s presence line; the packet
   figure is a budget of ~1,900/s that has never been measured.
7. §8's capture test green over 200 fuzzed playouts of the hidden-information fixture, and
   red when a deliberate leak is introduced (a `this.broadcast` of raw state, and a `setState`
   call) — both negative cases committed as skipped fixtures so the test's teeth stay provable.
