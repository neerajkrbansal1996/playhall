# CI, preview deploys and the release pipeline

Owner: Platform Engineer. Issue: [PER-6](/PER/issues/PER-6) (epic [PER-3](/PER/issues/PER-3)).

Implements [ADR-0004](adr/0004-pr-gate-without-branch-protection.md) (the PR gate without
branch protection) and the free-tier path in
[ADR-0003](adr/0003-hosting-and-cost-model.md) §8.

Everything runs on GitHub Actions, which is included with the repository. **No paid
service is used and none was signed up for** — the standing infrastructure budget is $0
and the provider choice is board-gated on [PER-2](/PER/issues/PER-2).

## What runs when

| Workflow                        | Trigger                                                   | What it does                                                              |
| ------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`      | every PR, merge queue, manual, called by `main`/`release` | The seven gates plus the `ci-gate` aggregate.                             |
| `.github/workflows/preview.yml` | PR opened / pushed / reopened                             | Preview deploy per target, health-probed, URL posted on the PR.           |
| `.github/workflows/main.yml`    | push to `main`                                            | Re-runs the gates, audits for a direct push, then deploys to **staging**. |
| `.github/workflows/release.yml` | push of a `v*` tag, manual                                | Re-runs the gates, then deploys web and realtime to production.           |
| `.github/workflows/uptime.yml`  | cron every ~10 min, manual                                | Probes production health; opens/closes one GitHub issue per outage.       |

`ci.yml` has no `push` trigger of its own. `main.yml` and `release.yml` call it as a
reusable workflow, so adding one would run the whole suite twice and double the Actions
minutes for no extra signal.

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

ADR-0004 records the revisit trigger — if the repo goes public at M5 and protection becomes
free, `main` -> production can come back.

## The gates

Each gate is one job in `ci.yml`, running through `scripts/ci/gate.mjs`, which owns the
registry of gate name → root pnpm script → owning issue.

| Gate          | Runs                        | Status                                                                                             |
| ------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `pr-hygiene`  | `scripts/ci/pr-hygiene.mjs` | Live. PR only.                                                                                     |
| `lint`        | `pnpm lint`                 | Live.                                                                                              |
| `typecheck`   | `pnpm typecheck`            | Live.                                                                                              |
| `boundaries`  | `pnpm boundaries`           | **Pending** — [PER-5](/PER/issues/PER-5), [ADR-0002](adr/0002-dependency-boundary-enforcement.md). |
| `unit`        | `pnpm test`                 | Live.                                                                                              |
| `testkit`     | `pnpm test:testkit`         | **Pending** — [PER-17](/PER/issues/PER-17).                                                        |
| `integration` | `pnpm test:integration`     | **Pending** — M1. Postgres + Redis services already wired in the job.                              |
| `e2e`         | `pnpm test:e2e`             | **Pending** — M1/M3, QA Engineer.                                                                  |

A pending gate logs a `::notice` naming its owner and **passes**. This is deliberate: a
workflow calling a script that does not exist fails with `ERR_PNPM_NO_SCRIPT`, which is
indistinguishable from a real regression. The day the owning issue adds the root script,
that same job becomes a hard gate with **no workflow edit**.

To close the loophole once M1 lands, set `CI_STRICT_GATES=1` in the gate jobs' `env`. A
pending gate then fails instead of passing, so a gate cannot silently regress to "not
implemented".

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

| Rule ([PER-2](/PER/issues/PER-2) §12) | Enforced?                        | By what                                                                                                                                                                                                        |
| ------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linked Paperclip issue in the PR body | **Yes**                          | `pr-hygiene`. ADR-0004 §Decision 4 — with no GitHub review record, the issue thread _is_ the audit trail, so a missing link is a review defect, not a formatting nit.                                          |
| Conventional PR title                 | **Yes**                          | `pr-hygiene`. A squash-merge takes the commit subject from the PR title, so commitlint cannot catch it and the CHANGELOG breaks silently.                                                                      |
| Green CI                              | Observable, not required         | `ci.yml` on every PR. Merging red is a visible choice rather than an invisible one.                                                                                                                            |
| No direct push to `main`              | **Detected, not prevented**      | `push-audit` in `main.yml` fails when the pushed commit is not reachable from a merged PR. `main` turns red within a minute and the commit list records it forever.                                            |
| CTO review                            | **No** — Paperclip workflow only | Agents have no GitHub identity. ADR-0004 rejects a `CODEOWNERS` file for this: it is only enforced by branch protection and would name a non-existent user, so it would look like a control without being one. |

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
nothing configured a deploy reports `not_configured` and passes — an undecided board
question is not a build break.

The board authorised **$120/month on Fly.io** for M0–M5 (region `bom`, interim), stepping to
$250/month at M5 with a $400 hard ceiling. Spend priority, in order: **(1) per-PR preview
environments, (2) a staging environment that holds a WebSocket, (3) minimum-size production
until M5.** Previews and staging are the reason the board reversed $0, so production sizing
must not crowd them out. Sentry, PostHog and the uptime monitor stay on free tiers.

| Provider           | Targets               | Notes                                                                                                                                                                                                                                        |
| ------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fly`              | both                  | **The board's choice.** Runs persistent processes, so `apps/realtime` can hold WebSocket connections and later a 30 Hz tick on dedicated CPU. Needs `fly.toml` and a provisioned app — this script never creates billable infrastructure.    |
| `none` (default)   | both                  | Clean skip with a notice naming what is missing. Unset, empty and whitespace all resolve here, so the repo is green before a provider exists. A value that is set but unrecognised still fails the job — the distinction is unset vs. wrong. |
| `cloudflare-pages` | web only              | Free-egress static hosting. Still relevant: static egress is ~1.7× the WebSocket egress and must sit behind a free-egress CDN. Chosen over Vercel Hobby, which forbids commercial use — a licence problem, not a cost one.                   |
| `render`           | realtime, non-preview | Free tier runs a long-lived Node process. Refuses `preview`, because free-tier Render has no per-PR previews.                                                                                                                                |
| `script`           | both                  | Escape hatch: runs `scripts/deploy/custom.sh`, last line of stdout is the URL.                                                                                                                                                               |

Set these in repository settings. No code change needed.

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
resources on demand is how a $120/month cap becomes a $400 one, so the `fly` provider fails
with a readable error when the app or its config is missing rather than creating either.

A provider must print a `https://` URL; a deploy that reports success with no URL is
treated as a failure, because nothing downstream could smoke-test it.

Preview deploys use `pull_request`, **not** `pull_request_target`. A fork PR therefore
gets no secrets and no preview. That is the correct trade: these workflows execute repo
scripts, and `pull_request_target` would run them with this repo's secrets against a
contributor's code.

## What is still needed

The cost question is discharged: [ADR-0003](adr/0003-hosting-and-cost-model.md) published
the model, and the board answered on [PER-2](/PER/issues/PER-2) — **Fly.io, $120/month**.
What the _pipeline_ is still waiting on:

1. **GitHub Actions cannot run at all.** Every push produces `startup_failure` with zero
   jobs, including an 8-line control workflow on an untouched branch. Account/plan level,
   not YAML — tracked on [PER-55](/PER/issues/PER-55). Until it clears, every gate here is
   advisory and ADR-0004's push detector cannot fire, so `main` has neither prevention nor
   detection. That is below the risk ADR-0004 accepted.
2. **Provisioned Fly apps and a `FLY_API_TOKEN`.** [PER-7](/PER/issues/PER-7).
3. **M0 AC1 stays "partially met"** until per-PR previews actually run.

Two ADR-0003 items land on Platform Engineer but not on this issue:

- **Fronting `apps/web` with a free-egress CDN is a line item, not an optimisation** —
  static egress is ~1.7× the WebSocket egress (ADR-0003 §2.1 note 2).
  [PER-7](/PER/issues/PER-7).
- **The match log grows ~31.5 GB/month per 1,000 concurrent players and nothing deletes
  it** — needs a retention policy.
  [PER-15](/PER/issues/PER-15)/[PER-29](/PER/issues/PER-29).

**Measurement owed** (ADR-0001 §2): report CI wall-clock per PR once the pipeline is green,
so the "add Turborepo above 5 minutes" trigger is checkable rather than decorative. Blocked
on [PER-55](/PER/issues/PER-55).

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
  testkit, integration and E2E; formatting is not among them, and the repo currently has
  ~24 unformatted files. A gate that is red the day it lands teaches people to ignore CI.
  Adding it needs a one-time repo-wide `prettier --write`, which is a large mechanical
  diff and belongs in its own PR.
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
