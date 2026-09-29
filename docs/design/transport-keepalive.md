# Transport keepalive (bidirectional heartbeat)

- **Serves:** [PER-15](/PER/issues/PER-15) — lobby/turn-based protocol + room runner
- **Owner:** Platform Engineer
- **Status:** Specified, not yet implemented (PER-15 is blocked on
  [PER-12](/PER/issues/PER-12) and [PER-14](/PER/issues/PER-14))
- **Sources:** [ADR-0001](../adr/0001-v1-stack.md) §§4.1, 6, 7; ADR-0003 §5.2

## 1. Why this is a transport requirement and not a presence feature

ADR-0001 §6 specifies a 10 s presence heartbeat, and the Redis capacity model counts it as a
presence cost. ADR-0003 §5.2 establishes that the same beat is also what keeps the connection
open: a managed edge proxy terminates an idle connection at ~30 s (Fly) or 60 s (a default-config
AWS ALB), and **idle means no bytes in that direction**.

A turn-based game is the worst case for this. Two players thinking through a long move produce no
application data in *either* direction for minutes at a time — and an `unlimited` time control
(a shipped chess preset, `casual-no-clock`) removes even the clock as a source of traffic. A
client-only heartbeat leaves the server's half of the connection idle, and the proxy closes a
live match mid-game.

So the beat is **bidirectional and unconditional on application traffic**, it lives in the
transport adapter in `packages/netcode` below the message protocol, and it is a property of every
connection — lobby-only, in-match, and spectator alike. Presence consumes it; presence does not
own it.

## 2. Frames

Application-level frames, versioned like every other message (ADR-0001 §4.1: no message type may
assume JSON), carried by whatever `Codec` is installed:

```
sys:ping  { v: 1, seq: number, sentAt: number }            // either peer
sys:pong  { v: 1, seq: number, echoSentAt: number, sentAt: number }   // reply, both peers
```

`seq` is monotone per connection per direction. `sentAt` is the sender's clock in
milliseconds; `echoSentAt` is the value copied from the `sys:ping` being answered, so the pinger
gets an RTT sample without keeping a table.

**Why an application frame and not just WebSocket control frames.** `ws` can send a native ping
and the browser auto-replies with a pong, which would satisfy the proxy on its own. It is not
sufficient as the normative mechanism for two reasons: browser JavaScript cannot *send* a ping
(there is no API for it), so the client half would have nothing to send in a quiet lobby; and the
`Codec`/transport seam exists so WebTransport or WebRTC data channels can be swapped in later,
where control-frame semantics differ. The native ping is still sent, as a redundant backstop that
also drives `ws`'s own dead-socket detection — but correctness rests on the frames above.

## 3. Constants

| Constant                | Value      | Why this number                                                                                    |
| ----------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `HEARTBEAT_INTERVAL_MS` | `10_000`   | ADR-0001 §6 already specifies 10 s and the Redis capacity model is built on it. Keep one number.    |
| `HEARTBEAT_JITTER_MS`   | `±1_000`   | Spreads 5,000 connections so a restart does not produce a 500-frame spike on one tick.              |
| `PEER_STALE_MS`         | `25_000`   | Two missed beats. Presence moves to `away`; the seat is **not** released.                           |
| `PEER_DEAD_MS`          | `35_000`   | Backstop for a half-open socket (mobile radio drop) that never delivers a close.                    |

Worst-case idle gap in either direction is `10_000 + 1_000 = 11 s`, which leaves 19 s of margin
against the 30 s proxy budget — two consecutive lost beats (22 s) still clear it, three (33 s) do
not, and that case is handled by reconnection rather than by the proxy.

The primary death signal is the transport close, which arrives in milliseconds. `PEER_DEAD_MS`
only fires when no close ever arrives; a socket that stops answering is closed by the server with
`4008 heartbeat_timeout` and the member is handed to the reconnect grace path
([PER-13](/PER/issues/PER-13) owns the grace window and the seat hold). Closing eagerly is
deliberate: a zombie socket holding a seat is worse than an honest "reconnecting".

Jitter and interval are drawn from the injected clock/random seam used by the room runner, not
from `Date.now()` / `Math.random()` at the call site, so the tests in §7 can run on fake timers.

## 4. Sending rule (idle-gated, both directions)

Each direction keeps its own timer. **Any** frame sent in that direction resets it — an
application frame satisfies the proxy exactly as well as a ping does, so:

- Server: if nothing has been sent to this connection for `HEARTBEAT_INTERVAL_MS ± jitter`, send
  `sys:ping`. Answer any client `sys:ping` with `sys:pong` immediately.
- Client: same rule in reverse. Answer any server `sys:ping` with `sys:pong` immediately. The
  pong itself resets the client's send timer, so a quiet client sends ~1 frame per 10 s total,
  not two.

Idle-gating rather than unconditional sending halves the cost during active play and makes the
quiet case — the case that motivated the requirement — the only one that pays.

## 5. Cost at the 2,000-rooms-per-instance target

Assume 5,000 connections (2,000 rooms × 2 seats, plus spectators), all rooms quiet — the maximum
for this mechanism, since traffic suppresses it.

```
frames        5,000 conns ÷ 10 s                              = 500 /s per direction
bytes/frame   JSON sys:ping ≈ 58 B payload + WS header        ≈ 70 B on the wire
bandwidth     500 × 70 B                                      ≈ 35 KB/s aggregate per direction
per client    70 B ÷ 10 s                                     ≈ 7 B/s each way
```

7 B/s per client against a 30 KB/s per-client real-time budget is 0.02%. It is free.

**The Redis budget is the one that must not move.** ADR-0001 §6 counts presence at ~400 ops/s
(2,000 rooms × 2 seats / 10 s). The heartbeat must not multiply that: a `sys:pong` updates an
**in-memory** `lastSeenAt` only, and the presence key refresh is coalesced to at most one write
per member per `HEARTBEAT_INTERVAL_MS`. A heartbeat that wrote to Redis on every beat in both
directions would double the line for no information gain. Stated here because the naive
implementation is the one that does that.

## 6. Protocol interactions

**`clientMsgId` carve-out.** PER-15 requires every client message to carry a `clientMsgId` for
idempotency. `sys:ping` / `sys:pong` are exempt. They mutate no room state, so replaying one is
already a no-op, and enrolling them would put ~500 writes/s of dead entries through the
idempotency cache — the most-sent message on the wire would be the only one whose entries can
never be useful. `seq` provides the ordering these frames need. **This is the one
contract-visible consequence of this spec; flagged to the CTO for veto** rather than assumed
silently.

**Rate limit (`sys:ping` from the client).** Expected rate is 0.1/s. Token bucket per connection,
capacity 3, refill 1 per 5 s. Over budget returns the typed `error` frame with
`code: "rate_limited"`; sustained abuse closes with `4029`. A keepalive path with no limit is a
free amplification primitive — a client can otherwise make the server write 1 pong per inbound
byte.

**Clock samples.** `sys:pong.echoSentAt` gives each side an RTT sample and therefore an offset
estimate, on *every* connection, including a game with no running clock. This complements
`timer:sync` ([PER-14](/PER/issues/PER-14)); it does not replace it. `timer:sync` stays the
authoritative per-clock message and the drift budget (< 100 ms over 5 min) is still measured
against it. Samples with RTT > 2,000 ms are discarded rather than folded into the offset, and a
duplicate or out-of-order `seq` is ignored (highest `seq` wins) so a delayed pong cannot drag the
offset backwards.

**Reconnection.** `4008` is a retryable close. The client reconnects with its resume token and
receives a fresh snapshot, which is the same path as a version gap — no separate recovery mode.

## 7. Done when

1. Fake-timer unit test: a connection that sends no application data emits a `sys:ping` within
   11 s, in **both** directions, and each direction's timer is reset by an application frame.
2. Simulated quiet match, 5 minutes, asserting **no gap > 11 s** between consecutive outbound
   frames in either direction. This is the assertion that encodes ADR-0003 §5.2.
3. Integration test against a socket stub that closes on 30 s of directional idleness: a
   5-minute quiet match survives. Without the server half of the beat, this test must fail —
   verify that it does by disabling the server timer.
4. A stale peer (beats stopped, no close) is marked `away` at 25 s and closed `4008` at 35 s, and
   the seat is held for the reconnect grace window rather than released.
5. Measured Redis ops/s for a quiet 2,000-room instance is within the ADR-0001 §6 presence line
   (~400 ops/s), reported as a number.
