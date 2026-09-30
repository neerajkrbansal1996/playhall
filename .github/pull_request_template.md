<!--
  The `pr-hygiene` CI job fails this PR unless:
    * the `Paperclip-Issue:` trailer below carries a real issue id, or the
      description links one as `[PER-6](/PER/issues/PER-6)`. Everything in an
      HTML comment is stripped before that check, so leaving this template
      untouched fails — which is the point.
    * the PR *title* is a conventional commit (`type(scope): summary`) — the
      squash-merge subject comes from the title, so commitlint cannot catch it.
-->

Paperclip-Issue: PER-

## What changed

<!-- One paragraph. What a reviewer needs to know before reading the diff. -->

## Why

<!-- The decision or requirement this satisfies. Link the ADR if there is one. -->

## Evidence

<!--
  Not "tests added" — the actual result. Paste the command and its output.
  For anything performance-sensitive, the measured number (see AGENTS.md):
    * timer change        -> measured clock drift over 5 minutes
    * persistence change  -> migration is non-destructive + a live match survived a restart
    * action path         -> p95 round-trip
    * boundary rule set   -> dependency-cruiser runtime on the full graph
  For UI, a screenshot or GIF.
-->

## Not covered

<!-- What this deliberately leaves out, and who owns it. -->

## Checklist

- [ ] Linked issue is in the description above
- [ ] Tests cover the change (>= 80% on `platform-core`, `game-sdk`, `netcode`, game rules)
- [ ] Boundary rules pass — no game imports platform internals or another game
- [ ] No `Date.now()` / `Math.random()` / I/O added inside a game module or its reducers
- [ ] Every new JSON message or HTTP input has a `zod` schema
- [ ] No brand string hard-coded — read it from `@playhall/shared`'s `BRAND`
- [ ] No new Redis key without a TTL and a documented lifecycle
- [ ] CTO review requested
