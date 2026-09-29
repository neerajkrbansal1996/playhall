#!/usr/bin/env node
/**
 * The compensating control from ADR-0004 §Decision 2.
 *
 * `main` cannot be protected — the branch-protection and rulesets APIs both
 * return `403 Upgrade to GitHub Pro` on this private repo, and the paid tier is
 * board-gated against a $0 budget. Worse, a paid plan still could not express
 * "require CTO review", because the CTO is a Paperclip agent with no GitHub
 * identity. So the gate cannot prevent a direct push.
 *
 * It can, however, make one loud. This fails the build when the commit pushed
 * to `main` is not reachable from a merged pull request, which turns `main` red
 * within a minute and leaves a permanent marker in the commit list. Detection
 * instead of prevention, stated as such rather than dressed up as a gate.
 *
 * Needs `GITHUB_TOKEN` with `contents: read` and `pull-requests: read`.
 */
import { appendFileSync } from 'node:fs'

const repo = process.env.GITHUB_REPOSITORY
const sha = process.env.GITHUB_SHA
const token = process.env.GITHUB_TOKEN
const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const actor = process.env.GITHUB_ACTOR ?? 'unknown'

if (!repo || !sha || !token) {
  console.error(
    '::error title=Push audit misconfigured::GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_TOKEN are all required.',
  )
  process.exit(2)
}

const response = await fetch(`${apiUrl}/repos/${repo}/commits/${sha}/pulls`, {
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  },
})

if (!response.ok) {
  // Cannot prove a violation, so do not claim one — but do not silently pass
  // either, because a control that fails open is not a control.
  console.error(
    `::error title=Push audit could not run::GitHub returned HTTP ${response.status} for ` +
      `commits/${sha}/pulls. The audit is inconclusive, which is itself a failure: ` +
      'ADR-0004 relies on this check actually running.',
  )
  process.exit(1)
}

const pulls = await response.json()
const merged = pulls.filter((pull) => pull.merged_at !== null)

// The very first commit on a fresh repo has no PR and never can. Treat a commit
// with no parents as exempt rather than leaving `main` permanently red.
const commit = await fetch(`${apiUrl}/repos/${repo}/commits/${sha}`, {
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  },
}).then((r) => (r.ok ? r.json() : null))

if (commit && Array.isArray(commit.parents) && commit.parents.length === 0) {
  console.log(`::notice title=Push audit skipped::${sha} is the root commit and predates any PR.`)
  process.exit(0)
}

if (merged.length === 0) {
  const open = pulls.filter((pull) => pull.merged_at === null).map((pull) => `#${pull.number}`)
  console.error(
    `::error title=Unreviewed push to main::Commit ${sha} is not reachable from any merged pull ` +
      `request (pushed by @${actor}). ` +
      (open.length > 0 ? `Associated but unmerged: ${open.join(', ')}. ` : '') +
      'Every change to `main` goes through a PR with a linked Paperclip issue and CTO review ' +
      '(ADR-0004). `main` cannot be protected on this plan, so this check is the record. ' +
      'Open a PR for this change retroactively and note it on the issue — do not simply re-push.',
  )
  summarise(
    `## Unreviewed push to \`main\`\n\n` +
      `Commit \`${sha.slice(0, 7)}\` by @${actor} reached \`main\` without a merged PR. ` +
      `See [ADR-0004](../blob/main/docs/adr/0004-pr-gate-without-branch-protection.md).\n`,
  )
  process.exit(1)
}

const via = merged.map((pull) => `#${pull.number}`).join(', ')
console.log(`Push audit OK — ${sha.slice(0, 7)} arrived via merged PR ${via}.`)
summarise(`## Push audit\n\n\`${sha.slice(0, 7)}\` arrived via merged PR ${via}.\n`)

function summarise(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  } catch {
    // A summary must never be the reason the audit reports the wrong answer.
  }
}
