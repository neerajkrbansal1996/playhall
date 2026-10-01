/**
 * Validation for the millisecond quantities a game hands the timer service.
 *
 * Every number that crosses into this service from a game — `delayMs` on a
 * `TimerCommand`, the `ctx.now` the command was stamped with, a player-clock
 * configuration — is arithmetic input to a deadline. The service is
 * server-authoritative, so these are the one class of value it cannot simply
 * trust: a game module is our own code, but it is *plugin* code, and the whole
 * point of principle 5 is that the platform does not take a clock or a budget
 * on faith.
 *
 * ## Why rejecting is the only safe answer
 *
 * The failure is not "a slightly wrong deadline". A non-integer or non-finite
 * quantity propagates and takes the room down, in four distinct ways:
 *
 * 1. **`NaN` makes a timer that can never fire.** `deadlineMsAt` returns
 *    `NaN`, every `<=` comparison against it is false, so `poll` never finds
 *    it due. The clock shows a garbage number and counts down forever.
 * 2. **`NaN` makes the real scheduler spin.** `#rearm` arms at `NaN`, which
 *    `setTimeout` coerces to `0`, so the room burns a timer callback per tick
 *    for the rest of its life — on the 2,000-rooms-per-instance path.
 * 3. **It poisons the snapshot.** `timerSnapshotSchema` requires finite
 *    integers, so the room becomes unrestorable: the crash-recovery path can
 *    never bring that match back.
 * 4. **It freezes every clock in the room.** `timerSyncMessageSchema` validates
 *    the whole `timer:sync` frame, so one bad record makes the *client* reject
 *    the entire frame, and the player's own clock stops updating too.
 *
 * None of those is recoverable from after the fact, and all four are silent.
 * So these guards throw at the boundary, where the stack still names the
 * command that did it. A game bug becomes a loud failure in the conformance
 * suite instead of a dead room in production.
 *
 * `RangeError` rather than `TypeError`: the type is already `number`: it is the
 * value that is out of the representable range for a deadline.
 */

/**
 * An instant on the server clock: epoch milliseconds.
 *
 * Must be a safe integer. Not merely finite — `Number.MAX_VALUE` as an anchor
 * makes every duration computed from it lose integer precision, and the
 * snapshot schema would reject it anyway. Negative is allowed: it is a legal
 * epoch instant, and a test clock starting at 0 must be able to measure
 * something before it.
 */
export function assertEpochMs(label: string, value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `${label} must be an integer number of milliseconds, got ${describe(value)}`,
    )
  }
  return value
}

/**
 * A length of time: a delay, a budget, an increment.
 *
 * Must be a non-negative safe integer. Negative is rejected rather than
 * clamped to zero, even though `createTimerRecord` clamps as a second line of
 * defence. A negative `delayMs` has two readings — "fire immediately" and "the
 * caller computed a deadline wrong" — and silently picking the first hides the
 * second. A game that genuinely wants an immediate expiry passes `0`.
 */
export function assertDurationMs(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${label} must be a non-negative integer number of milliseconds, got ${describe(value)}`,
    )
  }
  return value
}

/** A duration that may be absent, such as `PlayerClockConfig.maxMs`. */
export function assertOptionalDurationMs(label: string, value: number | null): number | null {
  if (value === null) return null
  return assertDurationMs(label, value)
}

/**
 * `String(NaN)` is `"NaN"` and `String(-0)` is `"0"`, both of which read badly
 * in an error a game author has to act on. Name the shape, not just the digits.
 */
function describe(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (!Number.isFinite(value)) return String(value)
  if (!Number.isInteger(value)) return `the fractional value ${value}`
  return String(value)
}
