/**
 * A real monotonic clock for the drift harness, and the only place in this
 * package that reads ambient time.
 *
 * It is a deliberate copy of `apps/realtime/src/clock.ts`, which is the
 * production implementation and the only one a running server ever uses. Two
 * constraints meet here and leave no better option:
 *
 * - `packages/platform-core/src/**` may not read ambient time at all
 *   (ADR-0002 §4), which is why the production clock lives in the composition
 *   root. The determinism lint rule is scoped to `packages/**\/src/**`, so a
 *   test fixture is outside it by construction, not by exemption.
 * - A package's test may not import an app. The dependency points the other
 *   way, and `pnpm boundaries` enforces it: `no-package-to-app` in
 *   `.dependency-cruiser.cjs` (ADR-0002 §2, rev 2.4) covers `^packages/` —
 *   `test/` trees included — to every app, in all three forms §2.1 requires.
 *   Grep that name before trusting this bullet; it was wrong once. Until
 *   [PER-251](/PER/issues/PER-251) the rule did not exist, a probe importing
 *   `apps/realtime/src/clock.ts` from this directory cruised clean, and this
 *   comment was the only thing enforcing the boundary it claimed was
 *   enforced. `no-package-to-app-test-tree.fixture` is the committed proof
 *   that the planted import now fails the build.
 *
 * So the drift measurement brings its own real clock: the event-loop jitter,
 * the `setTimeout` lateness and the real `await`s are the parts that a fake
 * clock cannot produce, and they are half of what the harness is there to
 * expose. Keeping it in `test/fixtures` means no production path can reach it:
 * a `src` module that imported this would fail the build.
 *
 * It is *not* the source of the clock divergence, and an earlier version of
 * this comment claimed it was — "divergence between two real clocks over five
 * minutes". One process has one oscillator. Two `realSystemClock()`s read the
 * same `performance.now()`, so their rate ratio is identically 1.0 and the only
 * difference between them is the sub-millisecond gap between their two anchor
 * reads. A second real clock, or a constant skew on top of one, therefore
 * contributes nothing that grows with time, and a five-minute run measures
 * exactly what a five-second run measures. The divergence has to be injected —
 * see `ratedClock` — and [PER-258](/PER/issues/PER-258) is the ticket where QA
 * caught the bench asserting a budget it could not spend.
 *
 * If this and the production clock ever disagree, `apps/realtime` is the
 * contract and this is the stale copy.
 */

import type { Clock } from '../../src/runtime.js'

/** See `apps/realtime/src/clock.ts` for why the anchor is taken once. */
export function realSystemClock(): Clock {
  const wallOriginMs = Date.now()
  const monoOriginMs = performance.now()
  return {
    now: () => Math.round(wallOriginMs + (performance.now() - monoOriginMs)),
  }
}

export interface RatedClockOptions {
  /**
   * How fast this clock runs relative to `base`, in parts per million. A real
   * phone's crystal is specified at ±20 ppm and drifts further when the handset
   * is warm; 50 ppm is a typical observed figure, 100 ppm a cheap or hot one,
   * and 200 ppm about the worst that is still a working device.
   */
  readonly ppmFast: number
  /**
   * A constant offset on top, so the offset estimator has genuine work to do
   * rather than measuring zero against zero. This is the part that *cannot*
   * drift: see the module comment.
   */
  readonly skewMs?: number
}

/**
 * A clock that runs at a different *rate* from `base`, which is the one thing
 * a single-host harness cannot get for free.
 *
 * Rate error is the term that makes a long measurement different from a short
 * one: it enters the client's rendered remaining time through the `clientNow`
 * in `deadlineAtMs - (clientNow + offset)`, so it accumulates at `ppm x
 * elapsed` until the next sync replaces the offset. `TimerSyncTracker` is
 * immune to accumulated *countdown* error — nothing counts down locally — but
 * that is a different property, and only the first one is architecturally
 * guaranteed.
 *
 * The rate is simulated, which is the honest limit of an in-process harness:
 * both clocks still share one oscillator, and this makes one of them *report*
 * as though it did not.
 */
export function ratedClock(base: Clock, options: RatedClockOptions): Clock {
  const originMs = base.now()
  const rate = 1 + options.ppmFast / 1_000_000
  const skewMs = options.skewMs ?? 0
  return { now: () => Math.round(originMs + (base.now() - originMs) * rate + skewMs) }
}
