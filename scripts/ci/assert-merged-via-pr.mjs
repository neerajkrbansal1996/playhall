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
 * Scope: pushes to `main` only. Any other event or ref is reported as not
 * applicable and passes — see the exemption below for why that is a pass rather
 * than a skipped job.
 *
 * Needs `GITHUB_TOKEN` with `contents: read` and `pull-requests: read`.
 */
import { appendFileSync } from 'node:fs'

const repo = process.env.GITHUB_REPOSITORY
const sha = process.env.GITHUB_SHA
const token = process.env.GITHUB_TOKEN
const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const actor = process.env.GITHUB_ACTOR ?? 'unknown'
const eventName = process.env.GITHUB_EVENT_NAME
const ref = process.env.GITHUB_REF

// The control covers two deploy-bearing refs: a commit *reaching `main`*
// (staging, `main.yml`) and a *tag* (production, `release.yml`). `main.yml`
// also offers `workflow_dispatch`, which is the only way to re-exercise the
// staging deploy without landing a new commit — and a dispatched branch commit
// has no merged PR by construction, so auditing one is a false positive.
//
// Three things about the shape of this exemption are deliberate:
//
// 1. It lives in the script, not in a job-level `if:` on `push-audit`. The
//    staging jobs list `push-audit` in `needs:`, and a skipped job skips its
//    dependents — guarding the job would take staging down with it, which is
//    the exact thing the exemption exists to keep reachable. Passing keeps the
//    dependency edge satisfied.
// 2. A missing `GITHUB_EVENT_NAME`/`GITHUB_REF` is a misconfiguration, not an
//    exemption. Actions always sets both, so their absence means this is not
//    the environment the audit was written for, and inferring "exempt" from
//    that would let the control fail open — the same failure mode the HTTP
//    error path below already refuses.
// 3. **A tag is never exempt, whatever the event.** Scoping this to
//    `push`-to-`main` alone looks right and quietly disarms production: a `v*`
//    tag push is `push` on `refs/tags/...`, so the release audit would report
//    "not applicable" and exit 0 while its step still claimed to assert the
//    tagged commit arrived via a merged PR. That restores the exact bypass the
//    release-side audit exists to close — push straight to `main`, ignore the
//    red `main.yml` audit, tag that commit, ship it — and it would only ever
//    have been noticed on a real production cut. `workflow_dispatch` on a tag
//    is audited for the same reason.
if (!eventName || !ref) {
  console.error(
    '::error title=Push audit misconfigured::GITHUB_EVENT_NAME and GITHUB_REF are both ' +
      'required. Refusing to treat their absence as an exemption — ADR-0004 relies on this ' +
      'check actually running.',
  )
  process.exit(2)
}

const isTag = ref.startsWith('refs/tags/')
const isPushToMain = eventName === 'push' && ref === 'refs/heads/main'

if (!isTag && !isPushToMain) {
  console.log(
    `::notice title=Push audit not applicable::ADR-0004 audits commits reaching \`main\` and ` +
      `every tag; this run is \`${eventName}\` on \`${ref}\`, which deploys nothing. There is ` +
      'nothing to audit, so the job passes and the jobs that depend on it proceed.',
  )
  summarise(
    `## Push audit\n\nNot applicable — \`${eventName}\` on \`${ref}\`. ` +
      'ADR-0004 audits commits reaching `main` and every tag.\n',
  )
  process.exit(0)
}

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
