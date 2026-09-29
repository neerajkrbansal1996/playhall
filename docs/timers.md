# The timer service

Implementation: `packages/platform-core/src/timers`. Consumers: the room runner
(`apps/realtime`), `apps/web`, and — only through the SDK — every game.

Games never implement a clock. A game declares its timers in its manifest, asks
for them with `setTimer` / `clearTimer` / `pauseTimer` / `resumeTimer` from
`@playhall/game-sdk`, and renders the `TimerView[]` it is handed.

## The one idea

A timer is never decremented. It stores a **budget** and the **instant that
budget was exact**, and remaining time is recomputed from those two numbers:

```
remaining(now) = remainingMs - chargeable(now - startedAtMs)
```

A tick loop that subtracts an elapsed slice each pass accumulates the error of
every tick, and `setTimeout` is late under load. Recomputing from an anchor has
no accumulating term — the only error is the error of the current reading. Same
idea on the client: it holds absolute deadlines in server time and subtracts,
rather than running a countdown.

`clock.ts` is the only module under `packages` allowed to read ambient time, and
`eslint.config.mjs` enforces that. The system clock is anchored once
(`wallOrigin + (performance.now() - monoOrigin)`) so an NTP step on the host
cannot take a second off a player's clock.

## What is supported

| Kind           | What it is                                              |
| -------------- | ------------------------------------------------------- |
| `chess-clock`  | Per-player budget, runs only while that seat is to move |
| `turn`         | One deadline for the current mover                      |
| `phase`        | A deadline for a whole phase (simultaneous play)        |
| `match`        | A ceiling on the whole match                            |
| `grace`        | Reconnection grace, usually driven by `disconnectPolicy` |
| `custom`       | Anything else the manifest declares                     |

Per-player clocks support a Fischer `incrementMs` (credited when the turn
completes, never to a seat that flagged mid-move), a `delayMs` in either
`simple` (US delay — the first `delayMs` of a turn does not touch the budget) or
`bronstein` mode (counts down immediately, refunds `min(delayMs, used)` at the
end of the turn), and an optional `maxMs` ceiling.

## Wire protocol

`timer:sync` — server → client. Sent on join, on reconnect, whenever a timer
changes, and on a keepalive so a long-idle client re-measures its offset.

```jsonc
{
  "type": "timer:sync",
  "matchId": "…",
  "serverTime": 1700000000000, // server clock when the frame was built
  "replyTo": "clientMsgId",    // echo when answering a request, else null
  "timers": [
    {
      "timerId": "clock:white",
      "seatId": "white",
      "kind": "chess-clock",
      "state": "running",      // running | paused | expired
      "remainingMs": 293000,   // as of serverTime; render this when paused
      "deadlineAtMs": 1700000293000, // absolute, in *server* time; null unless running
      "delayRemainingMs": 0,
      "version": 7
    }
  ]
}
```

`timer:sync-request` — client → server, `{ type, clientMsgId }`. The server
answers with a `timer:sync` carrying `replyTo: clientMsgId`.

Both have `zod` schemas in `wire.ts`. A sync frame is a complete picture, so a
newer one replaces the previous wholesale; a frame with an older `serverTime`
is dropped for state but still contributes its round trip as an offset sample.

Timers are not redacted. A remaining time is not hidden information in any game
we support, and `sync()` still takes a `Viewer` so a future game that does hide
a clock has a place to say so rather than a new code path.

## Client side

`TimerSyncTracker` (also in platform-core — `apps/web` imports it, a game never
does) estimates the client↔server clock offset from timed round trips and keeps
the **shortest** round trip in a window of eight rather than averaging. `rtt / 2`
assumes a symmetric path; mobile data is not symmetric, and the minimum sample
is the least contaminated one.

```ts
const requestedAtMs = clock.now()
socket.send({ type: 'timer:sync-request', clientMsgId })
// …on the answer:
tracker.applySync(frame, { requestedAtMs, receivedAtMs: clock.now() })
tracker.views() // TimerView[], ready to render
```

## Restart

`service.snapshot()` is JSON-safe and goes into Redis; `TimerService.restore()`
parses it (never casts) and rebuilds. Anchors are absolute epoch milliseconds,
because a monotonic counter does not survive a process. A snapshot stamped in
the *future* relative to the restoring host is rejected rather than trusted.

- `chargeDowntime: true` (default) — a crash. From the players' point of view
  the clock never stopped, so it did not; a flag that fell while the process was
  dead fires immediately on restore.
- `chargeDowntime: false` — a drained restart. Commits what was spent up to the
  snapshot, then re-anchors to now.

## Firing

`TimerExpiry` carries `dueAtMs`, `firedAtMs` and `latenessMs`. The room runner
must use **`dueAtMs` as `ctx.now`** when it calls `game.onTimer`: the budget was
charged against the deadline, not against whenever the event loop got round to
it, and replaying the match log has to reproduce the call exactly.

Lateness is event-loop jitter, not clock error, and is surfaced so it can be
logged and watched in production.

## Measured

`pnpm --filter @playhall/platform-core bench:drift` — five real minutes, a client
whose hardware clock is 37 s out, over a deliberately asymmetric path (45 ms up
/ 15 ms down), synced once and then free-running.

```
client sync drift  max|e|   16.00 ms   (budget 100 ms)
client sync drift  p95      16.00 ms
client sync drift  final   -15.00 ms
5 min timer fired late by    2.00 ms
server anchor vs wall clock -2.00 ms over 301.8 s
```

The 16 ms is the path asymmetry the half-round-trip estimate cannot see
(45 − 15) / 2 = 15 ms, plus a millisecond of rounding. It is constant, not
growing: `test/sync.test.ts` asserts the error is identical at second 1 and
second 300. `test/drift-guard.test.ts` runs a five-second version of the same
measurement on every PR.
