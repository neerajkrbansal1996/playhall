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
 * So each gate is declared once in `scripts/ci/gates.mjs`, with the issue that
 * owns it. A gate whose script is not defined yet is reported as PENDING and
 * passes; the day the owning issue adds the script, the same job turns into a
 * hard gate with no workflow edit. The job names never change, which is what
 * lets required status checks be switched on (see `docs/ci-cd.md`) without
 * rework.
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
 * reason it cannot go on today is measurable, not a preference: `coverage` and
 * `integration` still have no root script, so the switch would fail two jobs on
 * its first run and take every PR red. The unblock is exact — when those root
 * scripts exist, add `CI_STRICT_GATES: '1'` to the gate jobs' `env` in
 * `.github/workflows/ci.yml`. If one of them is still missing at M1 close, the
 * move is not to delay again: give that gate a real `pendingOwner` issue, which
 * is what the field is for.
 *
 * Exiting 0 for a PENDING gate is deliberate, but on its own it is also how a
 * placeholder came to render as `✅ pass` in the PR gate table (PER-236): GitHub
 * records `result: success` either way. The PENDING state now reaches the
 * reviewer because `scripts/ci/gate-report.mjs` re-derives it in the aggregate
 * job from the same registry and the same `package.json` this script reads.
 *
 * Both branches below are covered by `tools/ci-gate` — the strict failure is
 * proven before the switch is flipped, not by the first red pipeline.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { GATES, classifyGate, strictGatesEnabled } from './gates.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const gateName = process.argv[2]
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const verdict = classifyGate(gateName, pkg.scripts, { strict: strictGatesEnabled() })

if (verdict.state === 'unknown') {
  console.error(`Unknown CI gate "${gateName}". Known gates: ${Object.keys(GATES).join(', ')}`)
  process.exit(2)
}

// A gate declared live (`pendingOwner: null`) whose script has gone missing is a
// demotion, not an unwritten implementation. Rename the root `lint` script and
// this would otherwise report PENDING with owner `unassigned` and exit 0, leaving
// `ci-gate` green while lint no longer ran. `CI_STRICT_GATES` does not get a say
// in that one: the gate's own registry entry says it is live.
if (verdict.state === 'demoted') {
  console.error(
    `::error title=CI gate demoted::${verdict.detail}. This gate is declared live, so a missing ` +
      'script means it was renamed or deleted rather than not written yet. Restore the ' +
      'script, or move the gate back to PENDING with an owning issue in scripts/ci/gates.mjs.',
  )
  process.exit(1)
}

if (verdict.state === 'missing') {
  console.error(`::error title=CI gate missing::${verdict.detail} (CI_STRICT_GATES=1)`)
  process.exit(1)
}

if (verdict.state === 'pending') {
  console.log(`::notice title=CI gate pending::${verdict.detail}`)
  appendSummary(`- PENDING **${gateName}** — ${verdict.detail}\n`)
  process.exit(0)
}

const started = Date.now()
const result = spawnSync('pnpm', ['run', verdict.script], { cwd: repoRoot, stdio: 'inherit' })
const seconds = ((Date.now() - started) / 1000).toFixed(1)

if (result.error) {
  console.error(`::error title=CI gate could not start::${gateName}: ${result.error.message}`)
  process.exit(1)
}

const code = result.status ?? 1
appendSummary(
  `- ${code === 0 ? 'PASS' : 'FAIL'} **${gateName}** — \`pnpm ${verdict.script}\` in ${seconds}s\n`,
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
