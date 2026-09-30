# Timer stop reasons on the wire

- **Serves:** [PER-15](/PER/issues/PER-15) — lobby/turn-based protocol + room runner
- **Owner:** Platform Engineer
- **Status:** Specified, not yet implemented (PER-15 is blocked on
  [PER-12](/PER/issues/PER-12) and [PER-14](/PER/issues/PER-14))
- **Sources:** CTO protocol note on PER-15 out of the [PR #17](https://github.com/neerajkrbansal1996/playhall/pull/17)
  re-review ([PER-76](/PER/issues/PER-76)); [ADR-0001](../adr/0001-v1-stack.md) rev 4 §§4.5, 6;
  [Colyseus transport](colyseus-transport.md) §7
- **Depends on:** the hold-scope follow-up asked for on PR #17 ([PER-70](/PER/issues/PER-70)) —
  see §7 for the one thing this spec needs from it

## 1. The lie, stated precisely

`toSyncEntry` in `packages/platform-core/src/timers/service.ts` collapses two different facts
into one wire value:

```ts
state: record.expired ? "expired" : running ? "running" : "paused";
```

`paused` therefore means either of:

- **not to move** — Black's chess clock while White is thinking. Nothing is wrong.
- **held** — a host paused the room, a seat disconnected, or the game called `pause`. Something
  outside the game state is keeping the clock stopped and a player is waiting on it.

A client cannot tell these apart, so its HUD either says nothing or guesses. "Waiting for
opponent" while the truth is "opponent disconnected, clock held" is the plausible lie ADR-0001
§4.5's blast-radius rule exists to prevent.

**One sharpening of the CTO's framing.** The ambiguity is worse than a missing label, because the
reason is not on the entry a player is looking at. `pauseForSeat` holds the timers of the seat
that _dropped_, and only those — `record.seatId !== seatId` skips everything else. So when seat B
drops on B's move:

| entry           | before B drops         | after B drops                 |
| --------------- | ---------------------- | ----------------------------- |
| B's chess clock | `running`              | `paused` ← the hold is here   |
| A's chess clock | `paused` (not to move) | `paused` (unchanged, no hold) |

A client rendering only its own clock sees no change at all. To notice anything today it must
join the game view (whose move is it?) against the timer frame (is that seat's clock running?),
observe that the mover's clock is stopped, and then still guess _why_. The reason must therefore
be **per entry**, and the client contract has to say that a room-level condition surfaces on
another seat's entry (§5).

## 2. Where it goes: on the sync entry, not an adjacent frame

The CTO left this open. It goes on the entry, for one reason that outranks the others:

**A separate frame can disagree with `state`.** Two frames are two deliveries, with independent
ordering and independent loss. The window in which a client holds a stale reason against a fresh
`state`, or a fresh reason against a stale `state`, is exactly the window in which it renders a
confident wrong answer — the failure this change exists to remove. Atomicity with `state` is the
requirement, and one frame is how you get it.

Three smaller reasons point the same way:

- `version` is already per entry and already bumps on a hold change (§4), so the reason inherits
  ordering and gap detection for free. An adjacent frame would need its own.
- `timer:sync` is already sent on join, on reconnect and on every timer change. A hold change
  _is_ a timer change, so there is no new trigger, no new subscription, and no new frame type.
- Cost is one short array per timer per sync frame — under 30 B on a two-clock chess room, on a
  frame that is already being sent.

## 3. Wire shape

Additive to `timerSyncEntrySchema` in `packages/platform-core/src/timers/wire.ts`:

```ts
/**
 * Why this timer is stopped by something outside the game state. Empty for a
 * running timer, an expired timer, and — the load-bearing case — a timer that
 * is stopped only because its seat is not to move.
 */
export const timerStopReasonSchema = z.enum(['room-paused', 'seat-disconnected', 'game-paused'])
export type TimerStopReason = z.infer<typeof timerStopReasonSchema>

// inside timerSyncEntrySchema:
  stoppedBy: z.array(timerStopReasonSchema).default([]),
```

**An array, not a scalar.** Holds nest: a host can pause the room while a player is already
disconnected. A scalar forces a precedence rule, and a precedence rule is a lossy projection —
when the host resumes, a scalar would have to flip from `room-paused` to `seat-disconnected`, and
any client that treated `room-paused` as "the only thing wrong" renders a resume that did not
happen. The array cannot express that mistake.

**`.default([])`, matching the `holds` precedent in `timerSnapshotSchema`.** A frame from a
pre-`stoppedBy` server parses on a new client as "not held", which is the correct reading of a
server that had no concept of holds. A live match must survive the deploy that introduces the
field.

**One canonical encoding per fact.** `state: 'paused'` with `stoppedBy: []` is the _only_ way to
say "not to move"; there is no `'not-to-move'` member, because adding one would make
`['not-to-move', 'room-paused']` expressible and the wire must not be able to contradict itself.
For the same reason `stoppedBy` MUST be `[]` when `state` is `running` or `expired` —
`expireRecord` sets `holds: []` when a clock flags, so an expired entry carrying a reason is a
bug, not a state.

The client half must carry it through or the HUD still cannot see it. `ClientTimerView` in
`sync.ts` gains the same field plus the derived discriminant, so no client re-derives the
invariant:

```ts
readonly stoppedBy: readonly TimerStopReason[]
/** `paused` with nothing holding it: a normal wait for the other seat. */
readonly isWaitingForTurn: boolean
```

## 4. Deriving it: the projection must be total

The wire enum is deliberately **not** the internal `TimerHold` union. Internally the game's own
`pause` takes a hold named `'timer'`, which on a protocol read as "held by a timer" instead of
"the game paused this clock"; wire names are a contract that outlives internal refactors and must
not inherit a misleading one. So there is a mapping — and a mapping is a thing that can be wrong,
which the copy it replaces could not be. Restore the safety with exhaustiveness:

```ts
const STOP_REASON_BY_HOLD: Record<TimerHold, TimerStopReason> = {
  room: "room-paused",
  "seat-disconnect": "seat-disconnected",
  timer: "game-paused",
};
```

A `Record` over the union with no default branch means **a new hold scope fails to typecheck
until someone decides what it looks like on the wire**. That is the property worth having: the
next person to add a hold cannot ship a clock stopped for a reason the protocol cannot name.

**The projection is honest because of one guard, and that coupling needs a test.** `applyHold`
refuses to take a hold on a timer that is already stopped for a game-state reason:

```ts
if (!isRunning(record) && !isHeld(record)) return record;
```

That guard is the entire reason `stoppedBy: []` can be trusted to mean "not to move". Without it,
`pauseAll` would stamp `room-paused` onto the non-mover's clock, `stoppedBy` would be non-empty on
a clock nobody was on, and every client badge would be wrong. It is currently justified in
`record.ts` as a correctness property of `releaseHold`; once it is also a protocol guarantee, the
test naming it must say so — a future simplification of that guard silently changes what the wire
means. Pin it: **`pauseAll` on a room where White is to move yields `stoppedBy: ['room-paused']`
on White's clock and `[]` on Black's.**

`applyHold`/`releaseHold` both `bump()` the record version, so a hold change already produces a
new `version` and therefore a new `timer:sync`. Taking a hold that is already held returns the
record untouched, so an idempotent re-pause produces no spurious frame. Nothing new is needed on
the push path.

## 5. What this frame does not answer

`stoppedBy` answers "why is this clock stopped". It does not answer "is this player here", and
the two must not be conflated — they legitimately diverge. A timer whose manifest sets
`pausesOnDisconnect: false` keeps **running** while its seat is away, because unplugging must not
buy free time. So `state: 'running'`, `stoppedBy: []`, presence `away` is a valid,
non-contradictory combination, and a client that infers presence from `stoppedBy` will call an
absent player present.

That is the correct reading of the CTO's "do not let a game infer it from presence on a side
channel": the two frames are not two sources of truth for one fact, they are one source each for
two different facts. `presence:update` owns connection state. `timer:sync` owns why a clock is
stopped. A UI that wants "opponent disconnected, clock held" reads both and says so only when
both agree; a UI that has only one of them says less, which is the acceptable failure.

**Client contract, because §1 makes it non-obvious:** a room-level condition surfaces on the
entry of the seat it applies to, which is usually _not_ the viewer's own entry. A client
rendering a room-level banner scans every entry; a client rendering its own clock reads its own.
Both are correct uses; neither is complete on its own.

## 6. Redaction

`timer:sync` stays a `ControlFrame` under [Colyseus transport](colyseus-transport.md) §7 and goes
out through `sendControl`, not `sendView`. `stoppedBy` is timer-service state, not game state —
it declares no game-state- or view-shaped field, so it does not widen the egress brand and the
layer-6 exhaustive classification still covers it.

It is **not** per-viewer redacted, and that is a decision rather than an omission: every value it
can carry is already public to the room. `seatId` is on every entry today, and `presence:update`
already broadcasts the drop that `seat-disconnected` reflects. Making the timer frame quieter
than presence would not hide anything, it would only let the two disagree.

**Known limit, recorded rather than solved.** A future game that hides seat identity would need
per-viewer timer redaction, at which point `timer:sync` moves behind `getViewFor` and stops being
a control frame. Nothing in v1 needs that — chess and tic-tac-toe both have public seats — and
the layer-6 test fails loudly if someone tries to put game state on this frame instead.

## 7. The one thing this needs from PER-70's follow-up

The CTO's follow-up on PR #17 asks the service to make hold scopes explicit as `#roomHeld`,
`#heldSeats`, `#heldTimers`. Today the reason is read off `record.holds`, a per-record array. If
that bookkeeping moves to service-level sets, a wire projection written against the record field
breaks with the refactor.

So the projection is specified against a **public service query**, not against a field:

```ts
/** The outstanding holds on `timerId`, in the order they were taken. */
stopReasonsFor(timerId: TimerId): readonly TimerHold[]
```

`toSyncEntry` calls that and maps through `STOP_REASON_BY_HOLD`. Whether the implementation
behind it is `record.holds` or three service-level sets is then invisible to the protocol. This is
a small addition to PER-70's follow-up — the data already exists either way — and asking for it
now is cheaper than re-deriving the wire after the refactor lands.

## 8. Finding: restored `seat-disconnect` holds must be reconciled against live presence

This one is PER-15's, not PER-14's, and it only becomes visible once the reason is on the wire.

`timerSnapshotSchema` persists `holds`, so a restart restores a `seat-disconnect` hold — correct,
and necessary, or a restart would hand a disconnected player's clock back to a room that thinks
it is running. But the call that lifts it, `resumeForSeat`, is made by the reconnect handler. If
the seat reconnects **during the restart window**, that handler fires against a process that is
already gone, and nothing in the restored process ever lifts the hold. The match resumes with a
permanently frozen clock and — now — a permanent `seat-disconnected` badge asserting something
that is no longer true.

**Requirement on the room runner's recovery path:** after restoring a `TimerSnapshot`, reconcile
every restored `seat-disconnected` hold against live presence in Redis, and lift the holds of
seats that are currently connected before the first `timer:sync` goes out. Recovery must not emit
a frame whose `stoppedBy` contradicts presence it can already read.

The same argument does not apply to `room-paused` or `game-paused`: both are lifted by an explicit
command whose authority survives the restart (the host, or the game's own reducer), and neither
has an out-of-band event that could have been missed.

## 9. Done when

- A held clock and a not-to-move clock produce **different** wire frames, asserted on the frames
  rather than on the service: `pauseAll` with White to move gives `stoppedBy: ['room-paused']` on
  White and `[]` on Black (§4).
- Nested holds are faithful across a partial release: hold `room` and `seat-disconnect` on one
  clock, release `room`, and the entry still reads `['seat-disconnected']` with `state: 'paused'`
  — not `running`, not `[]`.
- A disconnect on the mover's seat yields exactly one entry with a non-empty `stoppedBy`, and it
  is the **dropped** seat's entry (§1). The waiting player's own entry is byte-identical to the
  frame before the drop.
- `stoppedBy` is `[]` on every `running` and every `expired` entry, under the testkit's fuzzed
  playouts rather than by inspection.
- A frame serialised without `stoppedBy` parses as `[]` (§3), proving the deploy that introduces
  the field does not break a live match.
- A restart with a seat that reconnected inside the restart window emits a first `timer:sync`
  with no `seat-disconnected` hold for that seat, and a running clock (§8).
- The exhaustiveness of `STOP_REASON_BY_HOLD` is a compile-time fact, not a runtime one: adding a
  member to `TimerHold` fails `tsc` in `wire.ts`.

**Not covered.** No code and no measured numbers — every number here is a budget, and the only
one worth measuring is the frame-size delta in §2, which is owed at implementation. The UI
decision of _what to say_ for each reason is the Frontend Engineer's; this spec only guarantees
the fact is on the wire and cannot be self-contradictory.
