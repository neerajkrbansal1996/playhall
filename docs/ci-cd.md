# CI, preview deploys and the production pipeline

Owner: Platform Engineer. Issue: [PER-6](/PER/issues/PER-6) (epic [PER-3](/PER/issues/PER-3)).

Everything here runs on GitHub Actions, which is included with the repository. **No
paid service is used and none was signed up for** — hosting and any paid tier are
board-gated on [PER-2](/PER/issues/PER-2). The section
[What production still needs](#what-production-still-needs) is the input for that
decision.

## What runs when

| Workflow                        | Trigger                                              | What it does                                                             |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `.github/workflows/ci.yml`      | every PR, merge queue, manual, and called by `production.yml` | The seven gates plus the `ci-gate` aggregate.                   |
| `.github/workflows/preview.yml` | PR opened / pushed / reopened                         | Preview deploy per target, health-probed, URL posted on the PR.          |
| `.github/workflows/production.yml` | push to `main`                                     | Re-runs every gate on the merge commit, then deploys web and realtime.   |
| `.github/workflows/uptime.yml`  | cron every ~10 min, manual                            | Probes production health; opens/closes one GitHub issue per outage.      |

`ci.yml` has no `push: [main]` trigger on purpose. `production.yml` calls it as a
reusable workflow on every push to `main`, so adding a `push` trigger would run the
whole suite twice and double the Actions minutes for no extra signal.

`production.yml` re-runs the gates rather than trusting "CI was green on the PR". Two
PRs can each be green alone and red together, and branch protection — which would force
a rebase before merge — is not available on this repo yet. Re-running on the merge commit
is what makes "`main` is deployable" true rather than probable.

## The gates

Each gate is one job in `ci.yml` and runs through `scripts/ci/gate.mjs`, which owns the
registry of gate name → root pnpm script → owning issue.

| Gate          | Runs                  | Status                                                |
| ------------- | --------------------- | ----------------------------------------------------- |
| `pr-hygiene`  | `scripts/ci/pr-hygiene.mjs` | Live. PR only.                                  |
| `lint`        | `pnpm lint`           | Live.                                                 |
| `typecheck`   | `pnpm typecheck`      | Live.                                                 |
| `boundaries`  | `pnpm boundaries`     | **Pending** — [PER-5](/PER/issues/PER-5), see [ADR-0002](adr/0002-dependency-boundary-enforcement.md). |
| `unit`        | `pnpm test`           | Live.                                                 |
| `testkit`     | `pnpm test:testkit`   | **Pending** — [PER-17](/PER/issues/PER-17).           |
| `integration` | `pnpm test:integration` | **Pending** — M1. Postgres + Redis services are already wired in the job. |
| `e2e`         | `pnpm test:e2e`       | **Pending** — M1/M3, QA Engineer.                     |

A pending gate logs a `::notice` naming its owner and **passes**. This is deliberate: a
workflow calling a script that does not exist fails with `ERR_PNPM_NO_SCRIPT`, which is
indistinguishable from a real regression. The day the owning issue adds the root script,
that same job becomes a hard gate with **no workflow edit**.

To close the loophole once M1 lands, set the repository variable `CI_STRICT_GATES=1` and
add it to the gate jobs' `env`. A pending gate then fails instead of passing, so a gate
cannot silently regress to "not implemented".

### Turning on required status checks

Branch protection is not available today: on this private repo both the
branch-protection and the rulesets APIs return `403 Upgrade to GitHub Pro`
(see [PER-35](/PER/issues/PER-35); plan/budget is on [PER-2](/PER/issues/PER-2)). The
pipeline is built so enabling it later is a settings change only:

1. Require **one** status check: **`ci-gate`**. Nothing else. `ci-gate` `needs` every
   gate and fails unless all of them succeeded, so gates become required transitively.
   Adding, renaming or removing a gate never changes the required-check list — which is
   the usual reason a required-checks config rots.
2. Enable **Require review from Code Owners**. `.github/CODEOWNERS` is already committed
   and already lists the CTO-owned paths.
3. Optionally enable the merge queue. `ci.yml` already has the `merge_group` trigger.

`ci-gate` treats a `skipped` gate as a failure (except `pr-hygiene`, which legitimately
does not run outside a PR). Without that rule, a job accidentally given an `if:` that
never matches would stop gating while the required check stayed green.

### Required reviewer: what is and is not enforced

PER-6 asks for "CTO on every PR". Two of the three parts are mechanical today:

- **Linked issue** — enforced. `pr-hygiene` fails a PR whose description has no Paperclip
  issue id.
- **Conventional PR title** — enforced. husky + commitlint check *commit* messages, but a
  squash-merge takes the *PR title* as the commit subject, so the title needs its own
  check or the CHANGELOG breaks.
- **CTO approval** — *not* enforced on GitHub. Agents have no GitHub accounts, so
  `CODEOWNERS` names the repo owner and CTO review happens on the Paperclip issue thread.
  The linked-issue check is what keeps that thread findable from the PR. Making approval
  blocking needs the plan upgrade in step 1 above.

## Health endpoints

| Service          | Path           | Question it answers                |
| ---------------- | -------------- | ---------------------------------- |
| `apps/web`       | `/api/health`  | Is this process serving?           |
| `apps/realtime`  | `/health`      | Is this process serving?           |
| `apps/realtime`  | `/ready`       | Should players be routed here?     |

The payload shape is `buildHealthPayload` in `@atrium/shared`, so one probe script parses
every service. A probe passes only on **2xx *and* `ok: true`** — a CDN edge will serve a
cached 200 while the service behind it is down, so status alone proves nothing. All three
routes send `cache-control: no-store`.

Liveness and readiness are separate for a reason: a liveness failure gets the process
restarted, so if a Redis blip failed liveness, a dependency wobble would become a restart
loop. Readiness failure only removes the instance from rotation.

`apps/realtime` has an empty `DEPENDENCY_CHECKS` registry today, so `/ready` currently
answers the same question as `/health`. M1 appends a Redis check and a Postgres check —
one entry each, with no change to the endpoints, the probe script, or the uptime workflow.

## Activating deploys

All provider logic is in `scripts/deploy/deploy.mjs`. The workflows never name a provider.
With nothing configured, a deploy reports `not_configured` and passes — an undecided board
question is not a build break.

To activate, set these in repository settings. No code change is needed.

| Kind     | Name                        | Purpose                                                       |
| -------- | --------------------------- | ------------------------------------------------------------- |
| Variable | `DEPLOY_PROVIDER`           | `none` (default) \| `vercel` \| `script`.                     |
| Variable | `REALTIME_DEPLOY_PROVIDER`  | Optional. Provider for `apps/realtime`; falls back to `DEPLOY_PROVIDER`. |
| Variable | `PRODUCTION_WEB_URL`        | Base URL the uptime monitor probes for web.                   |
| Variable | `PRODUCTION_REALTIME_URL`   | Base URL the uptime monitor probes for realtime.              |
| Secret   | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | Only if `DEPLOY_PROVIDER=vercel`.    |
| Secret   | `REALTIME_DEPLOY_TOKEN`     | Credential for the realtime host, once chosen.                |

Adding a provider means adding one entry to `PROVIDERS` in `scripts/deploy/deploy.mjs`.
It must print a `https://` URL; a deploy that reports success with no URL is treated as a
failure, because nothing downstream could smoke-test it.

`DEPLOY_PROVIDER=script` runs `scripts/deploy/custom.sh` and takes the last line of its
stdout as the URL — the escape hatch for a host with no usable CLI.

Preview deploys use `pull_request`, **not** `pull_request_target`. A fork PR therefore gets
no secrets and no preview. That is the correct trade: these workflows execute repo scripts,
and `pull_request_target` would run them with this repo's secrets against a contributor's
code.

## What production still needs

This is the part [PER-2](/PER/issues/PER-2) has to decide. The pipeline is finished; what
is missing is a provider and a budget.

**1. A host for `apps/web`.** Next.js App Router with SSR. Any Next-capable platform
works. Undemanding — this is the cheap half.

**2. A host for `apps/realtime`.** This is the real constraint, and it is worth being
explicit because the obvious answer for web does not cover it:

- It needs a **persistent process** holding WebSocket connections, which rules out
  request/response serverless — `scripts/deploy/deploy.mjs` rejects
  `DEPLOY_PROVIDER=vercel` for the `realtime` target for exactly this reason.
- It needs **sticky routing or shared state** across instances. Redis pub/sub is the
  design (ADR-0001), so instances can be stateless, but the host must allow long-lived
  connections and graceful drain on deploy.
- M6/M7 raise this to a **30 Hz tick loop**, which needs predictable CPU rather than a
  burst-credit runtime. Choosing a host now that cannot do that means choosing twice.
- Target: **2,000 concurrent turn-based rooms on one instance**.

**3. Managed Redis and Postgres.** Redis holds live room state, presence and pub/sub;
Postgres holds `rooms`, `room_seats`, `matches`, `match_events`, `match_records`. Both
need to survive a restart — a turn-based match must resume from Redis plus the match log
within 10 s.

**4. The figure the board needs.** Per my brief, the hosting gate needs **cost per 1,000
concurrent players**, not a monthly list price. That has to cover all four items above
together, plus egress, at the stated non-functional targets (< 30 KB/s down per client for
real-time). I have not priced this: doing so means signing up to read real quotas, which
is the board-gated action. Naming a number I have not measured would be worse than naming
none.

**5. A real uptime monitor.** `uptime.yml` is a real monitor, not a placeholder, but its
limits are worth stating plainly rather than discovering them during an outage:

- resolution is ~5 min at best, and Actions cron is delayed under load — minutes to
  detect, not seconds;
- it probes from GitHub's network only, so it cannot distinguish "our service is down"
  from "our service is unreachable from one region";
- it cannot page anyone. It opens and updates a GitHub issue.

Good enough now; not good enough for launch (M5). A hosted monitor with multi-region
probes and a paging path is a paid service and therefore board-gated. What it needs is
already in place: a stable, cacheable-proof health contract on both services.

## Things deliberately not done

- **`prettier --check` is not a CI gate.** PER-6 lists lint, typecheck, boundaries, unit,
  testkit, integration and E2E; formatting is not among them, and the repo currently has
  ~24 unformatted files. A gate that is red the day it lands teaches people to ignore CI.
  Adding it needs a one-time repo-wide `prettier --write`, which is a large mechanical
  diff and belongs in its own PR, not buried in this one.
- **Actions are pinned to commit SHAs**, with the version in a trailing comment. A moving
  tag like `@v4` is a third party that can change what runs in CI after review.
- **Secret scanning / CodeQL are not configured here.** Both are worth having; neither is
  in this issue's scope. Raise separately.
