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
 *   way, and `pnpm boundaries` enforces it.
 *
 * So the drift measurement — which is meaningless against a fake clock, since
 * the number being measured is divergence between two real clocks over five
 * minutes — brings its own. Keeping it in `test/fixtures` means no production
 * path can reach it: a `src` module that imported this would fail the build.
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
