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
 * A `skipped` gate fails the build unless the job is in SKIP_ALLOWED. This is
 * the important part: GitHub reports a skipped job as *not failed*, so a job
 * accidentally given an `if:` that never matches would silently stop gating
 * while the required check stayed green.
 */
import { appendFileSync } from 'node:fs'

/** Jobs that legitimately do not run on every event. */
const SKIP_ALLOWED = new Set([
  // Only runs on `pull_request`; there is no PR body to check on push or in a
  // merge group.
  'pr-hygiene',
])

const raw = process.env.GATE_RESULTS
if (!raw) {
  console.error('::error title=CI gate::GATE_RESULTS is not set. The job is misconfigured.')
  process.exit(2)
}

const needs = JSON.parse(raw)
const entries = Object.entries(needs)

if (entries.length === 0) {
  console.error('::error title=CI gate::No gates reported. Refusing to report success.')
  process.exit(1)
}

const rows = []
const failures = []

for (const [job, info] of entries.sort(([a], [b]) => a.localeCompare(b))) {
  const result = info?.result ?? 'unknown'
  const ok = result === 'success' || (result === 'skipped' && SKIP_ALLOWED.has(job))
  if (!ok) failures.push(`${job}: ${result}`)
  rows.push(`| \`${job}\` | ${ok ? 'pass' : 'FAIL'} | ${result} |`)
}

const table = ['| gate | verdict | result |', '| --- | --- | --- |', ...rows].join('\n')
console.log(table)

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI gate\n\n${table}\n`)
}

if (failures.length > 0) {
  console.error(`::error title=CI gate::Gates did not pass — ${failures.join(', ')}`)
  process.exit(1)
}

console.log(`ci-gate: all ${entries.length} gates passed.`)
