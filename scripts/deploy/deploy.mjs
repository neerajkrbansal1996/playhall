#!/usr/bin/env node
/**
 * One deploy entry point for every environment and every target.
 *
 * **No provider is active, and activating one is a board decision, not a
 * variable.** The board has held all provisioning — no vendor account, no card
 * on file, no paid tier, no trial, on any provider. `none` is therefore the
 * default and the only correct setting today. See ADR-0003 §13
 * (`docs/adr/0003-hosting-and-cost-model.md`), which is the record of the hold;
 * §12's buy-list is costed, ratified and **dormant**.
 *
 * Deliberately no figures, envelopes or spend priorities in this file. Those
 * live in ADR-0003 and change there; a number duplicated into a comment is a
 * number that goes stale where nobody is looking.
 *
 * The provider indirection is not hedging. A provider is one `DEPLOY_PROVIDER`
 * variable, so switching hosts is a settings change and no workflow names a
 * vendor. That matters at M5, when the region decision is revisited.
 *
 * Nothing here provisions infrastructure. Apps, `fly.toml`, Redis and Postgres
 * belong to PER-7 — a deploy script that creates billable resources on demand
 * is how a hold gets breached by a script nobody read.
 *
 * Contract:
 *   in  — env DEPLOY_PROVIDER, DEPLOY_ENV (preview|staging|production),
 *         DEPLOY_TARGET (web|realtime), plus whatever the provider needs.
 *         An unset or empty DEPLOY_PROVIDER means `none`, not "misconfigured".
 *   out — `url` and `status` on $GITHUB_OUTPUT. `status` is one of
 *         `deployed` | `not_configured`. Exit code is non-zero only for a real
 *         deploy failure or a provider name that is set but unrecognised;
 *         "no provider configured" is a clean skip, because infrastructure that
 *         has not been provisioned yet is not a build break.
 *
 * Adding a provider means adding one entry to PROVIDERS. Nothing else changes —
 * not the workflows, not the smoke test, not the uptime probe.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'

// `??` alone is not enough. `.github/actions/deploy` always sets
// DEPLOY_PROVIDER, and sets it to the empty string when the `DEPLOY_PROVIDER`
// repo variable is unset — so the value arrives as "" rather than undefined.
// Unset, empty and whitespace all mean the same thing, "not configured yet",
// and must resolve to `none`. A value that *is* set but unrecognised is a typo
// and must still fail loudly; that distinction is unset vs. wrong.
const provider = (process.env.DEPLOY_PROVIDER ?? '').trim().toLowerCase() || 'none'
const environment = requireOneOf('DEPLOY_ENV', ['preview', 'staging', 'production'])
const target = requireOneOf('DEPLOY_TARGET', ['web', 'realtime'])

const PROVIDERS = {
  /**
   * The default, and correct while the provisioning hold stands. Keeps PRs and
   * `main` green and states *why* in the run log, rather than leaving a mystery
   * skip that everyone learns to scroll past.
   *
   * The notice deliberately does **not** print the steps to turn a provider on.
   * Under a hold, an activation runbook in every run log is an instruction to
   * breach it, addressed to the person most likely to follow it.
   */
  none() {
    console.log(
      '::notice title=Deploy not configured::DEPLOY_PROVIDER is not set; skipping the ' +
        `${environment} deploy of "${target}". This is the expected state of the repo today, ` +
        'not a broken build. **The board has held all provisioning** — no vendor account, no ' +
        'card on file, no paid tier, no trial, on any provider — so there is no host to deploy ' +
        'to and no variable you should set to make one. Turning a provider on needs a board ' +
        'decision lifting the hold first; it is not a settings change. Context and what would ' +
        'lift it: ADR-0003 §13 (docs/adr/0003-hosting-and-cost-model.md). Once the hold is ' +
        'lifted, PER-7 provisions and docs/ci-cd.md says what to set — no code change here.',
    )
    return { status: 'not_configured', url: '' }
  },

  /**
   * Fly.io — the provider the board settled on for M0–M5, and **not one that
   * may be used yet**: the provisioning hold (ADR-0003 §13) means no Fly
   * account exists. This adapter is here so that lifting the hold is a
   * settings change rather than a code change. It is not a green light.
   *
   * Region comes from `fly.toml`, which PER-7 writes against ADR-0003 §5.5b —
   * deliberately not named here, because Fly deletes regions and a region name
   * copied into a comment is one more place for it to go stale.
   *
   * Handles both targets, which is the point: Fly runs persistent processes, so
   * `apps/realtime` can hold WebSocket connections and later a 30 Hz tick loop
   * on dedicated CPU. That is what Pages and serverless could not do.
   *
   * Two things this adapter does *not* do, deliberately:
   *   * it does not create apps or write `fly.toml` — provisioning is PER-7's
   *     staging/environment work, and a deploy script that silently creates
   *     billable infrastructure is how a hold becomes a bill;
   *   * it does not front static assets with a CDN. Static egress is ~1.7× the
   *     WebSocket egress (ADR-0003 §2.1) and must sit behind free-egress CDN.
   *     Also PER-7.
   */
  fly() {
    requireEnv(['FLY_API_TOKEN'])

    const appVar = target === 'web' ? 'FLY_APP_WEB' : 'FLY_APP_REALTIME'
    const app = process.env[appVar]
    if (!app) {
      throw new Error(
        `DEPLOY_PROVIDER=fly needs ${appVar} (the Fly app name for "${target}" in the ` +
          `${environment} environment). Apps are provisioned on PER-7, not created here — a ` +
          'deploy script that creates billable infrastructure on demand is how a provisioning ' +
          'hold gets breached. Provisioning is currently held by the board (ADR-0003 §13).',
      )
    }

    const config =
      process.env.FLY_CONFIG ?? `apps/${target === 'web' ? 'web' : 'realtime'}/fly.toml`
    if (!existsSync(config)) {
      throw new Error(
        `DEPLOY_PROVIDER=fly needs ${config}, which does not exist. The Fly app definition ` +
          '(primary region per ADR-0003 §5.5b, plus the health check) is provisioned on PER-7.',
      )
    }

    run('flyctl', [
      'deploy',
      '--config',
      config,
      '--app',
      app,
      // Build on Fly's builders rather than the runner: no Docker layer cache
      // to maintain in Actions, and it keeps the runner off the critical path.
      '--remote-only',
      // Fail rather than hang. The health probe is the readiness signal, but a
      // deploy that never converges should not burn the whole job timeout.
      '--wait-timeout',
      '300',
    ])

    // Fly app hostnames are deterministic, so there is nothing to parse out of
    // CLI output that could drift between flyctl versions.
    return { status: 'deployed', url: `https://${app}.fly.dev` }
  },

  /**
   * Cloudflare Pages — the recommended free path for `apps/web` (ADR-0003 §8).
   * Free, unlimited egress, and genuinely per-PR previews.
   *
   * Chosen over Vercel Hobby specifically because Hobby forbids commercial use
   * (ADR-0003 §5.6), which this project is. That is a licence problem, not a
   * cost one, so no amount of free tier makes it acceptable.
   *
   * Web only: Pages has no persistent-process runtime, so it cannot hold the
   * WebSocket connections `apps/realtime` needs.
   *
   * The board carved one exception to the provisioning hold for this adapter
   * (PER-111, board decision 2026-09-30): it connected Cloudflare on 29 Sep, the
   * morning before it set the hold, and Pages hosts a static site with no card.
   * So this is the one provider here that may be switched on for **staging web
   * only** at $0. `fly` remains the ratified provider for M0–M5 production; the
   * exception is a link, not a migration.
   *
   * **Still never executed.** The credential is the open item — see
   * docs/ci-cd.md → "The free staging link on Cloudflare Pages". Treat the first
   * run as a smoke test, not a deploy.
   *
   * What it uploads: `apps/web/out`, a real static export, built with
   * `PLAYHALL_STATIC_EXPORT=1` (see `apps/web/next.config.ts`). It previously
   * uploaded `apps/web/.next`, which is a build cache and not a servable Pages
   * artifact at all. The export deliberately drops `/api/health`, because that
   * route is `runtime = 'nodejs'` + `force-dynamic` on purpose and a prerendered
   * health payload answers about the build rather than the process. **So do not
   * point a health probe at a Pages URL** — `smoke` and `uptime.yml` expect
   * `/api/health` and would fail against this target by design.
   */
  'cloudflare-pages'() {
    if (target !== 'web') {
      throw new Error(
        `DEPLOY_PROVIDER=cloudflare-pages cannot host "${target}". Pages has no ` +
          'persistent-process runtime and apps/realtime needs one — set ' +
          'REALTIME_DEPLOY_PROVIDER to a provider that does (ADR-0003 §8 recommends Render ' +
          'for the free path).',
      )
    }
    if (environment === 'production') {
      throw new Error(
        'DEPLOY_PROVIDER=cloudflare-pages may not deploy production. The board approved ' +
          'the existing Cloudflare connection as a $0 staging-link exception to the ' +
          'provisioning hold (PER-111); Fly.io is the ratified provider for M0–M5 ' +
          'production (ADR-0003). Widening this is a board decision, not a variable.',
      )
    }

    // `staging` only — and this skip is the enforcement, not a caveat.
    //
    // `preview.yml` reads the same `DEPLOY_PROVIDER` variable, so without this
    // branch, setting the variable for the staging link would silently switch
    // per-PR web previews on too. The board recorded M0 AC1b as **not met**
    // rather than accept a web-only preview with no isolated realtime, Redis or
    // Postgres behind it, so turning one on as a side effect of a settings
    // change would quietly overturn a board decision. A clean skip keeps PRs
    // green and leaves the gap recorded where the board put it.
    if (environment !== 'staging') {
      console.log(
        `::notice title=Preview deploy skipped::DEPLOY_PROVIDER=cloudflare-pages serves the ` +
          `${'staging'} link only, so the ${environment} deploy of "${target}" is skipped. This ` +
          'is deliberate: the board recorded M0 AC1b (a preview deploy per PR) as not met ' +
          'because an isolated preview needs its own realtime service, Redis and Postgres, ' +
          'and a web-only preview URL is not that. Do not "fix" this by widening the ' +
          'adapter — see docs/ci-cd.md, "The free staging link on Cloudflare Pages".',
      )
      return { status: 'not_configured', url: '' }
    }

    requireEnv(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'])

    const project = process.env.CLOUDFLARE_PAGES_PROJECT ?? 'playhall-web-staging'
    run('pnpm', ['--filter', './apps/web', 'build'], { PLAYHALL_STATIC_EXPORT: '1' })

    // `--branch` decides production-vs-preview *inside the Pages project*: a
    // deployment on the project's production branch owns the durable
    // `<project>.pages.dev` hostname, anything else gets a per-deployment one.
    // Staging maps onto the Pages production branch because the one durable URL
    // the board can keep open is the whole point of the exception.
    const branch = process.env.CLOUDFLARE_PAGES_PRODUCTION_BRANCH ?? 'main'

    // Pinned like every action in this repo: `@latest` means the thing that runs
    // is not the thing that was reviewed.
    const out = run('pnpm', [
      'dlx',
      'wrangler@4.144.0',
      'pages',
      'deploy',
      'apps/web/out',
      `--project-name=${project}`,
      `--branch=${branch}`,
    ])

    return { status: 'deployed', url: firstUrl(out) }
  },

  /**
   * Render — the only free-tier candidate that runs a long-lived Node
   * WebSocket process (ADR-0003 §8), so it is the free path for
   * `apps/realtime`.
   *
   * Caveat worth knowing before reading a latency number off it: a Render free
   * service spins down after 15 minutes idle, so the first request after a
   * quiet period waits ~50 s. The health probe's retry budget absorbs that.
   * ADR-0003 §8 is explicit that a free-tier measurement is not evidence for or
   * against the < 150 ms p95 target.
   */
  async render() {
    requireEnv(['RENDER_API_KEY', 'RENDER_SERVICE_ID'])

    if (environment === 'preview') {
      throw new Error(
        'DEPLOY_PROVIDER=render cannot make a per-PR preview on the free tier: preview ' +
          'environments are a paid Render feature. No free-tier substitute exists, and ' +
          'provisioning a paid one is held by the board (ADR-0003 §13) — so an isolated per-PR ' +
          'preview is currently unavailable rather than misconfigured, and M0 AC1 is recorded ' +
          'as not met. Render stays available for a free staging service.',
      )
    }

    const serviceId = process.env.RENDER_SERVICE_ID
    const deploy = await renderApi(`/services/${serviceId}/deploys`, 'POST', {
      clearCache: 'do_not_clear',
    })

    console.log(`render: triggered deploy ${deploy.id} for ${serviceId}`)

    // The URL comes from the service record, not from the deploy response.
    const service = await renderApi(`/services/${serviceId}`, 'GET')
    const url = service.serviceDetails?.url ?? ''

    // Deliberately not polling the deploy to completion here: the health probe
    // in `.github/actions/deploy` is the real readiness signal, and it retries
    // long enough to cover both the build and a cold start. Two independent
    // waits would just be one of them lying.
    return { status: 'deployed', url }
  },

  /**
   * Escape hatch for a provider with no usable CLI: a committed, reviewed shell
   * script. It must print the deployed URL as its last line of stdout.
   */
  script() {
    const path = 'scripts/deploy/custom.sh'
    if (!existsSync(path)) {
      throw new Error(`DEPLOY_PROVIDER=script requires ${path}, which does not exist.`)
    }
    const out = run('bash', [path], { DEPLOY_ENV: environment, DEPLOY_TARGET: target })
    return { status: 'deployed', url: lastLine(out) }
  },
}

// `Object.hasOwn`, not a plain lookup: `PROVIDERS['constructor']` resolves up
// the prototype chain to `Object`, which is callable and returns `{}`. That
// walks straight past this check, "succeeds" with an undefined status, and
// exits 0 — a misconfigured provider name silently reported as a clean skip.
// `toString` and `valueOf` fail the same way. Own keys only.
const impl = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : undefined
if (!impl) {
  fail(
    `DEPLOY_PROVIDER is set to "${provider}", which is not a known provider. Known: ` +
      `${Object.keys(PROVIDERS).join(', ')}. An unset or empty DEPLOY_PROVIDER is a clean ` +
      'skip, so reaching this means the value is wrong rather than missing — fix the repo ' +
      'variable, or add the provider in scripts/deploy/deploy.mjs. Do not special-case a ' +
      'provider value in a workflow.',
  )
}

let result
try {
  result = await impl()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

if (result.status === 'deployed' && !/^https?:\/\//.test(result.url)) {
  fail(
    `Provider "${provider}" reported success but returned no usable URL (got "${result.url}"). ` +
      'A deploy with no reachable URL is a failed deploy — nothing downstream can smoke-test it.',
  )
}

setOutput('status', result.status)
setOutput('url', result.url)
console.log(
  `deploy: provider=${provider} env=${environment} target=${target} ` +
    `status=${result.status} url=${result.url || '(none)'}`,
)

function lastLine(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.at(-1) ?? ''
}

/**
 * Pulls the deployment URL out of CLI output. Unlike `lastLine`, this tolerates
 * a trailing progress or hint line, which `wrangler` emits after the URL.
 */
function firstUrl(text) {
  return text.match(/https?:\/\/[^\s'"]+/)?.[0] ?? ''
}

/** Render's REST API. Returns parsed JSON; throws with the body on non-2xx. */
async function renderApi(path, method, body) {
  const response = await fetch(`https://api.render.com/v1${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${process.env.RENDER_API_KEY}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  if (!response.ok) {
    // The path is safe to log; the token is in a header and never echoed.
    throw new Error(
      `Render API ${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`,
    )
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Render API ${method} ${path} returned non-JSON: ${text.slice(0, 300)}`)
  }
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
  // Provider CLIs put progress on stderr and the URL on stdout; surface both.
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`\`${command} ${args.join(' ')}\` exited ${result.status}`)
  }
  return result.stdout ?? ''
}

function requireOneOf(name, allowed) {
  const value = process.env[name]
  if (!value || !allowed.includes(value)) {
    fail(`${name} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(value)})`)
  }
  return value
}

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name])
  if (missing.length > 0) {
    throw new Error(
      `Provider "${provider}" is selected but these are not set: ${missing.join(', ')}. ` +
        'Add them as repository secrets.',
    )
  }
}

function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  appendFileSync(file, `${key}=${value}\n`)
}

function fail(message) {
  console.error(`::error title=Deploy failed::${message}`)
  process.exit(1)
}
