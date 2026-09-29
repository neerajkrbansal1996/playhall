# CI, preview deploys and the release pipeline

Owner: Platform Engineer. Issue: [PER-6](/PER/issues/PER-6) (epic [PER-3](/PER/issues/PER-3)).

Implements [ADR-0004](adr/0004-pr-gate-without-branch-protection.md) (the PR gate without
branch protection) and the free-tier path in
[ADR-0003](adr/0003-hosting-and-cost-model.md) §8.

Everything runs on GitHub Actions, which is included with the repository. **No paid
service is used and none was signed up for** — the standing infrastructure budget is $0
and the provider choice is board-gated on [PER-2](/PER/issues/PER-2).

## What runs when

| Workflow                        | Trigger                                              | What it does                                                             |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `.github/workflows/ci.yml`      | every PR, merge queue, manual, called by `main`/`release` | The seven gates plus the `ci-gate` aggregate.                    |
| `.github/workflows/preview.yml` | PR opened / pushed / reopened                         | Preview deploy per target, health-probed, URL posted on the PR.          |
| `.github/workflows/main.yml`    | push to `main`                                        | Re-runs the gates on the merge commit **and** audits for a direct push.  |
| `.github/workflows/release.yml` | push of a `v*` tag, manual                            | Re-runs the gates, then deploys web and realtime to production.          |
| `.github/workflows/uptime.yml`  | cron every ~10 min, manual                            | Probes production health; opens/closes one GitHub issue per outage.      |

`ci.yml` has no `push` trigger of its own. `main.yml` and `release.yml` call it as a
reusable workflow, so adding one would run the whole suite twice and double the Actions
minutes for no extra signal.

Both `main.yml` and `release.yml` re-run the gates rather than trusting "CI was green on
the PR". Two PRs can each be green alone and red together, and with no branch protection
nothing forces a rebase before merge. A tag can also point at any commit, including one
that never saw `main`.

### Deploys are tag-triggered, not `main`-triggered

PER-6 as originally written asked for "`main` merges deploy to production".
[ADR-0004](adr/0004-pr-gate-without-branch-protection.md) §Decision 5 postdates it and
names PER-6 as its implementation: **releases are cut from tags, never from "whatever is
on `main`".**

That is not bureaucracy, it is the containment for the whole ADR. `main` cannot be
protected, so an unreviewed commit *can* land there. If `main` auto-deployed, the blast
radius of one bad push would be production. With a tag in the way, a human has to cut
`vX.Y.Z` first.

## The gates

Each gate is one job in `ci.yml`, running through `scripts/ci/gate.mjs`, which owns the
registry of gate name → root pnpm script → owning issue.

| Gate          | Runs                        | Status                                          |
| ------------- | --------------------------- | ----------------------------------------------- |
| `pr-hygiene`  | `scripts/ci/pr-hygiene.mjs` | Live. PR only.                                  |
| `lint`        | `pnpm lint`                 | Live.                                           |
| `typecheck`   | `pnpm typecheck`            | Live.                                           |
| `boundaries`  | `pnpm boundaries`           | **Pending** — [PER-5](/PER/issues/PER-5), [ADR-0002](adr/0002-dependency-boundary-enforcement.md). |
| `unit`        | `pnpm test`                 | Live.                                           |
| `testkit`     | `pnpm test:testkit`         | **Pending** — [PER-17](/PER/issues/PER-17).     |
| `integration` | `pnpm test:integration`     | **Pending** — M1. Postgres + Redis services already wired in the job. |
| `e2e`         | `pnpm test:e2e`             | **Pending** — M1/M3, QA Engineer.               |

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

| Rule ([PER-2](/PER/issues/PER-2) §12)   | Enforced?                       | By what                                    |
| --------------------------------------- | ------------------------------- | ------------------------------------------ |
| Linked Paperclip issue in the PR body   | **Yes**                         | `pr-hygiene`. ADR-0004 §Decision 4 — with no GitHub review record, the issue thread *is* the audit trail, so a missing link is a review defect, not a formatting nit. |
| Conventional PR title                   | **Yes**                         | `pr-hygiene`. A squash-merge takes the commit subject from the PR title, so commitlint cannot catch it and the CHANGELOG breaks silently. |
| Green CI                                | Observable, not required        | `ci.yml` on every PR. Merging red is a visible choice rather than an invisible one. |
| No direct push to `main`                | **Detected, not prevented**     | `push-audit` in `main.yml` fails when the pushed commit is not reachable from a merged PR. `main` turns red within a minute and the commit list records it forever. |
| CTO review                              | **No** — Paperclip workflow only | Agents have no GitHub identity. ADR-0004 rejects a `CODEOWNERS` file for this: it is only enforced by branch protection and would name a non-existent user, so it would look like a control without being one. |

The honest summary: there is a window between a direct push and the red build in which
`main` is wrong and looks fine. ADR-0004 §Revisit triggers says re-raise the moment two or
more engineers are merging in the same milestone.

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

All provider logic is in `scripts/deploy/deploy.mjs`; no workflow names a provider. With
nothing configured a deploy reports `not_configured` and passes — an undecided board
question is not a build break.

Providers implemented, following [ADR-0003](adr/0003-hosting-and-cost-model.md) §8:

| Provider           | Target     | Notes                                                                   |
| ------------------ | ---------- | ----------------------------------------------------------------------- |
| `none` (default)   | both       | Clean skip with a notice naming the board gate.                         |
| `cloudflare-pages` | web only   | Free, unlimited egress, genuinely per-PR previews. **Chosen over Vercel Hobby because Hobby forbids commercial use** — a licence problem, not a cost one, so no free tier makes it acceptable. |
| `render`           | realtime, production only | The only free-tier candidate that runs a long-lived Node WebSocket process. Free-tier per-PR previews do not exist, so the provider refuses `preview` rather than pretending. |
| `script`           | both       | Escape hatch: runs `scripts/deploy/custom.sh`, takes the last line of stdout as the URL. |

Set these in repository settings. No code change needed.

| Kind     | Name                                              | Purpose                                              |
| -------- | ------------------------------------------------- | ---------------------------------------------------- |
| Variable | `DEPLOY_PROVIDER`                                 | `none` \| `cloudflare-pages` \| `render` \| `script`. |
| Variable | `REALTIME_DEPLOY_PROVIDER`                        | Provider for `apps/realtime`; falls back to `DEPLOY_PROVIDER`. |
| Variable | `CLOUDFLARE_PAGES_PROJECT`                        | Pages project name. Defaults to `playhall-web`.      |
| Variable | `PRODUCTION_WEB_URL`, `PRODUCTION_REALTIME_URL`   | Base URLs the uptime monitor probes.                 |
| Secret   | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`   | For `cloudflare-pages`.                              |
| Secret   | `RENDER_API_KEY`, `RENDER_SERVICE_ID`             | For `render`.                                        |

A provider must print a `https://` URL; a deploy that reports success with no URL is
treated as a failure, because nothing downstream could smoke-test it.

Preview deploys use `pull_request`, **not** `pull_request_target`. A fork PR therefore
gets no secrets and no preview. That is the correct trade: these workflows execute repo
scripts, and `pull_request_target` would run them with this repo's secrets against a
contributor's code.

## What production still needs

[ADR-0003](adr/0003-hosting-and-cost-model.md) discharges the cost question — it publishes
a model and a cost per 1,000 concurrent players, and escalates the provider choice and the
budget to the board on [PER-2](/PER/issues/PER-2). This section records only what the
*pipeline* is still waiting on.

1. **Credentials for the free path.** `cloudflare-pages` and `render` are implemented;
   neither has an account or a token yet. A Cloudflare connection has been requested
   through Paperclip. Render needs the same.
2. **The board's answer on §10 of ADR-0003** — provider and budget. Until then,
   `DEPLOY_PROVIDER` stays unset and both deploy paths report `not_configured`.
3. **M0 AC1 is "partially met", not met**, and should be reported that way. Per ADR-0003
   §8, Cloudflare Pages gives a genuinely free per-PR preview of `apps/web`, but an
   end-to-end isolated preview — its own realtime service, Redis and Postgres, so one PR's
   schema change cannot break another's preview — **requires spend on every candidate
   except a self-built Hetzner path.** The `render` provider refusing `preview` is that
   fact made mechanical rather than left as a footnote.
4. **A real uptime monitor for launch (M5).** `uptime.yml` is a real monitor, not a
   placeholder, but its limits are worth stating rather than discovering during an outage:
   ~5 min resolution at best and Actions cron is delayed under load; it probes from
   GitHub's network only, so it cannot tell "our service is down" from "unreachable from
   one region"; and it cannot page anyone — it opens and updates a GitHub issue. A hosted
   multi-region monitor with paging is a paid service and therefore board-gated. What it
   needs is already in place: a stable, cache-proof health contract on both services.

Two items from ADR-0003 land on me and are **not** in this issue:

- **Fronting `apps/web` with a free CDN is a line item, not an optimisation** — static
  egress is ~1.7× the WebSocket egress (ADR-0003 §2.1 note 2). Owner: Platform Engineer,
  [PER-7](/PER/issues/PER-7).
- **The match log grows ~31.5 GB/month per 1,000 concurrent players and nothing deletes
  it** — needs a retention policy. Owner: Platform Engineer,
  [PER-15](/PER/issues/PER-15)/[PER-29](/PER/issues/PER-29).

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
