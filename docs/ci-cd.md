# CI, preview deploys and the release pipeline

Owner: Platform Engineer. Issue: [PER-6](/PER/issues/PER-6) (epic [PER-3](/PER/issues/PER-3)).

Implements [ADR-0004](adr/0004-pr-gate-without-branch-protection.md) (the PR gate without
branch protection) and the free-tier path in
[ADR-0003](adr/0003-hosting-and-cost-model.md) §8.

Everything runs on GitHub Actions, which is included with the repository. **No paid
service is used and none was signed up for.** The board has held all provisioning — no
vendor account, no card on file, no paid tier, no trial, on any provider — so the CI half
of this pipeline is live and the deploy half is inert by design, not by omission. See
[ADR-0003](adr/0003-hosting-and-cost-model.md) §13 and
[Activating deploys](#activating-deploys) below.

## What runs when

| Workflow                        | Trigger                                                   | What it does                                                                            |
| ------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`      | every PR, merge queue, manual, called by `main`/`release` | The nine gates plus the `ci-gate` aggregate.                                            |
| `.github/workflows/preview.yml` | PR opened / pushed / reopened                             | Preview deploy per target, health-probed, URL posted on the PR.                         |
| `.github/workflows/main.yml`    | push to `main`                                            | Re-runs the gates, audits for a direct push, then deploys to **staging**.               |
| `.github/workflows/release.yml` | push of a `v*` tag, manual                                | Asserts a tag, re-runs the gates, audits the tagged commit, then deploys to production. |
| `.github/workflows/uptime.yml`  | cron every ~10 min, manual                                | Probes production health; opens/closes one GitHub issue per outage.                     |

`ci.yml` has no `push` trigger of its own. `main.yml` and `release.yml` call it as a
reusable workflow, so adding one would run the whole suite twice and double the Actions
minutes for no extra signal.

**If you add a third caller, grant it `pull-requests: write` on the calling job.** A called
workflow cannot exceed its caller's grant, and `ci-gate` requests that scope to post its gate
table. Get it wrong and the run does not fail a job — it fails at **startup, with zero jobs,
no annotation and no step to open**, which reads exactly like an account-level Actions outage.
That is how it presented the first time `main.yml` ran for real, and it is why both callers now
carry the grant explicitly even though the step that uses it only fires on a `pull_request`.

You will not have to remember that, though: the **`workflows` gate** asserts it. For every job
that calls a local reusable workflow, the permissions it passes must cover every scope that
workflow's jobs request. It is the check that makes this the one coupling in the pipeline you
cannot break silently — see [PER-88](/PER/issues/PER-88), which is where the failure mode above
cost `main` several green runs before anyone noticed. The same gate also catches the other
direction: add a scope to a job inside `ci.yml` and it tells you which callers now need it.

Both `main.yml` and `release.yml` re-run the gates rather than trusting "CI was green on
the PR". Two PRs can each be green alone and red together, and with no branch protection
nothing forces a rebase before merge. A tag can also point at any commit, including one
that never saw `main`.

### `main` goes to staging; production comes from a tag

PER-6 as originally written asked for "`main` merges deploy to production".
[ADR-0004](adr/0004-pr-gate-without-branch-protection.md) §Decision 5 postdates it and the
CTO amended the scope on the issue: **`main` -> staging stays automatic, production is cut
from a tag.**

That split is the containment for the whole ADR. `main` cannot be protected, so an
unreviewed commit _can_ land there. If `main` auto-deployed to production, one direct push
— including an accidental one — would be live with no review and no gate. With a tag in
the way, a human has to cut `vX.Y.Z` first.

Staging deploys additionally wait on `push-audit`, not just the gates: an unreviewed commit
should not reach the environment the board clicks on either.

**Production waits on `push-audit` too, and that is load-bearing.** A tag can point at any
commit, so without it the split above has a complete bypass: push straight to `main`,
ignore the red `main.yml` audit, tag that commit, ship it. Production is the one
environment where a missing control is not recoverable by a revert, so `release.yml` runs
its own copy of the audit against the tagged commit. The script reads `GITHUB_SHA` rather
than a pull-request event, so it works on a tag ref unchanged.

`release.yml` also asserts `github.ref_type == 'tag'` before anything else (`release-ref`).
`workflow_dispatch` lets a human pick any ref, and production may only ever be cut from a
tag. There is deliberately **no** "ref to deploy" input: a free-text ref would be the one
way to put an arbitrary untagged commit into production, which is precisely what the tag
trigger exists to prevent.

ADR-0004 records the revisit trigger — if the repo goes public at M5 and protection becomes
free, `main` -> production can come back.

## The gates

Each gate is one job in `ci.yml`. The gates that need the workspace run through
`scripts/ci/gate.mjs`, which owns the registry of gate name → root pnpm script → owning
issue. `pr-hygiene` and `workflows` call their script directly instead: both are static
checks over files already on disk, so they skip `./.github/actions/setup` and still report
when an install would not succeed.

| Gate          | Runs                              | Status                                                                                             |
| ------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pr-hygiene`  | `scripts/ci/pr-hygiene.mjs`       | Live. PR only.                                                                                     |
| `workflows`   | `pnpm check:workflow-permissions` | Live. Static: no install, no token, no network.                                                    |
| `lint`        | `pnpm lint`                       | Live.                                                                                              |
| `typecheck`   | `pnpm typecheck`                  | Live.                                                                                              |
| `boundaries`  | `pnpm boundaries`                 | **Pending** — [PER-5](/PER/issues/PER-5), [ADR-0002](adr/0002-dependency-boundary-enforcement.md). |
| `unit`        | `pnpm test`                       | Live.                                                                                              |
| `coverage`    | `pnpm test:coverage`              | **Pending** — [PER-89](/PER/issues/PER-89).                                                        |
| `testkit`     | `pnpm test:testkit`               | **Pending** — [PER-17](/PER/issues/PER-17).                                                        |
| `integration` | `pnpm test:integration`           | **Pending** — M1. Postgres + Redis services already wired in the job.                              |
| `e2e`         | `pnpm test:e2e`                   | **Pending** — M1/M3, QA Engineer.                                                                  |

A pending gate logs a `::notice` naming its owner and **passes**. This is deliberate: a
workflow calling a script that does not exist fails with `ERR_PNPM_NO_SCRIPT`, which is
indistinguishable from a real regression. The day the owning issue adds the root script,
that same job becomes a hard gate with **no workflow edit**.

To close the loophole once M1 lands, set `CI_STRICT_GATES=1` in the gate jobs' `env`. A
pending gate then fails instead of passing, so a gate cannot silently regress to "not
implemented". Owner and trigger: [PER-98](/PER/issues/PER-98) at M1 close — "set it once M1
closes" in a code comment is not a commitment anything honours.

A gate declared **live** (`pendingOwner: null`) whose root script is missing is a different
case — a demotion, not an unwritten implementation — and it fails hard regardless of
`CI_STRICT_GATES`. Rename the root `lint` script and CI says so, instead of reporting PENDING
with owner `unassigned` and leaving `ci-gate` green while lint no longer runs.

A gate name that is not in the registry exits `2`. That check uses `Object.hasOwn`, not a
plain lookup — `gate.mjs constructor` would otherwise resolve up the prototype chain,
read an undefined `script`, land in the PENDING branch and pass as "owner: unassigned".

### Why `coverage` is its own gate

The `>= 80%` rule is enforced today only _inside_ `pnpm test`, by each package's own vitest
thresholds. A package that never configures one is therefore exempt by accident while
`unit` stays green — which is exactly how `packages/game-sdk` sat at 0%
([PER-53](/PER/issues/PER-53)) and `games/chess` at 41%
([PER-82](/PER/issues/PER-82)). [PER-89](/PER/issues/PER-89) lands the root script that
fails on a missing threshold, not just a low one.

The `coverage` artifact upload lives on this job, not on `unit`. On `unit` it had
`if-no-files-found: ignore` next to a vitest run with no `--coverage`, so it published an
empty archive on every run that implied a check which did not exist. It is still empty until
PER-89 lands — but it now hangs off the job whose name says PENDING.

### Why one aggregate check

`ci-gate` `needs` every gate and fails unless all of them succeeded. It exists so that if
protection ever becomes available, exactly **one** check needs to be required — adding,
renaming or removing a gate never changes the required-check list, which is the usual
reason a required-checks config rots. `ci.yml` also already carries the `merge_group`
trigger, so a merge queue needs no edit here.

`ci-gate` treats a `skipped` gate as a failure (except `pr-hygiene`, which legitimately
does not run outside a PR). Without that rule, a job accidentally given an `if:` that
never matches would stop gating while the required check stayed green.

### What actually enforces the PR rules

Per ADR-0004, `main` is unprotected through M0–M4 and that is an accepted risk, not an
open problem. The gate moved from **prevention** to **detection**:

| Rule ([PER-2](/PER/issues/PER-2) §12) | Enforced?                        | By what                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linked Paperclip issue in the PR body | **Yes**                          | `pr-hygiene`. ADR-0004 §Decision 4 — with no GitHub review record, the issue thread _is_ the audit trail, so a missing link is a review defect, not a formatting nit.                     |
| Conventional PR title                 | **Yes**                          | `pr-hygiene`. A squash-merge takes the commit subject from the PR title, so commitlint cannot catch it and the CHANGELOG breaks silently.                                                 |
| Green CI                              | Observable, not required         | `ci.yml` on every PR. Merging red is a visible choice rather than an invisible one.                                                                                                       |
| No direct push to `main`              | **Detected, not prevented**      | `push-audit`, in **both** `main.yml` and `release.yml`. Fails when the commit is not reachable from a merged PR. `main` turns red within a minute and the commit list records it forever. |
| CTO review                            | **No** — Paperclip workflow only | Not fixable at any plan. See below.                                                                                                                                                       |

The linked-issue check has to be able to _fail_, which took two attempts. The first version
matched any `\b[A-Z]+-\d+\b` anywhere in the body, so the unedited template satisfied it
(its own HTML comment contains `PER-6`), and so did any `ADR-0004` reference. It now strips
HTML comments first and requires a deliberate reference: the `Paperclip-Issue:` trailer, or
a `/{PREFIX}/issues/{ID}` link. A bare id in prose no longer counts.

**"CTO review on every PR" cannot be met on any plan the board has authorised, and is
recorded as not met.** Two separate walls, and buying past one does not help:

- Required _status checks_ need branch protection, which needs GitHub Pro. The board
  answered `Free — buy nothing`, so this is a decision, not a missing task.
- A required _review_ rule additionally needs a **second GitHub identity**. One account
  cannot approve its own PR, so a single-identity repo would deadlock rather than gate —
  Pro would not fix it. Tracked on [PER-78](/PER/issues/PER-78).

Because prevention is now permanently unavailable rather than temporarily so, `push-audit`
is not a stopgap — it is the _entire_ control on `main`, which is why it also guards the
production path.

The honest summary: there is a window between a direct push and the red build in which
`main` is wrong and looks fine. ADR-0004 §Revisit triggers says re-raise the moment two or
more engineers are merging in the same milestone.

## Health endpoints

| Service         | Path          | Question it answers            |
| --------------- | ------------- | ------------------------------ |
| `apps/web`      | `/api/health` | Is this process serving?       |
| `apps/realtime` | `/health`     | Is this process serving?       |
| `apps/realtime` | `/ready`      | Should players be routed here? |

The payload shape is `buildHealthPayload` in `@playhall/shared`, so one probe script parses
every service. A probe passes only on **2xx _and_ `ok: true`** — a CDN edge will serve a
cached 200 while the service behind it is down, so status alone proves nothing. All three
routes send `cache-control: no-store`.

Liveness and readiness are separate for a reason: a liveness failure gets the process
restarted, so if a Redis blip failed liveness, a dependency wobble would become a restart
loop. Readiness failure only removes the instance from rotation.

`apps/realtime` has an empty `DEPENDENCY_CHECKS` registry today, so `/ready` currently
answers the same question as `/health`. M1 appends a Redis check and a Postgres check —
one entry each, with no change to the endpoints, the probe script, or the uptime workflow.

## Activating deploys

All provider logic is in `scripts/deploy/deploy.mjs`; no workflow names a provider. With
nothing configured a deploy reports `not_configured` and passes — infrastructure that has
not been provisioned is not a build break.

### The condition that switches deploys on

**One condition, and it is not technical: the board lifts the provisioning hold.**

Provisioning is held — no vendor account, no card on file, no paid tier, no trial, on any
provider. The hold, and what would lift it, is [ADR-0003](adr/0003-hosting-and-cost-model.md)
§13. Deliberately not restated here: the provider, the envelope and the spend priorities.
They are settled, they live in ADR-0003 §10 and §12, and a figure duplicated into four files
is a figure that goes stale in four files.

Read §13.2 before treating a budget approval as permission. The board ratified the spend
**authority** and withheld **permission** to exercise it; those are separate answers and only
the second one gates this section. An approved budget buys nothing.

So the order is: board lifts the hold → [PER-7](/PER/issues/PER-7) provisions and sets the
variables and secrets below → previews and deploys start producing URLs. **No code change at
any step.** Until then the honest state of this pipeline is `not_configured`, printed in the
run log and in the PR comment, and M0 AC1 is recorded as not met.

| Provider           | Targets               | Notes                                                                                                                                                                                                                                                                                      |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fly`              | both                  | The settled provider for M0–M5, **held, not usable** — no account exists. Runs persistent processes, so `apps/realtime` can hold WebSocket connections and later a 30 Hz tick on dedicated CPU. Needs `fly.toml` and a provisioned app; this script never creates billable infrastructure. |
| `none` (default)   | both                  | Clean skip with a notice naming what is missing. Unset, empty and whitespace all resolve here, so the repo is green before a provider exists. A value that is set but unrecognised still fails the job — the distinction is unset vs. wrong.                                               |
| `cloudflare-pages` | web only              | Free-egress static hosting. Still relevant: static egress is ~1.7× the WebSocket egress and must sit behind a free-egress CDN. Chosen over Vercel Hobby, which forbids commercial use — a licence problem, not a cost one.                                                                 |
| `render`           | realtime, non-preview | Free tier runs a long-lived Node process. Refuses `preview`, because free-tier Render has no per-PR previews.                                                                                                                                                                              |
| `script`           | both                  | Escape hatch: runs `scripts/deploy/custom.sh`, last line of stdout is the URL.                                                                                                                                                                                                             |

Set these in repository settings **once the hold is lifted**, not before. No code change
needed at that point.

| Kind     | Name                                              | Purpose                                                                                     |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Variable | `DEPLOY_PROVIDER`                                 | `none` \| `fly` \| `cloudflare-pages` \| `render` \| `script`. Unset or empty means `none`. |
| Variable | `REALTIME_DEPLOY_PROVIDER`                        | Provider for `apps/realtime`; falls back to `DEPLOY_PROVIDER`.                              |
| Variable | `FLY_APP_WEB_STAGING`, `FLY_APP_REALTIME_STAGING` | Fly app names for staging.                                                                  |
| Variable | `FLY_APP_WEB_PROD`, `FLY_APP_REALTIME_PROD`       | Fly app names for production.                                                               |
| Variable | `PRODUCTION_WEB_URL`, `PRODUCTION_REALTIME_URL`   | Base URLs the uptime monitor probes.                                                        |
| Secret   | `FLY_API_TOKEN`                                   | For `fly`.                                                                                  |
| Secret   | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`   | For `cloudflare-pages`.                                                                     |
| Secret   | `RENDER_API_KEY`, `RENDER_SERVICE_ID`             | For `render`.                                                                               |

**Nothing in this pipeline provisions infrastructure.** Fly apps, `fly.toml`, Redis and
Postgres belong to [PER-7](/PER/issues/PER-7). A deploy script that creates billable
resources on demand is how a provisioning hold gets breached by a script nobody read, so the
`fly` provider fails with a readable error when the app or its config is missing rather than
creating either.

A provider must print a `https://` URL; a deploy that reports success with no URL is
treated as a failure, because nothing downstream could smoke-test it.

Preview deploys use `pull_request`, **not** `pull_request_target`. A fork PR therefore
gets no secrets and no preview. That is the correct trade: these workflows execute repo
scripts, and `pull_request_target` would run them with this repo's secrets against a
contributor's code.

## What is still needed

The cost question is discharged — [ADR-0003](adr/0003-hosting-and-cost-model.md) published
the model and the board answered — but the answer was _authority without permission_
(ADR-0003 §13). What the _pipeline_ is still waiting on:

1. **The provisioning hold, lifted.** Everything below is downstream of it and nothing else
   here is a code problem. Board decision; ADR-0003 §13.5 says what would lift it.
2. **Provisioned apps, a CDN in front of `apps/web`, and the deploy credentials.**
   [PER-7](/PER/issues/PER-7), and blocked by (1).
3. **M0 AC1 ("a preview deploy per PR") is recorded as not met**, by the board's own decision
   of 2026-09-30. An end-to-end isolated preview — its own realtime service, Redis and
   Postgres, so one PR's schema change cannot break another PR's preview — needs spend on
   every candidate we costed. A shared long-lived URL redeployed per PR is deliberately
   **not** substituted for it: two concurrent PRs would overwrite each other and a reviewer
   could not tell which change they were looking at. The gap is recorded rather than
   engineered around.

GitHub Actions itself is healthy again — [PER-55](/PER/issues/PER-55) (an account-level
payment failure that produced `startup_failure` with zero jobs on every workflow) is resolved,
so every gate here executes and ADR-0004's push detector can fire.

**Measurement discharged** (ADR-0001 §2): **53 s and 52 s** CI wall-clock per PR on two
consecutive green runs, 9 jobs fully parallel; 63–82 s end-to-end including the concurrent
preview workflow. Comfortably under the 5-minute Turborepo trigger — but treat it as a floor,
not a verdict. **Five of nine gates are PENDING stubs**, `integration` boots Redis and
Postgres service containers with no tests in them, and there is no build caching. Re-measure
when M1 closes before concluding Turborepo is unnecessary — and note the measurement predates
the `coverage` job, so it is a nine-job number for a ten-job pipeline.

Two ADR-0003 items land on Platform Engineer but not on this issue:

- **Fronting `apps/web` with a free-egress CDN is a line item, not an optimisation** —
  static egress is ~1.7× the WebSocket egress (ADR-0003 §2.1 note 2).
  [PER-7](/PER/issues/PER-7).
- **The match log grows ~31.5 GB/month per 1,000 concurrent players and nothing deletes
  it** — needs a retention policy.
  [PER-15](/PER/issues/PER-15)/[PER-29](/PER/issues/PER-29).

### A real uptime monitor for launch (M5)

`uptime.yml` is a real monitor, not a placeholder, but its limits are worth stating rather
than discovering during an outage: ~5 min resolution at best and Actions cron is delayed
under load; it probes from GitHub's network only, so it cannot tell "our service is down"
from "unreachable from one region"; and it cannot page anyone — it opens and updates a
GitHub issue. The board kept the uptime monitor on a free tier, so this is the plan for now.
What a hosted monitor would need is already in place: a stable, cache-proof health contract
on both services.

## Things deliberately not done

- **`prettier --check` is not a CI gate.** PER-6 lists lint, typecheck, boundaries, unit,
  testkit, integration and E2E; formatting is not among them. The figure previously given
  here — "~24 unformatted files" — is stale: measured at this head, `prettier --check .`
  reports **two**, `docs/adr/0004-pr-gate-without-branch-protection.md` and
  `docs/adr/README.md`. So the "large mechanical diff" argument is mostly spent, and what is
  left is one registry line, one job, and two documents to reformat.
  [PER-98](/PER/issues/PER-98) owns it and must re-measure immediately before landing —
  "clean" is a property of a head, not of the repo, and this number moves every time a
  document lands.
- **No `CODEOWNERS`.** Rejected by ADR-0004, and the reasoning is right: without branch
  protection it enforces nothing, and a file that looks like a control but is not one is
  worse than no file, because it invites the belief that the gate exists.
- **No pre-push hook blocking `main`.** ADR-0004 permits one as a convenience but is
  explicit that it must never be described as the control — it is local, per-clone and
  bypassable with `--no-verify`. Left out to avoid implying a gate that is not there.
- **Actions are pinned to commit SHAs**, version in a trailing comment. A moving tag like
  `@v4` is a third party that can change what runs in CI after review.
- **Secret scanning / CodeQL are not configured.** Both are worth having; neither is in
  this issue's scope.
- **`actionlint` is not yet a CI step.** It was used to verify these workflows (1.7.12,
  zero findings across all 7 files) and is worth wiring in, but it needs a binary download
  and there is no point adding it while Actions cannot run — [PER-55](/PER/issues/PER-55).
