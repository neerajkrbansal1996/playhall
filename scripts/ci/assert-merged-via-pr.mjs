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
 * It can, however, make one loud. This fails the build when the audited commit
 * did not *arrive* via a merged pull request, which turns `main` red within a
 * minute and leaves a permanent marker in the commit list. Detection instead of
 * prevention, stated as such rather than dressed up as a gate.
 *
 * **"Arrived via", not "belongs to" (PER-130).** The obvious predicate — any
 * associated PR with a non-null `merged_at` — answers the wrong question. It
 * asks "does this commit *belong* to a merged PR?", and under squash-merge the
 * two questions come apart: every commit that sat on a merged PR's head branch
 * keeps its association forever, even though the squash threw it away and it
 * never reached `main`. Measured against the live API on 2026-09-30:
 *
 *   d79f02e  head of PR #43 before its squash
 *     commits/d79f02e/pulls  ->  #43, merged, merge_commit_sha 45aa812
 *     ancestor of origin/main?  ->  NO
 *
 * So the loose predicate calls `d79f02e` reviewed-and-landed when it is neither.
 * `merge_commit_sha` is the discriminator and it is already in the response:
 * a commit arrived via PR *p* exactly when it is `p.merge_commit_sha` or an
 * ancestor of it. That is checked with `compare/{sha}...{merge_commit_sha}` —
 * `identical` or `ahead` means arrival.
 *
 * Bare equality (`merge_commit_sha === GITHUB_SHA`) is the tempting one-liner
 * and it false-fails real history. This repo allows squash, merge-commit *and*
 * rebase merges, and under either of the latter two a PR puts several commits on
 * `main` while only the tip equals `merge_commit_sha`. Measured, same repo:
 *
 *   ee460b0  head of PR #56, which was merged as the merge commit 1452723
 *     ancestor of origin/main?                 ->  YES
 *     merge_commit_sha === ee460b0?            ->  no  (would false-fail)
 *     compare ee460b0...1452723                ->  ahead  (arrival, correct)
 *
 * A detector that cries wolf gets ignored, which is the failure mode ADR-0004
 * exists to avoid — so the ancestry test is the predicate, and no restriction of
 * the repo's merge methods is needed to make it correct.
 *
 * Scope: the two deploy-bearing refs — a `push` to `main` (staging) and *any*
 * tag, on any event (production). Narrowing this to `push`-to-`main` alone
 * disarms the release-side audit, because a `v*` tag push is `push` on
 * `refs/tags/...`; see point 3 of the exemption below before touching it.
 * Anything else is reported as not applicable and passes — see point 1 for why
 * that is a pass rather than a skipped job.
 *
 * Needs `GITHUB_TOKEN` with `contents: read` and `pull-requests: read`.
 */
import { appendFileSync, readFileSync } from 'node:fs'

const repo = process.env.GITHUB_REPOSITORY
const sha = process.env.GITHUB_SHA
const token = process.env.GITHUB_TOKEN
const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
// `||`, not `??`: Actions sets this to the empty string rather than unsetting it
// in some contexts, and `@` is not a name anyone can act on.
const actor = process.env.GITHUB_ACTOR || 'unknown'
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

// The residual path PER-130 named: a *force*-push to `main`. A squashed-away
// PR-head commit can only land on `main` as-is if its parent is already `main`'s
// tip, which after a squash it is not — so the push has to be non-fast-forward.
// `forced` and `before` are in the `push` event payload and the audit used to
// ignore them entirely.
//
// Reported as its own failure rather than folded into the PR verdict, because it
// is a different fact with a different remedy: the arrival check says "this
// commit did not come from a PR", this says "whatever was on `main` before is
// gone". Nothing in this repo's conventions force-pushes `main` — merging a PR
// never does — so there is no legitimate case to false-fail.
//
// A payload that cannot be read is a `::warning`, not a failure. The arrival
// predicate below is the hard control and it independently catches this same
// residual path (a force-pushed PR-head commit is not an ancestor of its PR's
// `merge_commit_sha`), so treating an unreadable payload as a violation would
// trade a real detection for a false one.
let forcedPush = false
if (isPushToMain) {
  const eventPath = process.env.GITHUB_EVENT_PATH
  let event = null
  try {
    event = eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : null
  } catch {
    event = null
  }

  if (!event || typeof event.forced !== 'boolean') {
    console.log(
      '::warning title=Force-push check skipped::Could not read `forced` from the `push` event ' +
        'payload (GITHUB_EVENT_PATH), so this run cannot say whether `main` was force-pushed. ' +
        'The arrival check below still ran.',
    )
  } else if (event.forced) {
    forcedPush = true
    const before = typeof event.before === 'string' ? event.before : 'unknown'
    console.error(
      `::error title=Force-push to main::@${actor} force-pushed \`main\`; it previously pointed ` +
        `at ${before}. History on the one deploy-bearing branch was rewritten, so the commits ` +
        'between there and now are no longer on `main` and no PR records their removal ' +
        '(ADR-0004). Restore `main` to ' +
        `${before.slice(0, 7)} and land the change as a PR instead.`,
    )
    summarise(
      `## Force-push to \`main\`\n\n@${actor} force-pushed \`main\` from ` +
        `\`${before.slice(0, 7)}\` to \`${sha.slice(0, 7)}\`. ` +
        `See [ADR-0004](../blob/main/docs/adr/0004-pr-gate-without-branch-protection.md).\n`,
    )
  }
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
  finish(0)
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

// A merged association is necessary but not sufficient — see the header. Now ask
// the question the control is cited for: did this commit arrive *via* one of
// them? Equality is checked first so the overwhelmingly common case (the squash
// or merge commit itself) costs no extra API call.
const arrived = []
const stranded = []

for (const pull of merged) {
  if (typeof pull.merge_commit_sha !== 'string' || pull.merge_commit_sha.length === 0) {
    // A merged PR always has one. Its absence means the response is not the
    // shape this predicate reasons about, and guessing "arrived" would be the
    // fail-open the rest of this script refuses.
    stranded.push({ pull, status: 'no merge_commit_sha' })
    continue
  }
  if (pull.merge_commit_sha === sha) {
    arrived.push(pull)
    continue
  }

  const status = await compareStatus(pull.merge_commit_sha)
  if (status === null) {
    console.error(
      `::error title=Push audit could not run::GitHub would not compare ${sha.slice(0, 7)} with ` +
        `#${pull.number}'s merge commit ${pull.merge_commit_sha.slice(0, 7)}. Without that the ` +
        'audit cannot tell arrival from mere PR membership, which is inconclusive — and an ' +
        'inconclusive audit is a failure, not a pass (ADR-0004).',
    )
    process.exit(1)
  }
  // `ahead` = the merge commit is ahead of this commit, i.e. this commit is an
  // ancestor of it: exactly the rebase-merge and merge-commit cases.
  if (status === 'identical' || status === 'ahead') arrived.push(pull)
  else stranded.push({ pull, status })
}

if (arrived.length === 0) {
  const detail = stranded
    .map(
      ({ pull, status }) =>
        `#${pull.number} (merged as ${String(pull.merge_commit_sha).slice(0, 7)}, ` +
        `compare: ${status})`,
    )
    .join(', ')
  console.error(
    `::error title=Unreviewed push to main::Commit ${sha} belongs to a merged pull request but ` +
      `did not arrive on this ref through it (pushed by @${actor}): ${detail}. A commit that sat ` +
      "on a merged PR's head branch keeps that association even when the squash discarded it, so " +
      'PR membership alone does not mean the commit was ever merged. Every change to `main` goes ' +
      'through a PR with a linked Paperclip issue and CTO review (ADR-0004). `main` cannot be ' +
      'protected on this plan, so this check is the record. Land this commit through a PR — do ' +
      'not simply re-push.',
  )
  summarise(
    `## Unreviewed push to \`main\`\n\n` +
      `Commit \`${sha.slice(0, 7)}\` by @${actor} is associated with ${detail} but did not arrive ` +
      'via any of them. ' +
      `See [ADR-0004](../blob/main/docs/adr/0004-pr-gate-without-branch-protection.md).\n`,
  )
  process.exit(1)
}

const via = arrived.map((pull) => `#${pull.number}`).join(', ')
console.log(`Push audit OK — ${sha.slice(0, 7)} arrived via merged PR ${via}.`)
summarise(`## Push audit\n\n\`${sha.slice(0, 7)}\` arrived via merged PR ${via}.\n`)
finish(0)

/**
 * `identical` / `ahead` / `behind` / `diverged` for `sha...head`, or `null` when
 * GitHub would not answer. `ahead` means `head` is ahead of `sha`.
 *
 * @param {string} head
 */
async function compareStatus(head) {
  const result = await fetch(`${apiUrl}/repos/${repo}/compare/${sha}...${head}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  })
  if (!result.ok) return null
  const body = await result.json()
  return typeof body.status === 'string' ? body.status : null
}

/** Exits, but never with 0 while an unreported force-push to `main` stands. */
function finish(code) {
  process.exit(code === 0 && forcedPush ? 1 : code)
}

function summarise(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  } catch {
    // A summary must never be the reason the audit reports the wrong answer.
  }
}
