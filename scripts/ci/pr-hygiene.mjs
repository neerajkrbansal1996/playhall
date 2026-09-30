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
 * The third rule — CTO review on every PR — cannot be checked here, and cannot
 * be checked anywhere. A required reviewer is branch protection, which needs a
 * plan the board has declined; and a required *review* rule additionally needs
 * a second GitHub identity, because one account cannot approve its own PR and a
 * single-identity repo would deadlock rather than gate. There is deliberately
 * no CODEOWNERS file: without protection it requests a reviewer it cannot
 * require, and a control that cannot fail is worse than a missing one, because
 * the next person reads the file and stops looking. See docs/ci-cd.md.
 *
 * Reads the event payload from GITHUB_EVENT_PATH so it needs no API token.
 */
import { readFileSync } from 'node:fs'

/**
 * A *deliberate* link to a Paperclip issue: either the `Paperclip-Issue:`
 * trailer the PR template ships, or a `/{PREFIX}/issues/{ID}` UI link.
 *
 * Not a bare `\b[A-Z]+-\d+\b`. That matched three things the author never
 * chose: the id inside the template's own HTML comment (so an untouched
 * template passed), any `ADR-0004` reference, and any upstream id quoted in
 * prose. The check has to be able to fail, or it is decoration.
 */
const PAPERCLIP_ISSUE =
  /(^[ \t]*Paperclip-Issue:[ \t]*[A-Z][A-Z0-9]{1,9}-\d+\b)|(\/[A-Z][A-Z0-9]{1,9}\/issues\/[A-Z][A-Z0-9]{1,9}-\d+\b)/m

/**
 * Markdown/HTML comments. Stripped before the link check so the template's own
 * instructions cannot satisfy the rule they describe.
 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g

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

const title = pr.title ?? ''
// Strip the template's commentary first: an author who fills in nothing must
// fail, and the unedited template contains both a `PER-6` example and a
// `Paperclip-Issue:` label inside its HTML comment.
const body = (pr.body ?? '').replace(HTML_COMMENT, '')
const failures = []

if (!PAPERCLIP_ISSUE.test(body)) {
  failures.push(
    'No linked issue. Add the trailer `Paperclip-Issue: PER-6` on its own line, or link the ' +
      'issue as `[PER-6](/PER/issues/PER-6)`. A bare mention in prose, an `ADR-…` reference, ' +
      'or the id left inside the template’s HTML comment does not count — the link has to ' +
      'be something you chose.',
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
