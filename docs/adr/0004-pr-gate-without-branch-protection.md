# ADR-0004: Enforcing the PR gate without branch protection

- **Status:** Accepted
- **Date:** 2026-09-30
- **Author:** CTO
- **Milestone:** M0
- **Issue:** [PER-3](/PER/issues/PER-3) (arising from [PER-35](/PER/issues/PER-35), implemented in [PER-6](/PER/issues/PER-6))

## Context

[PER-2](/PER/issues/PER-2) §12 requires that every pull request carry a linked issue, a
description, tests, a screenshot or GIF for UI, **CTO review**, and green CI including the
boundary rules and the conformance testkit. Until now we assumed that requirement would be
enforced by GitHub branch protection on `main`.

It cannot be. Three facts closed that off, and they compound:

1. **GitHub refuses the APIs.** Both the branch-protection API and the newer rulesets API
   return `403 Upgrade to GitHub Pro` for a private repository on this account's plan.
   Protection of a private branch is a paid feature.
2. **The paid tier is board-gated and, on inspection, would not buy the thing we want.** Any
   paid service needs board approval and the standing infrastructure budget is **$0**. More
   importantly — see "Alternatives" — even a paid plan could not express "require CTO review",
   because the CTO is a Paperclip agent with **no GitHub identity**. A `CODEOWNERS` entry naming
   it would be inert. Money would buy "require _some_ review" and "require green CI", not the
   rule §12 actually states.
3. **Going public is not available as a workaround.** Protection is free on public repos, but
   the board chose private deliberately, and [PER-2](/PER/issues/PER-2) §11 gates public
   announcements. Opening the repository before launch _is_ a public announcement.

So the gate is unenforceable at the point of merge, for reasons that are not going to change
inside M0. The choice in front of us is not "protection or no protection" — it is whether the
gap is written down with a compensating control, or left as an unstated assumption that
everybody believes is handled.

Current exposure is low and will not stay low: exactly one engineer is merging today. The risk
is a step function at the second concurrent merger.

## Decision

**1. `main` stays unprotected through M0–M4. This is an accepted risk, not an open problem.**
Revisited at M5 (see triggers). Nobody should spend further time looking for a free workaround;
the three facts above are the answer.

**2. The gate moves from prevention to detection, and detection must be mechanical.** Add a CI
workflow triggered on `push` to `main` that fails when the pushed commit is not reachable from
a merged pull request. A direct push therefore turns `main` red within a minute and is visible
in the commit list forever. This does not stop the push — nothing available to us does — but it
converts a silent policy violation into a loud one. Implemented in
[PER-6](/PER/issues/PER-6).

**3. CI runs on `pull_request` for every PR regardless of the fact that it cannot be
_required_.** "Green CI" stays observable even when it is not mandatory. An engineer merging a
red PR is then making a visible choice rather than an invisible one.

**4. The PR description must link its Paperclip issue, and that link is load-bearing.** With no
GitHub review record, the Paperclip issue thread _is_ the audit trail for §12. A PR without the
link is unreviewable after the fact, so the missing link is a review defect, not a formatting
nit.

**5. Releases are cut from tags, never from "whatever is on `main`".** This is the containment:
an unreviewed commit reaching `main` cannot become a release without a human cutting a tag.
Without it, the blast radius of one bad push is production.

## Alternatives considered

- **Upgrade to a paid GitHub plan.** Lost on two counts, and the second matters more than the
  first. It needs board approval against a $0 budget — but even if funded, it cannot express
  "require CTO review" because the required reviewer has no GitHub account. We would be paying
  for a weaker rule than the one we wrote down. _Cost not verified_; GitHub's 403 names "Pro",
  and private-repo protection has historically sat on the Team tier at a low single-digit
  dollar per-user monthly price. Nobody should quote that number to the board without checking
  it, because we are not recommending the purchase.
- **Make the repository public now to get protection for free.** Lost: contradicts a
  deliberate board decision on [PER-35](/PER/issues/PER-35) and trips the §11 announcement
  gate. Trading a governance decision for a CI feature is the wrong direction.
- **`CODEOWNERS` naming the CTO as required reviewer.** Lost twice over: `CODEOWNERS` is only
  _enforced_ by branch protection, which we do not have, and the entry would name a
  non-existent GitHub user. It would be a file that looks like a control and is not one — worse
  than nothing, because it invites the belief that the gate exists.
- **Trust and a written process doc, with no mechanism.** Lost for the same reason ADR-0002
  rejected review-only boundary enforcement: the required reviewer is the last line of defence,
  not the only one. It also degrades exactly when load increases, which is the worst failure
  profile available.
- **Convention that only one engineer ever pushes to `main`.** Lost: it is a bottleneck by M1,
  it does not survive the second engineer, and it detects nothing — an accidental push by the
  designated merger looks identical to a correct one.
- **A pre-push git hook refusing direct pushes to `main`.** Lost: hooks are local, per-clone,
  and bypassable with `--no-verify`, which our own standards forbid but cannot prevent. Useful
  as a courtesy, worthless as a gate. Not rejected outright — it may be added as convenience,
  but it must never be described as the control.

## Evidence

- `403 Upgrade to GitHub Pro` from both the branch-protection and rulesets endpoints on
  `neerajkrbansal1996/playhall` (private). Observed on [PER-35](/PER/issues/PER-35).
- Standing infrastructure budget: **$0** — board answer on [PER-2](/PER/issues/PER-2).
- CTO GitHub identity: none. `CODEOWNERS` enforcement additionally requires branch protection.
- Engineers currently able to merge: **1**. The compensating control exists for the moment that
  becomes 2 or more, which is expected during M1.
- **Measurement owed:** the actual cost of the plan that grants private-branch protection, to
  be gathered only if the board asks to reconsider. Owner: CTO. Not gathered now, because the
  recommendation is not to buy.

## Consequences

**Easier**

- No spend, no vendor decision, no premature repo exposure. The cheapest reversible option.
- One place to look when asking "was this reviewed?" — the Paperclip issue — rather than two
  partially-overlapping records.

**Harder, and we should say so plainly**

- A direct push to `main` is **detected, not prevented**. There is a window between the push
  and the red build in which `main` is wrong and looks fine.
- The §12 audit trail lives outside the repository. A future contributor, or anyone with only
  the git history, cannot reconstruct who reviewed what. Decision 4 is what keeps this
  recoverable, and it depends on engineers actually writing the link.
- "CTO review" is enforced entirely by Paperclip workflow. If an engineer merges without it,
  the platform will not stop them and the repo will not record the omission — only the missing
  issue-thread approval will.
- We are accepting a control gap for four milestones. That is a real decision with a real cost,
  not a technicality.

## Revisit triggers

- **Two or more engineers merging to `main` in the same milestone** → re-raise immediately;
  this is the trigger the compensating control was built for, and it may justify escalating
  for the paid tier despite its weakness.
- **The repository goes public at M5** → branch protection becomes free. Adopt it the same day:
  require green CI and a PR, and supersede this ADR.
- **An unreviewed commit actually reaches `main`** → this ADR's detection worked and its
  prevention did not. Escalate to the board with the incident rather than re-arguing the
  design.
- **Board approves any GitHub spend for another reason** → fold protection into it, with the
  caveat from "Alternatives" that it still cannot require _CTO_ review.
- **A CTO GitHub identity is ever created** → re-evaluate `CODEOWNERS`, which becomes
  meaningful for the first time.
