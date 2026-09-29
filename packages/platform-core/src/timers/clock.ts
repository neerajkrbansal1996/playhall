/**
 * The platform clock.
 *
 * This is the **only** module under `packages` allowed to read ambient time.
 * Everything else — the timer service, the room runner, the reducers we run for
 * games — takes a `Clock` and is therefore testable without waiting in real
 * time. The determinism lint rule (`no-restricted-properties` over the package
 * and game sources) is switched off for this file alone, with the override
 * written next to the rule in `eslint.config.mjs`.
 *
 * ## Why not just `Date.now()`
 *
 * A timer service that samples `Date.now()` inherits every wall-clock
 * adjustment the host makes. NTP does not only speed the clock up or slow it
 * down; `ntpd`/`chronyd` will *step* it when the offset is large, and a
 * container resuming from a paused host can see a step of seconds. A chess
 * clock that loses a second because the host synced with an upstream server is
 * a bug players notice and cannot be told to ignore.
 *
 * So the system clock here is anchored once:
 *
 *     now() = wallOrigin + (performance.now() - monoOrigin)
 *
 * `performance.now()` is a monotonic counter that no clock adjustment touches,
 * so every *duration* this service measures is immune to wall-clock steps. The
 * epoch offset is fixed at construction, which is what makes the returned value
 * still meaningful as "ms since the Unix epoch" to a client.
 *
 * ## The tradeoff, stated
 *
 * Because the anchor is never refreshed, `now()` slowly diverges from true wall
 * time at the rate of the host's oscillator error (tens of ppm — single-digit
 * ms over the ~1 h life of a room). That does not matter: clients synchronise
 * to *this* clock via `timer:sync`, not to their own, so the server's clock is
 * correct by definition for the duration of a match. It matters only across a
 * process restart, where the new process re-anchors to `Date.now()` — see
 * `restoreTimerService` in `service.ts`.
 */

/** A source of server-authoritative time, in ms since the Unix epoch. */
export interface Clock {
  /**
   * Monotonically non-decreasing. Two calls in the same millisecond may return
   * the same value; a later call never returns a smaller one.
   */
  now(): number
}

/** A `Clock` a test drives by hand. Never used in production code paths. */
export interface ManualClock extends Clock {
  advance(ms: number): void
  set(ms: number): void
}

/**
 * Reads the host's monotonic counter. Present in Node >= 16 and in every
 * browser we support, so no fallback is needed.
 */
function monotonicMs(): number {
  return performance.now()
}

/**
 * The production clock. Call once per process and share the instance — two
 * instances anchor at different moments and would disagree by their
 * construction gap.
 */
export function createSystemClock(): Clock {
  const wallOriginMs = Date.now()
  const monoOriginMs = monotonicMs()
  return {
    now(): number {
      // Rounded, not truncated: timers are compared against integers all the
      // way down, and truncation biases every measured duration low by up to
      // 1 ms per sample.
      return Math.round(wallOriginMs + (monotonicMs() - monoOriginMs))
    },
  }
}

/**
 * A clock that only moves when a test moves it. Every timer test uses this;
 * only the drift benchmark uses the real one.
 */
export function createManualClock(startMs = 0): ManualClock {
  let current = startMs
  return {
    now: () => current,
    advance(ms: number): void {
      if (ms < 0) throw new RangeError('a manual clock cannot go backwards')
      current += ms
    },
    set(ms: number): void {
      if (ms < current) throw new RangeError('a manual clock cannot go backwards')
      current = ms
    },
  }
}

/**
 * A fixed instant. Useful where a `Clock` is structurally required but time
 * must not move — replaying the match log, for instance.
 */
export function createFixedClock(atMs: number): Clock {
  return { now: () => atMs }
}
