#!/usr/bin/env node
/**
 * One deploy entry point for every environment and every target.
 *
 * The hosting provider is a board decision that is still open (PER-2), and this
 * issue is explicitly told not to sign up for anything. That is a constraint on
 * *which provider*, not on the pipeline — so the pipeline is built now against
 * a provider interface, and the provider is one `DEPLOY_PROVIDER` variable plus
 * its secrets away.
 *
 * Contract:
 *   in  — env DEPLOY_PROVIDER, DEPLOY_ENV (preview|production), DEPLOY_TARGET
 *         (web|realtime), plus whatever the chosen provider needs.
 *   out — `url` and `status` on $GITHUB_OUTPUT. `status` is one of
 *         `deployed` | `not_configured`. Exit code is non-zero only for a real
 *         deploy failure; "no provider configured" is a clean skip, because a
 *         board decision that has not been made is not a build break.
 *
 * Adding a provider means adding one entry to PROVIDERS. Nothing else changes —
 * not the workflows, not the smoke test, not the uptime probe.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'

const provider = (process.env.DEPLOY_PROVIDER ?? 'none').trim().toLowerCase()
const environment = requireOneOf('DEPLOY_ENV', ['preview', 'production'])
const target = requireOneOf('DEPLOY_TARGET', ['web', 'realtime'])

const PROVIDERS = {
  /**
   * The current, deliberate default. Keeps PRs and `main` merges green while
   * the provider decision is open, and states the blocker in the run log rather
   * than leaving a mystery skip.
   */
  none() {
    console.log(
      '::notice title=Deploy not configured::No hosting provider is configured, so the ' +
        `${environment} deploy of "${target}" was skipped. The provider is a board decision ` +
        'tracked on PER-2. To activate: set the repo variable DEPLOY_PROVIDER and the ' +
        "provider's secrets (see docs/ci-cd.md, Activating deploys). No code change needed.",
    )
    return { status: 'not_configured', url: '' }
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
    run('pnpm', ['--filter', '@atrium/web', 'build'])

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
          'environments are a paid Render feature. ADR-0003 §8 records this — per-PR ' +
          'previews are web-only until the board answers the budget question (PER-2), and ' +
          'M0 AC1 is "partially met", not met.',
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
    `Unknown DEPLOY_PROVIDER "${provider}". Known: ${Object.keys(PROVIDERS).join(', ')}. ` +
      'Add a provider in scripts/deploy/deploy.mjs — do not special-case it in a workflow.',
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
    throw new Error(`Render API ${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`)
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
