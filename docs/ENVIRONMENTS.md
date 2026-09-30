# Environments, configuration and telemetry

Owner: Platform Engineer. Issue: [PER-7](/PER/issues/PER-7).

This is the authoritative answer to "which env vars does each service need, and where
does the value come from". `.env.example` is the local subset of it.

**No secret is ever committed.** `.env`, `.env.local` and `.env.*.local` are gitignored;
nothing in this repo has a credential as a default. Values reach a deployed service from
the host's secret store, injected at build or boot — never from a file in the tree.

---

## 1. The three environments

| Environment   | What it is                                    | Brand / release identity                     |
| ------------- | --------------------------------------------- | -------------------------------------------- |
| `development` | Local. Docker Compose for Redis and Postgres. | `<service>@0000000` placeholder sha          |
| `staging`     | Deployed from `main` on every merge.          | `<service>@<sha>`, `environment: staging`    |
| `production`  | Deployed from a tagged release.               | `<service>@<sha>`, `environment: production` |

Staging and production are **separate deployments with separate config**, but share one
Sentry project per service, distinguished by the `environment` tag rather than by
duplicate projects. That is how Sentry expects environments to be modelled and it halves
the quota footprint in an org we share with an unrelated product.

> **Provider chosen, provisioning held.** The board ratified Fly.io for M0–M5 at
> $120/month (→ $250 at M5, $400 ceiling) and then separately answered the
> payment-instrument question with _hold all provisioning_. Those are not in conflict: the
> budget line is real and the means to spend it does not exist, so ADR-0003 §12.3 is a
> costed, dormant plan. Sentry is unaffected; it is genuinely $0. Free compute tiers sleep
> on idle, which for a room runner holding authoritative state over a persistent socket is
> a _correctness_ failure, not a latency one. Nothing in this document assumes a host. §12
> records the conditions that bind the moment the hold lifts, and what free-tier staging
> can and cannot prove.
>
> **What the hold does and does not forbid** (ADR-0003 §8.7, resolved by the board). It
> forbids a **paid** account, a card on file, a paid tier, and a trial — on any provider,
> Fly and Hetzner included. It does **not** forbid a signup that completes with no payment
> instrument, so free-tier accounts on the four §8.1 vendors — Cloudflare Pages, Render,
> Upstash, Neon — are permitted, and the $0 topology may be stood up on them. If any of
> them asks for a card "for verification", or auto-converts from a trial, that is outside
> the permission: stop and escalate to the Chief of Staff rather than clicking through.

---

## 2. `apps/realtime`

Validated by `zod` at boot in `apps/realtime/src/env.ts`. A malformed value fails the
process immediately rather than surfacing as a confusing runtime error later.

| Variable                   | Required            | Default (local)                | Where the deployed value comes from                                                                             |
| -------------------------- | ------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `REALTIME_PORT`            | no                  | `3001`                         | Host-assigned (`PORT`-style binding)                                                                            |
| `DATABASE_URL`             | yes in staging/prod | local Compose Postgres         | Host's managed Postgres add-on / secret store                                                                   |
| `REDIS_URL`                | yes in staging/prod | local Compose Redis            | Host's managed Redis add-on / secret store                                                                      |
| `NODE_ENV`                 | no                  | `development`                  | Set to `production` by the runtime for any deployed build                                                       |
| `DEPLOY_ENV`               | yes in staging/prod | `development`                  | Set per environment in CI/host config. Drives the Sentry `environment` tag and the logger's `environment` field |
| `GIT_SHA`                  | yes in staging/prod | `0000000`                      | CI injects `github.sha`. Becomes the release name                                                               |
| `LOG_LEVEL`                | no                  | `debug` (`info` in production) | Host config; raise temporarily to debug an incident                                                             |
| `LOG_SAMPLE_RATE`          | no                  | `1`                            | Host config. Fraction of **non-lifecycle** events kept                                                          |
| `SENTRY_DSN`               | no                  | unset                          | Sentry project `playhall-realtime` — value in §3.1                                                              |
| `ENABLE_DEBUG_THROW_ROUTE` | no                  | `false`                        | `true` on staging only, to evidence the source-map pipeline. **Never production**                               |

## 3. `apps/web`

| Variable                   | Required            | Default (local)         | Where the deployed value comes from                                               |
| -------------------------- | ------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_REALTIME_URL` | yes                 | `http://localhost:3001` | Per-environment host config; `wss://` origin in staging/prod                      |
| `NEXT_PUBLIC_BRAND_NAME`   | no                  | internal codename       | Set once the board settles [PER-2](/PER/issues/PER-2). Never hard-coded in source |
| `NEXT_PUBLIC_BRAND_DOMAIN` | no                  | empty                   | Same                                                                              |
| `DEPLOY_ENV`               | yes in staging/prod | `development`           | Same source as realtime                                                           |
| `GIT_SHA`                  | yes in staging/prod | `0000000`               | CI injects `github.sha`                                                           |
| `NEXT_PUBLIC_SENTRY_DSN`   | no                  | unset                   | Sentry project `playhall-web` — value in §3.1                                     |
| `SENTRY_AUTH_TOKEN`        | CI only             | —                       | **Secret.** CI only, never in a runtime environment or a browser bundle           |

`NEXT_PUBLIC_*` values are inlined into the client bundle. Nothing secret may ever carry
that prefix. A Sentry DSN is a write-only ingest key, so it is safe there; an auth token
is not, and lives only in CI.

### 3.1 The DSNs

Org `hashtrust-tz` (US region, `https://us.sentry.io`), team `playhall`, one project per
service. A DSN grants **write-only ingest** — it cannot read an event back, list an issue
or touch another project — so it belongs in config, in the open, not in secret storage.
The web value ships inside the browser bundle by design; treating it as a secret would be
theatre.

| Service         | Variable                 | Value                                                                                             |
| --------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `apps/web`      | `NEXT_PUBLIC_SENTRY_DSN` | `https://f9dac62ce1e63ffbaba975d070e81a2c@o4511157987573760.ingest.us.sentry.io/4512173853573120` |
| `apps/realtime` | `SENTRY_DSN`             | `https://57c2b07e74de89106179e193f7cfa82a@o4511157987573760.ingest.us.sentry.io/4512173853966336` |

Set in staging and production host config. **Deliberately unset in `development`**: a
laptop reporting into a free-tier quota shared with an unrelated product spends someone
else's headroom, and the logging fallback already makes the error visible locally.

## 4. CI-only

| Variable            | Used by                              | Source                                                                             |
| ------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN` | Release creation + source-map upload | Paperclip secret `sentry_auth_token` (PER-40), injected as an env var. **Secret.** |
| `SENTRY_ORG`        | Same                                 | `hashtrust-tz` (shared org, team `playhall`)                                       |
| `SENTRY_PROJECT`    | Same                                 | `playhall-web` or `playhall-realtime`                                              |

**Measured scope coverage** (probed 2026-09-30, not assumed — the scopes a token was
requested with and the scopes it has are different facts):

| Endpoint                                        | Result | Needed for                      |
| ----------------------------------------------- | ------ | ------------------------------- |
| `POST /organizations/{org}/releases/`           | `201`  | Create the release              |
| `POST /organizations/{org}/releases/{v}/files/` | `201`  | Upload bundle + source map      |
| `GET /organizations/{org}/`                     | `403`  | — (`org:read`, not granted)     |
| `GET /organizations/{org}/projects/`            | `403`  | — (`project:read`, not granted) |

The token carries `project:releases` and not the two read scopes. That is **sufficient**:
the release-and-upload path is the whole of what CI needs, and it is the path the
acceptance criterion tests. Do not add a `sentry-cli info` style preflight to CI — it
would fail on a token that is otherwise entirely adequate. Note also that Sentry auth
token scopes are **fixed at creation**; widening them means minting a new token, not
editing this one.

Source-map upload is **gated on `SENTRY_AUTH_TOKEN` being present** and skipped with a
loud warning when it is absent, so CI is not red on a missing credential — never silently
disabled.

---

## 5. Release identity

Release names are **fully qualified**: `<service>@<git-sha>`, e.g.
`playhall-realtime@2fba49a`. Never a bare sha. Our Sentry org is shared with an unrelated
product, and a bare sha collides across projects and resolves the wrong source map —
exactly the failure this ticket exists to prevent. `formatRelease()` in
`packages/shared/src/telemetry/release.ts` refuses to produce or parse a bare sha.

## 6. Structured logging

Newline-delimited JSON on stdout, pino-compatible field names (`level` as a number,
`time`, `msg`). Every line carries `service`, `release`, `environment`. Every scoped line
also carries **`correlationId` and `roomId`, which are distinct**: the correlation id
follows one player's causal chain across hops, the room id groups every player in a match.
Filtering by either has to work.

Filter one chain out of the stream:

```bash
jq -c --arg cid xkz5nclln4oebmk6omlaejczda 'select(.correlationId == $cid)' realtime.log
# ... and one room's whole life:
jq -c --arg room room_1 'select(.roomId == $room)' realtime.log
```

Two properties are load bearing and both are cheaper to keep than to retrofit:

1. **The sink is injected.** `packages/shared` never touches `process.stdout` and has no
   Node-only transport. If ADR-0003 lands on Cloudflare Durable Objects, the runtime is
   `workerd`, and moving is one file rather than every file. `pino` plugs in as a
   `LogSink` adapter inside `apps/realtime`, where Node-only code is allowed.
2. **The correlation id is a platform contract, not a web concern.** It is minted at the
   edge of the _first_ hop and carried across the web→realtime boundary as an explicit
   field (`correlationId` on the join/handshake message, `x-correlation-id` on HTTP) —
   never recovered from a Node request object or an `AsyncLocalStorage` that exists in one
   process. The moment web and realtime sit on different hosts, which every hosting
   candidate implies, an implicitly-propagated id stops correlating and "filter one room's
   logs" silently becomes untrue.

## 7. Event budget

The monthly infrastructure budget is **$0** ([PER-2](/PER/issues/PER-2)), so the free-tier
ceiling is configured deliberately rather than discovered in production. Stated in one
reviewable place, `DEFAULT_SAMPLING` in `packages/shared/src/telemetry/errors.ts`:

| Knob                       | Value             | Why                                                                            |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------ |
| Error sample rate          | `1.0`             | We want every error; at our volume there are not many                          |
| Traces sample rate         | `0`               | No latency question yet justifies spending a quota shared with another product |
| Session replay             | `0`               | The free allowance would be consumed by accident                               |
| Log level (production)     | `info`            |                                                                                |
| Non-lifecycle log sampling | `LOG_SAMPLE_RATE` | Per-action logs at 2,000 rooms would dominate CPU                              |

Room lifecycle events (`room.created`, `match.finished`, `client.version_gap`, …) and
anything at `error` or above are **never** sampled away. The point of sampling is to shed
volume from the hot path, not to lose the failures.

## 8. Scrubbing join capabilities

A lobby code is a **join capability** (ADR-0001 §6): whoever holds one can walk into a
private room. Shipping one to a third-party vendor is a security bug, not a privacy
preference — and so is writing one where a support tool can grep it.

One scrub, `packages/shared/src/telemetry/redact.ts`, guards **both** exits: the vendor
`beforeSend` hook and the structured logger. A scrub that only guards one of the two is
not a scrub. It is asserted by test, including a fuzz over 200 generated codes pushed
through every slot a vendor event has (message, url, query string, headers, cookies,
breadcrumbs, tags, extra, exception values), not by inspection.

Known limit, stated rather than hidden: a bare 6-character code in free-form prose with
no cue word and no URL around it survives, because blanket `[A-Z2-9]{6}` redaction mangles
ordinary text (`SERVER` and `CLIENT` are both legal codes). The rule that closes the gap:
**pass the code as a field, never interpolate it into a message.** Key matching then
catches it.

## 9. Static-asset egress must sit behind a free-egress CDN

Not an optimisation to do later — a line item in environment setup, from ADR-0003 §2.1.

At a 20-minute session length, 1,000 concurrent player slots generate ~2.19 M page
loads/month. At 400 KB of first load that is **~876 GB/month of static egress**, against
~526 GB/month of WebSocket egress for the same players — static is ~1.7× the socket
traffic. Every cost figure in ADR-0003 excludes it _on the assumption that a free-egress
CDN fronts `apps/web`_. Unfronted, it adds ~$18/month on Fly and ~$131/month on Render,
which on Render would be over half the bill.

So: `apps/web` static output is served through a free-egress CDN (Cloudflare Pages
qualifies, and is where `apps/web` goes rather than onto Fly) in both staging and
production. The wiring cannot land until the provisioning hold lifts (§12), so it sits
with the pipeline on [PER-6](/PER/issues/PER-6); it is recorded
here so it is not rediscovered from an invoice.

## 10. The source-map pipeline, and how it was evidenced

The acceptance criterion is that a deliberately thrown error resolves to real source
lines. Per the CTO's ruling on PER-7 that is a property of the **release identity and the
source-map pipeline**, not of where the process runs, so it was evidenced on a build
carrying the staging release identity rather than waiting on
[PER-6](/PER/issues/PER-6).

The pipeline, and the step that breaks each link if you get it wrong:

1. **Build with `pnpm --filter @playhall/realtime build:release`**, which asserts its own
   source-map paths. See §10.1 — this step used to be a written instruction, and the
   instruction was broken by the first build that followed it.
2. **Create the release as `<service>@<sha>`** — `POST /organizations/{org}/releases/`
   with `projects: ["playhall-realtime"]`.
3. **Upload both files under `~/<path>` names** — `index.js` _and_ `index.js.map`. The
   minified file matters: Sentry follows its `//# sourceMappingURL` comment to find the
   map.
4. **Emit frames as `app:///<path>`** so they match the `~/<path>` artifact names.
   `toArtifactPath()` in `apps/realtime/src/sentry.ts` does this and is unit-tested. This
   is the link that fails silently: get it wrong and events still arrive, just minified.

Measured on `playhall-realtime@3dacaff2a44190aeb83ff6ea60cf4fa63b77a02e`:

| Step                                            | Result                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Create release                                  | `HTTP 201`                                                              |
| Upload `~/dist/index.js`, `~/dist/index.js.map` | `HTTP 201` each; confirmed by listing the release's files               |
| Ingest the event                                | `HTTP 200`, Sentry returned event id `b4c67daee3b5d14bed0206f929963310` |
| Frame emitted by the adapter                    | `app:///dist/index.js 7:2423`, `in_app: true`                           |
| That frame through the uploaded map             | `apps/realtime/src/index.ts 81:19` — the `new Error(...)` line          |

**Not verified, stated rather than implied:** Sentry's own rendering of the symbolicated
trace was not read back. The `sentry_auth_token` carries `project:releases` and not
`project:read` (§4), so this agent cannot query an issue through the API, and the Sentry
MCP session expired mid-run. What is proved is that Sentry holds the artifacts, accepted
the event, and that the frame the event carries resolves against those exact artifacts.

**Since read back and confirmed** by the Chief of Staff in the Sentry UI:
`PLAYHALL-REALTIME-1`, event `b4c67daee3b5d14bed0206f929963310` renders
`apps/realtime/src/index.ts:81:19` with four lines of surrounding source context. Tags
read `environment: staging`, `release: playhall-realtime@3dacaff…`. The render is the
stronger evidence: Sentry can only turn `app:///dist/index.js 7:2423` into a named `.ts`
line with source text if it read the map uploaded against that exact release. **The
criterion is met, end to end, on the pipeline.**

### 10.1 Why step 1 is a script and not an instruction

The same read-back showed the frame's path as
`../../../../../../../Users/<name>/…/.worktrees/per-7/apps/realtime/src/index.ts`, and
Sentry used that string as the issue **culprit** — the one-line identity shown in every
issue list, alert and digest. Two costs, neither recoverable after the fact: the trace is
unreadable to anyone on a different machine, and a username plus an internal directory
layout is now on a third-party record we do not delete.

This section previously said "build from inside the repo … verified: an in-tree build
yields `../../../packages/shared/…`". That instruction was correct about the mechanism —
a bundler computes `sources` relative to the outfile — and useless as a control, because
an out-of-tree build still succeeds. Nothing checked the outcome, so the very first build
to follow the instruction broke it silently. There was also no release build script at all
(`build` is `tsc --noEmit`), so the evidence bundle came from an ad-hoc `esbuild`
invocation nobody could re-run.

`apps/realtime/build.mjs` now owns the build and asserts, before anything can upload:

| Property                                                    | Why it is the one that matters                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Every `sources` entry is repo-root-relative                 | This is the string Sentry renders and uses as the culprit. `..` in a rewritten path is the escape signal. |
| Every `sources` entry names a file that exists in this repo | A clean-looking path that resolves to nothing symbolicates nothing.                                       |
| `apps/realtime/src/index.ts` is present                     | Makes the check falsifiable: a map can be clean and still not contain the module a reader will click.     |
| `sourceRoot` is cleared                                     | Sentry joins it onto every source, so a leftover root silently undoes the rewrite for the whole release.  |
| The bundle carries `//# sourceMappingURL=`                  | Sentry follows it to find the map. Missing it means every frame arrives minified, with no other symptom.  |

Measured on this branch, `pnpm --filter @playhall/realtime build:release`:

```
✓ built apps/realtime/dist/index.js  (145.0 KB)
✓ 25 sources, all repo-relative and present on disk
✓ entry module resolves as apps/realtime/src/index.ts
```

`sourceRoot` is absent, 25 `sourcesContent` entries are embedded so context lines render,
and `grep -c '/Users/<name>'` over the emitted `.map` returns **0**.

**What this retires.** Normalising the map makes the outfile's location irrelevant:
measured, building to a directory outside the repository now emits the same clean paths
and the same zero home-directory occurrences. So "build in-tree" is no longer a rule
anyone has to remember. The escape branch is covered by unit tests
(`apps/realtime/test/sourcemap-paths.test.mjs`) rather than by a build, because no build
can reach it any more — a guard nothing exercises is a comment.

The same invariant lives once, in `scripts/release/sourcemap-paths.mjs`, because
`apps/web` needs it too and must not re-derive it.

## 11. Still open on this issue

| Item                                                                     | Owner                                         | Unblock action                                                                                            |
| ------------------------------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Sentry adapter for `apps/web`                                            | Platform Engineer                             | Use `@sentry/nextjs` there — browser specifics earn the bytes; pass `scrubEventForVendor` as `beforeSend` |
| Release + source-map upload as a CI step                                 | Platform Engineer, [PER-6](/PER/issues/PER-6) | The four steps in §10, gated on `SENTRY_AUTH_TOKEN`. Step 1 is `build:release`, which self-checks (§10.1) |
| Deployed staging/production environments, CDN wiring                     | Platform Engineer, [PER-6](/PER/issues/PER-6) | Needs the provisioning hold lifted (§12)                                                                  |
| Measured staging action round-trip p95 (< 150 ms target)                 | Platform Engineer, ADR-0003 §9                | Needs a staging deploy — see §12.2, not discoverable without an account                                   |
| Measured Sentry browser bundle cost (ADR-0001 §8 estimates ~25–30 KB gz) | Platform Engineer                             | Needs the browser SDK actually installed                                                                  |

## 12. The provisioning hold

The board ratified Fly.io for M0–M5 and then held all provisioning pending a payment
instrument (§1). This section exists so the conditions and the open measurements are not
rediscovered later — from an invoice, or from a failed deploy.

### 12.1 Conditions that bind the moment the hold lifts

None of these costs anything to honour today, and all are expensive to retrofit.

| Condition                                                                                                       | Why it is not free to change                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Region `sin`, never `bom`.**                                                                                  | Fly deleted the Mumbai region on 2026-09-25 ([superfly/docs#2508](https://github.com/superfly/docs/pull/2508)). A `bom` deploy does not degrade — it fails.                                                                                                                                                    |
| **Postgres co-located with `apps/realtime`.**                                                                   | ADR-0001 rev 2 §6.2 puts a synchronous durable log append on the action hot path at ≤ 10 ms p95. That budget is nearly all round trips, so a cross-provider hop (5–15 ms before fsync) blows it structurally.                                                                                                  |
| **Redis self-run under our own `redis.conf`**, not a managed KV.                                                | Configuration control: we need an eviction policy we can pin in config and assert in a test, not a vendor default.                                                                                                                                                                                             |
| **Presence heartbeat interval is per-environment config, bidirectional — not a constant.**                      | Fly's proxy idle timeout is ~30 s so it needs ≤ 10 s there; free-tier staging wants ~25 s to stay inside a command quota. A quiet turn-based game sends nothing in _either_ direction, which one-directional misses. Code lands with [PER-15](/PER/issues/PER-15); the key must be config-shaped when it does. |
| **`apps/web` static output behind a free-egress CDN.**                                                          | §9. Every cost figure in ADR-0003 assumes it.                                                                                                                                                                                                                                                                  |
| **No Node-only APIs in `packages/platform-core`, `packages/shared` or the room runner; logging sink injected.** | Keeps the Cloudflare Durable Objects escape hatch open — the only $0 always-on path that is not a correctness failure. Already honoured: see §6.                                                                                                                                                               |

### 12.2 Three measurements still owed, none discoverable without an account

These were going to be settled by provisioning. The hold defers them, it does not
retire them.

1. **Mumbai↔Singapore p95 RTT.** Estimated 60–90 ms, **unverified**. The most
   consequential unmeasured number in ADR-0003: at that range, 40–60% of the 150 ms
   turn-based budget is spent before our code runs. If it comes in over, the provider
   decision reopens — so it is measured on the **first** staging deploy, not the last.
2. **Is Fly Managed Postgres offered in `sin`?** Unverified, and a precondition of the
   co-location condition above. If it is not, stop and escalate to the CTO rather than
   reaching for an off-Fly managed Postgres.
3. **Does Fly `autostop` drop an open WebSocket?** Fly Proxy stops machines on a
   concurrency `soft_limit` rather than a wall-clock idle timer, which is why autostop
   staging is safe where free-tier sleeping was not — but the docs do not address open
   sockets at stop time. Verify on the first staging deploy.

### 12.3 What free-tier staging can and cannot evidence

Stated up front so a green staging demo is never read as evidence it does not carry.

| Claim                                      | Free-tier staging proves it? |
| ------------------------------------------ | ---------------------------- |
| WebSocket round trip works (M0 AC2)        | Yes                          |
| A shareable link for the board (M0 AC5)    | Yes                          |
| Source-map pipeline resolves a trace (§10) | Yes — it is host-independent |
| Action round-trip p95 < 150 ms             | No                           |
| Timer/clock correctness                    | No                           |
| Restart survival, crash recovery           | No                           |
| Capacity (2,000 concurrent rooms)          | No                           |

**Timer correctness cannot be evidenced on sleeping compute**, and this is the trap worth
naming: a chess clock has to keep running while nobody is moving, which is exactly the
condition that sleeps a free instance. Timers are tested against the local
`docker-compose` stack, and a green staging run is not evidence either way.

---

## 13. Measurement record: every number carries the provider and tier it came from

A target and a measurement venue are different things, and conflating them is a mistake
this project has now made three times — the `< 150 ms p95` turn-based target, the M5
2,000-room load test, and ADR-0009's AC2b measurements. In each case the target is real
and the venue is not what the document assumed. **Recording the venue is what stops a
budget being read later as a measurement.**

So the rule, for anything measured on this issue or downstream of it:

> **No unqualified number.** Write `idle-socket survival: 14m 50s (Render free)`, never
> `idle-socket survival: 14m 50s`. An unlabelled figure gets read as describing whichever
> provider the reader has in mind, and outlives the context that produced it.

### 13.1 AC2b — round-trip RTT, cold-start wake, idle-socket survival

ADR-0009 §Evidence puts these three on [PER-7](/PER/issues/PER-7), and argues for buying
them in M0 rather than M1 because the hosting choice is "still cheap to unwind" — that is,
on the assumption they would describe **Fly.io**, which ADR-0003 chose. Under the
provisioning hold they will not. The implemented topology is Cloudflare Pages + **Render
free** + Upstash free + Neon free, so what is measurable today is Render's edge.

| Measurement          | Venue when taken                  | Status                                                                                            |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| Round-trip RTT       | Render free (Cloudflare in front) | Not yet taken — needs the free topology stood up                                                  |
| Cold-start wake time | Render free                       | Not yet taken                                                                                     |
| Idle-socket survival | Render free                       | Not yet taken                                                                                     |
| Round-trip RTT       | **Fly.io `sin`**                  | **Still owed.** Due when provisioning resumes — board revisit at M3, [PER-29](/PER/issues/PER-29) |
| Cold-start wake time | **Fly.io `sin`**                  | **Still owed**, same gate                                                                         |
| Idle-socket survival | **Fly.io `sin`**                  | **Still owed**, same gate                                                                         |

The Fly rows are deferred, not dropped. They are written here rather than only in a
comment so they survive this issue closing.

### 13.2 On Render free, idle-socket survival is not an idle-timeout measurement

Render free spins the **whole service** down after ~15 minutes without traffic. So a
socket that dies silently near the 15-minute mark is the process being stopped, not an
edge proxy closing an idle connection — two different failures with the same symptom, and
only one of them is the thing AC2b is asking about.

When the number is taken it must say which of the two it measured. **If the two cannot be
distinguished from the client side, record that they could not be** rather than picking the
more convenient reading. Distinguishing them needs a server-side signal: a log line at
shutdown, or the close code and whether the service answers an HTTP probe immediately
after. Fly is the cleaner venue precisely because its autostop is concurrency-driven
rather than a wall-clock idle timer, which is why the Fly row above is the one that
actually answers the question.

Unaffected: AC2a ([PER-94](/PER/issues/PER-94)) is local and CI, against our own artifact,
with no provider in the path.
