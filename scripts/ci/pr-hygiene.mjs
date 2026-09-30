#!/usr/bin/env node
/**
 * Enforces the two PR rules from PER-6 that are mechanically checkable:
 *
 *   1. The PR description links a Paperclip issue. "Every PR: linked issue" is
 *      a standard; a standard nobody checks is a suggestion. Without the link
 *      there is no path from a commit back to the decision that caused it.
 *   2. The PR title is a conventional commit. The repo already enforces this on
 *      commit messages via husky + commitlint, but a squash-merge takes the *PR
 *      title* as the commit subject, so an unchecked title defeats the hook and
 *      breaks the generated CHANGELOG.
 *
 * The third rule — CTO review on every PR — cannot be checked here. A required
 * reviewer is branch protection plus CODEOWNERS, and branch protection is
 * unavailable on this repo's current GitHub plan (see docs/ci-cd.md). The
 * CODEOWNERS file and this job are the parts that work today; the protection
 * rule switches on later with no change to either.
 *
 * Reads the event payload from GITHUB_EVENT_PATH so it needs no API token.
 */
import { readFileSync } from 'node:fs'

/** Paperclip issue id, e.g. PER-6. Matches a bare id or one inside a markdown link. */
const PAPERCLIP_ISSUE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/
/** Conventional commit subject: `type(optional-scope)!: summary`. */
const CONVENTIONAL_TITLE =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]+\))?!?: .+/

const eventPath = process.env.GITHUB_EVENT_PATH
if (!eventPath) {
  console.error('GITHUB_EVENT_PATH is not set — this script only runs on a pull_request event.')
  process.exit(2)
}

const event = JSON.parse(readFileSync(eventPath, 'utf8'))
const pr = event.pull_request
if (!pr) {
  console.log('::notice title=PR hygiene skipped::Not a pull_request event.')
  process.exit(0)
}

const body = pr.body ?? ''
const title = pr.title ?? ''
const failures = []

if (!PAPERCLIP_ISSUE.test(body)) {
  failures.push(
    'No linked issue. Put the Paperclip issue id in the PR description, e.g. ' +
      '`Paperclip-Issue: PER-6` or `Closes [PER-6](/PER/issues/PER-6)`.',
  )
}

if (!CONVENTIONAL_TITLE.test(title)) {
  failures.push(
    `PR title "${title}" is not a conventional commit. Expected \`type(scope): summary\`, ` +
      'e.g. `ci(actions): add boundary gate`. The squash-merge commit subject is taken from ' +
      'this title, so commitlint cannot catch it for you.',
  )
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`::error title=PR hygiene::${failure}`)
  }
  process.exit(1)
}

console.log('PR hygiene OK — title is conventional and the description links an issue.')
