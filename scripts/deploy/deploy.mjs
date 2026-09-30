#!/usr/bin/env node
/**
 * One deploy entry point for every environment and every target.
 *
 * The board chose **Fly.io** for M0–M5 with $120/month of spend authority
 * (PER-2, detail on PER-38), and named **per-PR previews the top spend
 * priority**. `fly` is therefore the provider to set; the others are kept
 * because they are still the right answer for specific jobs — Cloudflare Pages
 * for free-egress static hosting, Render for a free staging service.
 *
 * The indirection is not hedging. A provider is one `DEPLOY_PROVIDER` variable,
 * so switching hosts is a settings change, and no workflow names a vendor. That
 * matters at M5, when the region decision is revisited.
 *
 * Nothing here provisions infrastructure. Apps, `fly.toml`, Redis and Postgres
 * belong to PER-7 — a deploy script that creates billable resources on demand
 * is how a $120/month cap becomes a $400 one.
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
   * The default until the Fly apps and secrets exist. Keeps PRs and `main`
   * green and states *why* in the run log, rather than leaving a mystery skip
   * that everyone learns to scroll past.
   */
  none() {
    console.log(
      '::notice title=Deploy not configured::DEPLOY_PROVIDER is not set; skipping the ' +
        `${environment} deploy of "${target}". This is the expected state of the repo today, ` +
        'not a broken build. Hosting is ADR-0003 (docs/adr/0003-hosting-and-cost-model.md): ' +
        'the board chose Fly.io with $120/month of spend authority (PER-2, detail on PER-38), ' +
        'and what is still missing is the provisioned apps and secrets, which are PER-7. ' +
        'To activate: set DEPLOY_PROVIDER=fly ' +
        'plus FLY_API_TOKEN and the FLY_APP_* names (see docs/ci-cd.md, Activating deploys). ' +
        'No code change needed.',
    )
    return { status: 'not_configured', url: '' }
  },

  /**
   * Fly.io — **the board's choice** for M0–M5 ($120/month authorised on
   * [PER-2], detail on PER-38). Region `bom` (Mumbai) as the interim placement;
   * "which regions v1 serves" is deferred to M5 and moving a turn-based
   * deployment is cheap.
   *
   * Handles both targets, which is the point: Fly runs persistent processes, so
   * `apps/realtime` can hold WebSocket connections and later a 30 Hz tick loop
   * on dedicated CPU. That is what Pages and serverless could not do.
   *
   * Two things this adapter does *not* do, deliberately:
   *   * it does not create apps or write `fly.toml` — provisioning is PER-7's
   *     staging/environment work, and a deploy script that silently creates
   *     billable infrastructure is how a $120 cap becomes a $400 surprise;
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
          'deploy script that creates billable infrastructure on demand is how a $120/month ' +
          'cap becomes a surprise.',
      )
    }

    const config =
      process.env.FLY_CONFIG ?? `apps/${target === 'web' ? 'web' : 'realtime'}/fly.toml`
    if (!existsSync(config)) {
      throw new Error(
        `DEPLOY_PROVIDER=fly needs ${config}, which does not exist. The Fly app definition ` +
          '(including the `bom` primary region and the health check) is provisioned on PER-7.',
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
    requireEnv(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'])

    const project = process.env.CLOUDFLARE_PAGES_PROJECT ?? 'playhall-web'
    run('pnpm', ['--filter', './apps/web', 'build'])

    // `--branch` is what makes Pages treat this as a preview rather than a
    // production deployment; its production branch is configured on the project.
    const branch =
      environment === 'production'
        ? (process.env.CLOUDFLARE_PAGES_PRODUCTION_BRANCH ?? 'main')
        : (process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? 'preview')

    const out = run('pnpm', [
      'dlx',
      'wrangler@latest',
      'pages',
      'deploy',
      'apps/web/.next',
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
          'environments are a paid Render feature. Since the board authorised $120/month on ' +
          'Fly.io and named per-PR previews the top spend priority, use DEPLOY_PROVIDER=fly ' +
          'for previews. Render stays available for a free staging service.',
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

const impl = PROVIDERS[provider]
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
