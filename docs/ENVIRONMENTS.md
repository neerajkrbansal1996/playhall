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

> **Open, and not ours to decide.** Where staging and production actually run is
> board-gated on [PER-38](/PER/issues/PER-38) / ADR-0003. Free compute tiers sleep on
> idle, which for a room runner holding authoritative state over a persistent socket is a
> _correctness_ failure, not a latency one. Nothing in this document assumes a host.

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

So: `apps/web` static output is served through a free-egress CDN (Cloudflare's free plan
qualifies) in both staging and production. The concrete wiring depends on which host the
board picks, so it lands with the pipeline on [PER-6](/PER/issues/PER-6); it is recorded
here so it is not rediscovered from an invoice.

## 10. Still open on this issue

| Item                                                                     | Owner                                         | Unblock action                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sentry projects `playhall-web` / `playhall-realtime` and their DSNs      | user, [PER-40](/PER/issues/PER-40)            | Add `project:write` to the token scopes, or create the two projects by hand under the `playhall` team. The org has _Let members create projects_ disabled, so the agent connection gets HTTP 403 |
| `SENTRY_AUTH_TOKEN` for release + source-map upload                      | user, [PER-40](/PER/issues/PER-40)            | Save as Paperclip secret `sentry_auth_token`                                                                                                                                                     |
| Vendor `ErrorReporter` adapters in both apps                             | Platform Engineer                             | Needs a DSN first                                                                                                                                                                                |
| Deployed staging/production environments, CDN wiring                     | Platform Engineer, [PER-6](/PER/issues/PER-6) | Needs the ADR-0003 hosting decision                                                                                                                                                              |
| Measured staging action round-trip p95 (< 150 ms target)                 | Platform Engineer, ADR-0003 §9                | Needs a staging deploy                                                                                                                                                                           |
| Measured Sentry browser bundle cost (ADR-0001 §8 estimates ~25–30 KB gz) | Platform Engineer                             | Needs the browser SDK actually installed                                                                                                                                                         |
