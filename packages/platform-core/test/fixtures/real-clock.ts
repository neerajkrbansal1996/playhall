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
