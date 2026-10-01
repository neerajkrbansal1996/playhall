#!/usr/bin/env node
/**
 * Runs one CI gate by name.
 *
 * Why this exists: PER-6 must stand up the *shape* of the pipeline (lint,
 * format, typecheck, boundaries, unit, coverage, testkit, integration, e2e)
 * before every gate's implementation exists — the conformance testkit lands with
 * PER-17, integration and E2E with M1/M3. A workflow that calls a missing pnpm
 * script fails with `ERR_PNPM_NO_SCRIPT`, which is indistinguishable from a real
 * regression.
 *
 * So each gate is declared here once, with the issue that owns it. A gate whose
 * script is not defined yet is reported as PENDING and passes; the day the
 * owning issue adds the script, the same job turns into a hard gate with no
 * workflow edit. The job names never change, which is what lets required status
 * checks be switched on (see `docs/ci-cd.md`) without rework.
 *
 * That has now happened for real three times: PER-5 added the root `boundaries`
 * script, `format` went live the same way, and PER-131 added `test:e2e` — each
 * time the gate went live on the next run with no edit to the workflow. `e2e`
 * did need one workflow step, but not to become a gate: the browsers have to be
 * downloaded, and `playwright install --with-deps` runs `apt-get`, which has no
 * business inside a pnpm script a developer might run.
 *
 * `CI_STRICT_GATES=1` turns PENDING into a failure, so a gate cannot sit
 * unimplemented behind a green `ci-gate` indefinitely. It is not set yet.
 *
 * Owner and trigger: PER-98, at M1 close (PER-9) — the same commitment
 * `docs/ci-cd.md` records, rather than an unowned "someday" in a comment. The
 * reason it cannot go on today is measurable, not a preference: `coverage`,
 * `testkit`, `integration` and `e2e` still have no root script, so the switch
 * would fail four jobs on its first run and take every PR red. The unblock is
 * exact — when those four root scripts exist, add `CI_STRICT_GATES: '1'` to the
 * gate jobs' `env` in `.github/workflows/ci.yml`. If one of them is still
 * missing at M1 close, the move is not to delay again: give that gate a real
 * `pendingOwner` issue, which is what the field is for.
 *
 * Both branches below are covered by `tools/ci-gate` — the strict failure is
 * proven before the switch is flipped, not by the first red pipeline.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The gate registry. `script` is a root-level pnpm script name.
 * `pendingOwner` is who must land it; `null` means the gate is already live.
 */
const GATES = {
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

const gateName = process.argv[2]
// Own keys only. A plain lookup resolves `constructor`, `toString` and friends
// up the prototype chain, and the truthy result then reads `gate.script` as
// undefined — which lands in the PENDING branch below and exits 0. A typo'd
// gate name would report "pending, owner: unassigned" and pass forever.
const gate = Object.hasOwn(GATES, gateName) ? GATES[gateName] : undefined

if (!gate) {
  console.error(`Unknown CI gate "${gateName}". Known gates: ${Object.keys(GATES).join(', ')}`)
  process.exit(2)
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const isDefined = Boolean(pkg.scripts?.[gate.script])

if (!isDefined) {
  const strict = process.env.CI_STRICT_GATES === '1'
  const detail = `gate "${gateName}" has no root script "${gate.script}" yet — owner: ${gate.pendingOwner ?? 'unassigned'}`

  // A gate declared live (`pendingOwner: null`) whose script has gone missing is
  // a demotion, not an unwritten implementation. Rename the root `lint` script
  // and this would otherwise report PENDING with owner `unassigned` and exit 0,
  // leaving `ci-gate` green while lint no longer ran. `CI_STRICT_GATES` does not
  // get a say in that one: the gate's own registry entry says it is live.
  if (gate.pendingOwner === null) {
    console.error(
      `::error title=CI gate demoted::${detail}. This gate is declared live, so a missing ` +
        'script means it was renamed or deleted rather than not written yet. Restore the ' +
        'script, or move the gate back to PENDING with an owning issue in scripts/ci/gate.mjs.',
    )
    process.exit(1)
  }

  if (strict) {
    console.error(`::error title=CI gate missing::${detail} (CI_STRICT_GATES=1)`)
    process.exit(1)
  }

  console.log(`::notice title=CI gate pending::${detail}`)
  appendSummary(`- PENDING **${gateName}** — ${detail}\n`)
  process.exit(0)
}

const started = Date.now()
const result = spawnSync('pnpm', ['run', gate.script], { cwd: repoRoot, stdio: 'inherit' })
const seconds = ((Date.now() - started) / 1000).toFixed(1)

if (result.error) {
  console.error(`::error title=CI gate could not start::${gateName}: ${result.error.message}`)
  process.exit(1)
}

const code = result.status ?? 1
appendSummary(
  `- ${code === 0 ? 'PASS' : 'FAIL'} **${gateName}** — \`pnpm ${gate.script}\` in ${seconds}s\n`,
)
process.exit(code)

/** Writes a line to the GitHub job summary when running in Actions; no-ops locally. */
function appendSummary(line) {
  const target = process.env.GITHUB_STEP_SUMMARY
  if (!target) return
  try {
    appendFileSync(target, line)
  } catch {
    // A summary is nice-to-have; never fail a gate over it.
  }
}
