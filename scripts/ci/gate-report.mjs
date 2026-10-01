#!/usr/bin/env node
/**
 * Turns `toJSON(needs)` into the gate verdict every reader of a CI run sees.
 *
 * PER-236: there used to be two implementations of "did the gates pass?" — the
 * table in `assert-gates.mjs` and a near-copy inlined into the `github-script`
 * step in `.github/workflows/ci.yml` — and both read `needs.<job>.result` alone.
 * That field is `success` both for a gate that ran and passed and for a PENDING
 * placeholder that `gate.mjs` deliberately exited 0 on without running anything,
 * so `coverage` and `integration` rendered as `✅ pass` on PR #114 under the
 * footer "All gates passed." The PENDING lines existed only in each gate job's
 * step summary, in the Actions tab — the exact place ADR-0004 Decision 2 assumes
 * a reviewer will not look.
 *
 * So the verdict is computed once, here, and the third state is recovered rather
 * than plumbed: `ci-gate` checks out the same SHA as every gate job in the run,
 * so re-running `classifyGate` against this tree's root `package.json` reproduces
 * exactly what each gate job decided. No per-job `outputs:` block or artifact
 * upload to add for every future gate, and no second place to keep in step.
 *
 * A PENDING gate still does not fail the build — that is `CI_STRICT_GATES`'s job
 * (PER-98), and failing here instead would take every PR red today. This changes
 * what the evidence *says*, not what blocks a merge.
 *
 * CLI: `node scripts/ci/gate-report.mjs --format=pr` prints the PR comment body
 * on stdout, which is what `ci.yml` posts. `--format=summary` prints the table
 * alone. Reads `GATE_RESULTS`, and for `--format=pr` also `GATE_SHA` and
 * `GATE_RUN_URL`.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { classifyGate, strictGatesEnabled } from './gates.mjs'

/** The HTML marker that lets the workflow find and update its own comment. */
export const COMMENT_MARKER = '<!-- playhall-ci-gate -->'

/**
 * Jobs that legitimately do not run on every event. A `skipped` result for
 * anything else fails the build: GitHub reports a skipped job as *not failed*, so
 * a job accidentally given an `if:` that never matches would silently stop gating
 * while the required check stayed green.
 */
export const SKIP_ALLOWED = new Set([
  // Only runs on `pull_request`; there is no PR body to check on push or in a
  // merge group.
  'pr-hygiene',
])

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * @typedef {object} GateRow
 * @property {string} job
 * @property {string} result the raw `needs.<job>.result`
 * @property {'pass' | 'pending' | 'fail'} state
 * @property {string | null} pendingOwner the owning issue, for a `pending` row
 */

/**
 * @param {object} options
 * @param {Record<string, { result?: string }>} options.needs parsed `toJSON(needs)`
 * @param {Record<string, string> | undefined} options.scripts the root package.json `scripts`
 * @param {boolean} [options.strict] whether `CI_STRICT_GATES=1` was set on the gate jobs
 * @param {Set<string>} [options.skipAllowed]
 * @returns {{ rows: GateRow[], failures: GateRow[], pending: GateRow[] }}
 */
export function buildGateReport({ needs, scripts, strict = false, skipAllowed = SKIP_ALLOWED }) {
  const rows = Object.entries(needs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([job, info]) => {
      const result = info?.result ?? 'unknown'
      const ok = result === 'success' || (result === 'skipped' && skipAllowed.has(job))
      if (!ok) return { job, result, state: 'fail', pendingOwner: null }

      // Only a *successful* job can be a placeholder. If a gate the registry
      // calls pending somehow reported non-success, the real result wins — the
      // run is the evidence, this re-derivation is only how the run's silence
      // about PENDING is recovered.
      const verdict = classifyGate(job, scripts, { strict })
      if (result === 'success' && verdict.state === 'pending') {
        return { job, result, state: 'pending', pendingOwner: verdict.pendingOwner }
      }
      return { job, result, state: 'pass', pendingOwner: null }
    })

  return {
    rows,
    failures: rows.filter((row) => row.state === 'fail'),
    pending: rows.filter((row) => row.state === 'pending'),
  }
}

/** Escapes the one character that would break out of a markdown table cell. */
function cell(text) {
  return String(text).replaceAll('|', '\\|')
}

/**
 * The three-column table for a job summary and for `ci-gate`'s own log.
 * `verdict` is the decision; `result` is the raw GitHub field it came from, kept
 * visible so a surprising verdict can be traced back.
 */
export function renderSummaryTable(report) {
  const rows = report.rows.map((row) => {
    const verdict =
      row.state === 'fail' ? 'FAIL' : row.state === 'pending' ? 'PENDING (ran nothing)' : 'pass'
    const detail = row.state === 'pending' ? ` — owner: ${cell(row.pendingOwner)}` : ''
    return `| \`${row.job}\` | ${verdict} | ${cell(row.result)}${detail} |`
  })
  return ['| gate | verdict | result |', '| --- | --- | --- |', ...rows].join('\n')
}

/**
 * The footer sentence. The contract PER-236 pins: this can only read
 * "All gates passed." when nothing failed *and* nothing was a placeholder.
 */
export function renderFooter(report) {
  if (report.failures.length > 0) {
    return (
      `**${report.failures.length} gate(s) not passing.** Merging this PR is a visible choice, ` +
      'not a blocked one — `main` has no required checks (ADR-0004).'
    )
  }
  if (report.pending.length > 0) {
    const one = report.pending.length === 1
    const names = report.pending.map((row) => `\`${row.job}\``).join(', ')
    return (
      `**No gate failed, but ${report.pending.length} of ${report.rows.length} ran nothing.** ` +
      `${names} ${one ? 'is a declared placeholder' : 'are declared placeholders'}: the job ` +
      `exits 0 until the owning issue in the table lands the root script, so ${
        one ? 'its' : 'their'
      } green check is not evidence that anything was checked.`
    )
  }
  return 'All gates passed.'
}

/** The full PR comment body, marker included. */
export function renderPrComment(report, { sha, runUrl }) {
  const rows = report.rows.map((row) => {
    if (row.state === 'pending') {
      return `| \`${row.job}\` | ⏸ pending — ran nothing · owner: ${cell(row.pendingOwner)} |`
    }
    const icon = row.state === 'fail' ? '❌' : '✅'
    const label = { success: 'pass', failure: 'FAIL', cancelled: 'cancelled', skipped: 'skipped' }
    return `| \`${row.job}\` | ${icon} ${cell(label[row.result] ?? row.result)} |`
  })

  return [
    COMMENT_MARKER,
    `### CI gates — \`${sha}\``,
    '',
    '| gate | result |',
    '| --- | --- |',
    ...rows,
    '',
    renderFooter(report),
    '',
    `[Full run](${runUrl}) · a gate marked \`skipped\` other than \`pr-hygiene\` counts as a failure` +
      ' · a gate marked `pending` has no implementation yet and did not run.',
  ].join('\n')
}

/**
 * Reads the inputs both callers share. Exported so `assert-gates.mjs` cannot
 * drift from the comment on how `GATE_RESULTS` is validated.
 */
export function reportFromEnv(env = process.env) {
  const raw = env.GATE_RESULTS
  if (!raw) {
    console.error('::error title=CI gate::GATE_RESULTS is not set. The job is misconfigured.')
    process.exit(2)
  }

  const needs = JSON.parse(raw)
  if (Object.keys(needs).length === 0) {
    console.error('::error title=CI gate::No gates reported. Refusing to report success.')
    process.exit(1)
  }

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  return buildGateReport({ needs, scripts: pkg.scripts, strict: strictGatesEnabled(env) })
}

/**
 * True when this file was invoked directly rather than imported.
 *
 * Compared through `realpathSync` on both sides, not as raw strings: the ESM
 * loader resolves `import.meta.url` through symlinks while `process.argv[1]` is
 * left as given. On macOS `tmpdir()` is `/var/folders/…`, a symlink to
 * `/private/var/folders/…`, so a plain `===` is false for the very same file and
 * the CLI silently prints nothing — which is how `tools/ci-gate` caught this.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

// Guarded so importing this module from `assert-gates.mjs` does not print.
if (invokedDirectly()) {
  const format = process.argv.includes('--format=summary') ? 'summary' : 'pr'
  const report = reportFromEnv()
  if (format === 'summary') {
    console.log(renderSummaryTable(report))
  } else {
    console.log(
      renderPrComment(report, {
        sha: process.env.GATE_SHA ?? 'unknown',
        runUrl: process.env.GATE_RUN_URL ?? '',
      }),
    )
  }
}
