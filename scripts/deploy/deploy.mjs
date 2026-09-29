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
   * Vercel covers `web` only — it has no persistent-process runtime, so it
   * cannot hold the WebSocket connections apps/realtime needs. Documented in
   * docs/ci-cd.md so the board's cost question is answered for both halves of
   * the system, not just the cheap half.
   */
  vercel() {
    if (target !== 'web') {
      throw new Error(
        `DEPLOY_PROVIDER=vercel cannot host "${target}". Vercel has no persistent-process ` +
          'runtime, and apps/realtime needs one. Configure a separate provider for realtime.',
      )
    }
    requireEnv(['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'])

    const prodFlags = environment === 'production' ? ['--prod'] : []
    const tokenFlag = `--token=${process.env.VERCEL_TOKEN}`
    run('pnpm', ['dlx', 'vercel@latest', 'pull', '--yes', `--environment=${environment}`, tokenFlag])
    run('pnpm', ['dlx', 'vercel@latest', 'build', ...prodFlags, tokenFlag])
    const out = run('pnpm', ['dlx', 'vercel@latest', 'deploy', '--prebuilt', ...prodFlags, tokenFlag])

    return { status: 'deployed', url: lastLine(out) }
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
  result = impl()
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
