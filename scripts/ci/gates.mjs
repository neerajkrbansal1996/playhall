/**
 * The CI gate registry, and the one function that decides what a gate's state is.
 *
 * This used to live inside `scripts/ci/gate.mjs`, where only the gate's own job
 * could see it. That was the defect in PER-236: `gate.mjs` knows a gate is a
 * PENDING placeholder, exits 0 to say so, and GitHub records `result: success` —
 * which is the same thing it records for a gate that ran and passed. Every
 * downstream reader (`assert-gates.mjs`, the PR gate table in `ci.yml`) reads
 * `toJSON(needs)` and therefore cannot tell the two apart, so `coverage` rendered
 * as `✅ pass` on PR #114 while running nothing at all.
 *
 * Rather than plumb a status out of each gate job — a per-job `outputs:` block or
 * an artifact upload, both of which have to be added again for every new gate —
 * the state is re-derived in the aggregate job from the same two inputs
 * `gate.mjs` used: this registry and the root `package.json`. The `ci-gate` job
 * checks out the same SHA as every gate job in the same run, so the two
 * computations read identical bytes and cannot disagree.
 */

/**
 * `script` is a root-level pnpm script name. `pendingOwner` is who must land it;
 * `null` means the gate is already live.
 */
export const GATES = {
  lint: { script: 'lint', pendingOwner: null },
  // Live from the day it lands, not PENDING: `format:check` has existed in the
  // root package.json since PER-6, it just was never called by anything. See
  // ADR-0001 §9. `pnpm format` is the fix command for a failure here.
  format: { script: 'format:check', pendingOwner: null },
  typecheck: { script: 'typecheck', pendingOwner: null },
  unit: { script: 'test', pendingOwner: null },
  // The >= 80% rule currently lives in each package's own vitest thresholds, so
  // a package that configures none is exempt by accident — which is exactly how
  // game-sdk sat at 0% and games/chess at 41% behind a green `unit`.
  coverage: {
    script: 'test:coverage',
    pendingOwner: 'PER-89 — aggregate >= 80% check across the required packages',
  },
  // Went live with no edit here the moment PER-5 added the root `boundaries`
  // script — the PENDING branch keys on the script existing, not on this field.
  boundaries: { script: 'boundaries', pendingOwner: null },
  // Live from the day it landed (PER-126), so no pendingOwner. `boundaries` can
  // only see the import graph; this one reads the bytes that actually reach the
  // browser on the create-lobby route. It builds `apps/web`, which is why it is
  // its own job rather than a step on `lint`.
  bundle: { script: 'check:bundle-zod-free', pendingOwner: null },
  testkit: {
    script: 'test:testkit',
    pendingOwner: 'PER-17 — game conformance testkit (first consumer: tic-tac-toe)',
  },
  integration: {
    script: 'test:integration',
    pendingOwner: 'M1 — realtime service integration tests (need Redis + Postgres)',
  },
  // Live since PER-131: the root `test:e2e` script and `playwright.config.ts`
  // landed, so this gate stopped printing `::notice title=CI gate pending` and
  // started running Playwright on Chromium and WebKit. `pendingOwner: null` is
  // now load-bearing — delete the root script and the "gate demoted" branch
  // below fails the job instead of reporting PENDING and exiting 0.
  // Coverage and its explicit non-coverage: `docs/testing/e2e.md`.
  e2e: { script: 'test:e2e', pendingOwner: null },
}

/**
 * Looks a gate up by name. Own keys only: a plain lookup resolves `constructor`,
 * `toString` and friends up the prototype chain, and the truthy result then reads
 * `gate.script` as undefined — which lands in the PENDING branch and exits 0. A
 * typo'd gate name would report "pending, owner: unassigned" and pass forever.
 *
 * @returns the registry entry, or `undefined` for an unregistered name.
 */
export function lookupGate(gateName) {
  return Object.hasOwn(GATES, gateName) ? GATES[gateName] : undefined
}

/**
 * Classifies a registered gate against a set of root `package.json` scripts.
 *
 * This is the whole of `gate.mjs`'s decision, extracted so the aggregate job can
 * reach the same verdict. Keep the four states in step with the branches in
 * `gate.mjs`, which is what `tools/ci-gate` pins:
 *
 *   * `live`    — the root script exists, so the gate ran something.
 *   * `pending` — no root script yet and an owning issue says so. Exits 0.
 *   * `demoted` — no root script but `pendingOwner: null` declared it live, so the
 *                 script was renamed or deleted. Fails regardless of strict mode.
 *   * `missing` — pending, but `CI_STRICT_GATES=1` turns that into a failure.
 *
 * @param {string} gateName
 * @param {Record<string, string> | undefined} scripts the root package.json `scripts` map
 * @param {{ strict?: boolean }} [options]
 */
export function classifyGate(gateName, scripts, { strict = false } = {}) {
  const gate = lookupGate(gateName)
  if (!gate) return { state: 'unknown', gateName }

  const detail = `gate "${gateName}" has no root script "${gate.script}" yet — owner: ${
    gate.pendingOwner ?? 'unassigned'
  }`

  if (scripts?.[gate.script]) {
    return { state: 'live', gateName, script: gate.script, pendingOwner: gate.pendingOwner }
  }
  if (gate.pendingOwner === null) {
    return { state: 'demoted', gateName, script: gate.script, pendingOwner: null, detail }
  }
  return {
    state: strict ? 'missing' : 'pending',
    gateName,
    script: gate.script,
    pendingOwner: gate.pendingOwner,
    detail,
  }
}

/** True when `CI_STRICT_GATES` is exactly `"1"`. Pinned by `tools/ci-gate`. */
export function strictGatesEnabled(env = process.env) {
  return env.CI_STRICT_GATES === '1'
}
