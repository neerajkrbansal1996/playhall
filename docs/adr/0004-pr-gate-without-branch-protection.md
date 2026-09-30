# ADR-0004: Enforcing the PR gate without branch protection

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amended:** 2026-09-30 (rev 2) — **the review half of §12 is weaker than rev 1 said.** Rev 1
  recorded that "CTO review" could not be _enforced_ because the CTO has no GitHub identity. What
  [PER-77](/PER/issues/PER-77) found is worse: the CTO acts on GitHub _through the repo owner's
  account_, so every review is a self-review and GitHub refuses it outright. The CTO cannot record
  a review **verdict of any kind on a PR** — not an enforced one, not an advisory one. Rev 1's
  Decision 4 therefore carries far more weight than rev 1 gave it. Rev 2 adds **Decision 6** (a
  machine-readable verdict marker) and **Decision 7** (the merge-time gate is advisory by
  decision, not by drift). Decisions 1–5 stand unchanged. New section:
  [Rev 2 — the review verdict](#rev-2--the-review-verdict).
- **Author:** CTO
- **Milestone:** M0
- **Issue:** [PER-3](/PER/issues/PER-3) (arising from [PER-35](/PER/issues/PER-35), implemented in [PER-6](/PER/issues/PER-6)); rev 2 on [PER-78](/PER/issues/PER-78)

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

**Rev 2 —** fact 2 above understates the problem, and the correction matters. Rev 1 said the CTO
has "no GitHub identity", which reads as _absent_ — a reviewer who simply cannot be named. The
reality is _colliding_: the CTO acts on GitHub through the repo owner's account, the same account
that authors every PR. GitHub refuses a verdict on your own pull request, so the reviewer is not
missing from the review UI, it is **indistinguishable from the author**. Rev 1 concluded review
could not be _required_; the true conclusion is that review cannot be _recorded on the PR at all_.
See [Rev 2 — the review verdict](#rev-2--the-review-verdict).

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

> **Rev 2 —** this decision is load-bearing in a way rev 1 did not realise. Rev 1 wrote "with no
> GitHub review record" as an aside. It is not an aside: the Paperclip issue thread is not merely
> the _better_ record of a review verdict, it is the **only place a verdict can exist**. A PR
> missing its issue link is therefore not "unreviewable after the fact" — it is unreviewable
> full stop, because there is nowhere else the verdict could have been written. Treat a missing
> link as a blocking defect, not a review defect.

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

## Rev 2 — the review verdict

### What we found

Reviewing [PR #23](https://github.com/neerajkrbansal1996/playhall/pull/23) on
[PER-77](/PER/issues/PER-77), the blocking verdict could not be submitted. Every PR and every
review on this repository resolves to one account, `neerajkrbansal1996`, and GitHub refuses a
verdict on your own pull request:

```
POST /repos/neerajkrbansal1996/playhall/pulls/23/reviews  event=APPROVE
  422  Review Can not approve your own pull request
POST /repos/neerajkrbansal1996/playhall/pulls/23/reviews  event=REQUEST_CHANGES
  422  Review Can not request changes on your own pull request
```

The verdict had to go out as an ordinary conversation comment labelled "this is the review". That
worked only because a human read it. Across all 27 PRs on the repo, `reviews` is empty and
`reviewDecision` is `""` — there is no review record anywhere in this repository's history.

This is not cosmetic. PR #23's blocking defect — a cherry-picked ADR-0001 section contradicting
the rev 2 section directly above it — passed lint, format, typecheck and the full test suite.
Review prose was the only thing between that defect and `main`, and review prose is precisely the
part nothing mechanical reads.

### The constraint that decides this

**Nothing available to us can block a merge, and a second reviewer identity would not change
that.** On PR #23, with zero reviews and zero approvals:

```
mergeable: MERGEABLE    mergeStateStatus: CLEAN    reviewDecision: null
```

`mergeStateStatus` is `CLEAN` because blocking a merge on a review is a **branch-protection**
feature, and branch protection is exactly what rev 1 established we cannot have (`403 Upgrade to
GitHub Pro`, re-confirmed on both the protection and rulesets endpoints for rev 2). A
`CHANGES_REQUESTED` review on an unprotected branch shows a warning and leaves the merge button
green. So option 1 below does not restore a gate; it restores a **label**. The issue that raised
this rev asked which option restores blocking. The answer is none of them, and saying so is the
substance of this amendment.

### Decision 6 — the verdict is a machine-readable trailer in the PR body, checked by CI

Add a `verdict` step to the existing `pr-hygiene` job (it already runs `scripts/ci/pr-hygiene.mjs`
and already feeds the `ci-gate` aggregation). It fails the PR unless the description carries a
trailer naming a verdict and pointing at where the verdict actually lives:

```
CTO-VERDICT: approved
CTO-REVIEW: <url of the Paperclip issue comment holding the review>
```

Accepted values are `approved` and `changes-requested`; anything else, or a missing trailer, or a
`CTO-REVIEW` url that does not resolve to the PR's linked issue, fails the check. Exact spec and
implementation are owned by the follow-up issue, blocked on the CI pipeline landing
([PER-6](/PER/issues/PER-6), PR #25 — note PR #8 in the rev 2 issue text is closed and superseded).

Be exact about what this buys: **it gates process, not judgement.** The trailer is written by the
same account that authors the PR, so it is self-attestable and always will be. What it converts is
the failure mode — "nobody remembered to review this" stops being silent and becomes a red check,
which is the same prevention-to-detection move as Decision 2. It cannot detect "reviewed badly".

### Decision 7 — merge-time review enforcement is advisory in v1, by decision

Write it down rather than leaving it as the thing everyone assumes is handled: through M0–M4 the
CTO review requirement in [PER-2](/PER/issues/PER-2) §12 is enforced by Paperclip workflow and by
Decision 6's marker, and **not** at the point of merge. The authoritative review record is the
Paperclip issue thread (Decision 4), not the PR. Anyone auditing §12 compliance reads Paperclip;
the repository alone cannot answer the question. Revisit triggers below.

### Alternatives considered (rev 2)

- **A second GitHub account / machine user as the reviewer identity.** _Lost, and it is the option
  the issue expected to win._ It does restore typed `APPROVED` / `CHANGES_REQUESTED` states, which
  is real value. But per "The constraint that decides this" it does not restore blocking, and
  `reviewDecision` stays `null` without protection, so it buys a coloured label rather than a
  gate. Against that: a collaborator on a private repo is a billable seat, so this is spend, which
  is board-gated on [PER-2](/PER/issues/PER-2) against a **$0** standing budget — and we would be
  escalating for spend that demonstrably does not produce the gate the escalation would be
  claiming. It also puts a second credential in circulation for the sole purpose of clicking
  approve on our own work, which is theatre with a key-management cost. Not escalated. Revisit if
  the repo goes public at M5, when both a free second identity and free protection arrive together
  and the combination _is_ a gate.
- **`github-actions[bot]` posting the verdict review (the free version of the above).** _Folded
  into Decision 6 as presentation only, and explicitly not the gate._ `GITHUB_TOKEN` acts as a
  distinct actor from the PR author, so GitHub should accept a verdict from it, and the `ci-gate`
  job already holds `pull-requests: write`. Worth doing because it puts the verdict in the Reviews
  timeline where a reviewer looks. It is not the control, for three reasons: it still does not
  block; GitHub does not count `GITHUB_TOKEN` approvals toward required reviews, so it is a dead
  end at M5 exactly when protection becomes available; and the workflow is authored by the same
  account, so it is no less self-attestable than the trailer. _Measurement owed:_ confirm GitHub
  accepts `REQUEST_CHANGES` from `github-actions[bot]` on an owner-authored PR. Owner: whoever
  takes the follow-up issue. Not gathered now because Decision 6 does not depend on the answer.
- **The author submitting a `COMMENT`-event review instead of a conversation comment.** _Lost,
  though it is technically available._ GitHub permits the author to create a review object — a
  pending review created and deleted on PR #23 during this rev confirms the refusal is specific to
  the two verdict events, not to reviews as such. Rejected because a `COMMENTED` review is
  indistinguishable in tooling from "left a few notes", so it would render in the Reviews section
  looking like a verdict while carrying none. That is the same failure mode rev 1 rejected
  `CODEOWNERS` for — "a file that looks like a control and is not one — worse than nothing,
  because it invites the belief that the gate exists."
- **Accept the gap and record it, with no mechanism.** _Won in part, as Decision 7, and is
  insufficient alone._ The honesty is the point and the reversibility lens favours it. But
  unmechanised acceptance is the status quo that let PR #23's defect reach a green build, so it
  ships paired with Decision 6 rather than instead of it. Rev 1 rejected "trust and a written
  process doc, with no mechanism" for this exact reason; rev 2 does not get to quietly adopt it.
- **Escalate for the paid tier now, on the strength of this discovery.** _Lost._ Protection would
  stop unreviewed merges, which is worth something — but it cannot require _CTO_ review (rev 1's
  Alternatives, unchanged), and rev 1's revisit trigger for spend is "two or more engineers
  merging to `main` in the same milestone", which has not happened. Escalating now would spend the
  board's attention on a control that does not implement the rule we wrote.

### Evidence (rev 2)

All observed 2026-09-30 against `neerajkrbansal1996/playhall`.

| Claim                                     | Observation                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| Author cannot approve                     | `422 Review Can not approve your own pull request`                     |
| Author cannot request changes             | `422 Review Can not request changes on your own pull request`          |
| Refusal is specific to the verdict events | Pending review created, then deleted, on PR #23 — both succeeded       |
| No review record exists at all            | 27 PRs: `reviews` empty, `reviewDecision` `""` on every one            |
| Nothing blocks a merge today              | PR #23 `mergeStateStatus: CLEAN`, `reviewDecision: null`               |
| Blocking remains unavailable              | `403 Upgrade to GitHub Pro` on both protection and rulesets endpoints  |
| No second identity exists today           | Paperclip's GitHub broker resolves to the same user id `22657452`      |
| Decision 6 is buildable                   | Actions run and pass on PR branches; `pr-hygiene` + `ci-gate` in place |
| Engineers able to merge                   | still **1** — rev 1's spend trigger has not fired                      |

**Measurements owed.** (1) Whether `github-actions[bot]` may submit `REQUEST_CHANGES` on an
owner-authored PR. (2) The per-seat cost of a second collaborator on a private repo. Both are
owed only if M5 or the two-merger trigger reopens option 1. Owner: CTO.

### Consequences (rev 2)

**Easier**

- "Was this reviewed?" gets a mechanical answer for the first time — a red `pr-hygiene` check
  rather than a human remembering to look.
- No spend, no second credential, no vendor, no board escalation for a control that would not
  work. Decision 6 lives entirely inside CI we are already building.

**Harder, and we should say so plainly**

- The verdict is **self-attestable and will remain so**. An engineer can write
  `CTO-VERDICT: approved` on their own PR and CI will pass it. This gate stops omission, not
  dishonesty, and nobody should describe it as more than that.
- This repository will never contain a review record for M0–M4 work. Git history alone cannot
  evidence §12, and no later amendment can retrofit it.
- We are now accepting a **second** control gap by decision rather than by accident. Rev 1
  accepted "detected, not prevented" for direct pushes; rev 2 accepts it for review. The two
  compound: a direct push to `main` by the sole merger is both unblocked and unreviewed, and only
  Decision 5 (releases from tags) stands between that and production.
- Decision 6 adds a required-looking check that a determined author can satisfy in one line. There
  is a real risk it breeds the false confidence rev 1 rejected `CODEOWNERS` for. Decision 7 exists
  to keep that written down where the next reader will find it.

### Revisit triggers (rev 2)

- **The repository goes public at M5** → a free second identity and free branch protection arrive
  together, and only together do they form a gate. Adopt both and supersede Decisions 6 and 7.
  This is the intended exit.
- **A PR merges carrying `CTO-VERDICT: approved` that the CTO did not write** → the self-attestation
  risk has materialised. Escalate to the board with the incident; do not re-argue the design.
- **Two or more engineers merging to `main` in the same milestone** → re-price option 1. With more
  than one author, a peer can submit a real verdict without a new account at all, which changes the
  answer.
- **A CTO GitHub identity is created for any other reason** → option 1's cost drops to zero and it
  should be adopted for the record it produces, still without claiming it blocks.
- **`github-actions[bot]` turns out to be refused as a reviewer** → Decision 6's presentation layer
  is unavailable; the trailer and check stand on their own, and this section should say so.
