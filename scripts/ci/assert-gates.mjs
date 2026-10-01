#!/usr/bin/env node
/**
 * The body of the `ci-gate` aggregate job.
 *
 * `ci-gate` exists so branch protection only ever needs to require **one**
 * check name. That makes it the single point where "did CI pass?" is decided,
 * so the logic lives in a reviewable, testable file rather than inline YAML.
 *
 * Reads `GATE_RESULTS` = `toJSON(needs)`, i.e. `{ "<job>": { "result": "..." } }`.
 *
 * A `skipped` gate fails the build unless the job is in `SKIP_ALLOWED`. This is
 * the important part: GitHub reports a skipped job as *not failed*, so a job
 * accidentally given an `if:` that never matches would silently stop gating
 * while the required check stayed green.
 *
 * The verdict itself comes from `gate-report.mjs`, shared with the PR comment, so
 * the two cannot disagree about what a row means — which is how a PENDING
 * placeholder came to read as a pass in both (PER-236). A PENDING gate still
 * exits 0 here: turning placeholders into failures is `CI_STRICT_GATES`'s job
 * (PER-98), and doing it here instead would take every PR red today. What
 * changed is that the run now *says* a placeholder ran nothing.
 */
import { appendFileSync } from 'node:fs'

import { renderFooter, renderSummaryTable, reportFromEnv } from './gate-report.mjs'

const report = reportFromEnv()
const table = renderSummaryTable(report)

console.log(table)

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## CI gate\n\n${table}\n\n${renderFooter(report)}\n`,
  )
}

if (report.failures.length > 0) {
  const detail = report.failures.map((row) => `${row.job}: ${row.result}`).join(', ')
  console.error(`::error title=CI gate::Gates did not pass — ${detail}`)
  process.exit(1)
}

if (report.pending.length > 0) {
  // A notice, not a warning: this is a declared, owned state, not a surprise.
  // It exists so the Actions log agrees with the PR comment about what was and
  // was not proven.
  const names = report.pending.map((row) => `${row.job} (owner: ${row.pendingOwner})`).join('; ')
  console.log(
    `::notice title=CI gate::${report.pending.length} of ${report.rows.length} gates are ` +
      `placeholders that ran nothing — ${names}`,
  )
  console.log(
    `ci-gate: ${report.rows.length - report.pending.length} of ${report.rows.length} gates ` +
      `passed; ${report.pending.length} pending.`,
  )
} else {
  console.log(`ci-gate: all ${report.rows.length} gates passed.`)
}
