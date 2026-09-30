import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The probe contract between `scripts/deploy/deploy.mjs` and
 * `scripts/ci/health-probe.mjs` — PER-144.
 *
 * The defect these cases exist to keep dead: every workflow asks for
 * `health-path: /api/health`, which is right for a provider that runs a Node
 * process and a guaranteed 404 for one that uploads a static export with no
 * route handler in it. `cloudflare-pages` returned `status: 'deployed'`, which
 * opens the probe step's guard, and the probe then retried that 404 thirty
 * times and failed `staging (web)` on every push to `main`.
 *
 * It was latent rather than red only because `DEPLOY_PROVIDER` was unset. The
 * mismatch was recorded in a comment on the adapter, and a comment does not
 * fail a build — so the fix is that the adapter *declares* the path it served
 * and the composite action follows it. These cases assert the declaration,
 * because the composite action's own resolution step is three lines of bash
 * around it.
 *
 * Measured against the live host on 2026-09-30, which is what turned this from
 * predicted to confirmed: `/` -> 200, `/dev/settings-form` -> 200,
 * `/api/health` -> 404.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const probeScript = join(repoRoot, 'scripts', 'ci', 'health-probe.mjs')
const deployScript = join(repoRoot, 'scripts', 'deploy', 'deploy.mjs')

/** A real-looking sha, so a mismatch case cannot pass by both sides being junk. */
const DEPLOYED_SHA = '5814ca9f3b2d1e0a7c6b5a49382716f0d5e4c3b2'
const PREVIOUS_SHA = '33157bcf0a1b2c3d4e5f60718293a4b5c6d7e8f9'

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  )
})

/**
 * Serves one body at one path and a 404 everywhere else — which is precisely
 * the shape of the bug: the static export serves its pages and has no
 * `/api/health`.
 */
async function staticHost(routes: Record<string, unknown>): Promise<string> {
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    if (!Object.hasOwn(routes, path)) {
      response.writeHead(404, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>404</title>')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(routes[path]))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

/**
 * Async on purpose: the fake host runs in *this* process, so `spawnSync` would
 * block the event loop and the probe's first `fetch` would never be answered —
 * the run would hang with no output rather than fail.
 */
async function run(
  command: string,
  args: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<RunResult> {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })

  return { status, stdout, stderr }
}

/** One attempt and no delay: these cases assert the verdict, not the retry budget. */
const once = ['--attempts', '1', '--delay-ms', '1']

describe('health-probe --expect-commit', () => {
  const stamp = (commit: string) => ({ ok: true, service: '@playhall/web', commit })

  it('passes when the served stamp names the commit this deploy uploaded', async () => {
    const host = await staticHost({ '/deploy-stamp.json': stamp(DEPLOYED_SHA) })

    const result = await run(process.execPath, [
      probeScript,
      `${host}/deploy-stamp.json`,
      ...once,
      '--expect-commit',
      DEPLOYED_SHA,
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`commit=${DEPLOYED_SHA}`)
  })

  /**
   * The failure worth catching on a static host. There is no process to be
   * dead, so `ok: true` is a constant and a probe that only checked it would
   * pass against an edge still serving the previous upload.
   */
  it('fails when the edge is still serving a different build', async () => {
    const host = await staticHost({ '/deploy-stamp.json': stamp(PREVIOUS_SHA) })

    const result = await run(process.execPath, [
      probeScript,
      `${host}/deploy-stamp.json`,
      ...once,
      '--expect-commit',
      DEPLOYED_SHA,
    ])

    expect(result.status).toBe(1)
    // Both shas, because "health probe failed" against a 200 that is genuinely
    // healthy is the least debuggable message this script could emit.
    expect(result.stderr).toContain(PREVIOUS_SHA)
    expect(result.stderr).toContain(DEPLOYED_SHA)
    expect(result.stderr).toContain('serving a different build')
  })

  /**
   * `.github/actions/deploy` passes `--expect-commit` unconditionally, so every
   * process-backed provider sends an empty one. Empty must mean "do not check";
   * if it meant "expect the empty string", this flag would fail every existing
   * caller the day it landed.
   */
  it('treats an empty expectation as no expectation', async () => {
    const host = await staticHost({ '/api/health': { ok: true, service: '@playhall/web' } })

    const result = await run(process.execPath, [
      probeScript,
      `${host}/api/health`,
      ...once,
      '--expect-commit',
      '',
    ])

    expect(result.status).toBe(0)
  })

  it('leaves the plain 2xx + ok:true contract unchanged when the flag is absent', async () => {
    const host = await staticHost({ '/api/health': { ok: true, service: '@playhall/web' } })

    const result = await run(process.execPath, [probeScript, `${host}/api/health`, ...once])

    expect(result.status).toBe(0)
  })

  /**
   * The argument-order trap the script's own comment describes, one flag later:
   * a sha does not start with `--`, so leaving `--expect-commit` out of the
   * value-flag list would make it parse as the URL and probe a bare sha.
   */
  it('does not mistake the expected sha for the URL when the flag comes first', async () => {
    const host = await staticHost({ '/deploy-stamp.json': stamp(DEPLOYED_SHA) })

    const result = await run(process.execPath, [
      probeScript,
      '--expect-commit',
      DEPLOYED_SHA,
      `${host}/deploy-stamp.json`,
      ...once,
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('healthy:')
  })
})

/**
 * A scratch repo with the layout each adapter reaches for, plus fake provider
 * CLIs on PATH. Nothing here touches a network or a vendor account — the point
 * is the adapter's declared contract, not a real deploy.
 */
function scratchRepo(): { dir: string; binDir: string; outputFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-probe-'))
  mkdirSync(join(dir, 'apps', 'web', 'out'), { recursive: true })
  const binDir = join(dir, 'bin')
  mkdirSync(binDir)
  const outputFile = join(dir, 'github-output')
  writeFileSync(outputFile, '')
  return { dir, binDir, outputFile }
}

/** A provider CLI that succeeds and prints a URL, which is all the adapter reads. */
function fakeCli(binDir: string, name: string, url: string): void {
  const path = join(binDir, name)
  writeFileSync(path, `#!/bin/sh\necho "${url}"\n`)
  chmodSync(path, 0o755)
}

/**
 * `$GITHUB_OUTPUT` as the composite action would read it back.
 *
 * `get` throws on a missing key rather than returning `undefined`: an output
 * the script never wrote is the failure these cases exist to catch, and
 * `expect(undefined).toBe('/deploy-stamp.json')` reports it as a wrong value
 * instead of an absent one.
 */
function outputs(outputFile: string): { get: (key: string) => string } {
  const parsed = new Map<string, string>()
  for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
    if (line === '') continue
    const separator = line.indexOf('=')
    parsed.set(line.slice(0, separator), line.slice(separator + 1))
  }
  return {
    get(key) {
      const value = parsed.get(key)
      if (value === undefined) {
        throw new Error(
          `deploy.mjs wrote no "${key}" output. Wrote: ${[...parsed.keys()].join(', ') || '(nothing)'}`,
        )
      }
      return value
    },
  }
}

describe('deploy.mjs declares the path it actually served', () => {
  const PAGES_URL = 'https://playhall-web-staging.pages.dev'

  it('points a static Pages deploy at its stamp, not at the absent /api/health', async () => {
    const { dir, binDir, outputFile } = scratchRepo()
    fakeCli(binDir, 'pnpm', PAGES_URL)

    const result = await run(process.execPath, [deployScript], {
      cwd: dir,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        DEPLOY_PROVIDER: 'cloudflare-pages',
        DEPLOY_ENV: 'staging',
        DEPLOY_TARGET: 'web',
        CLOUDFLARE_API_TOKEN: 'test-token',
        CLOUDFLARE_ACCOUNT_ID: 'test-account',
        GITHUB_SHA: DEPLOYED_SHA,
        GITHUB_OUTPUT: outputFile,
      },
    })

    expect(result.status).toBe(0)
    const out = outputs(outputFile)
    expect(out.get('status')).toBe('deployed')
    // The assertion that is the whole issue: `deployed` opens the probe step's
    // guard, so the path it opens onto must not be the one that 404s.
    expect(out.get('probe-path')).toBe('/deploy-stamp.json')
    expect(out.get('probe-path')).not.toBe('/api/health')
    expect(out.get('probe-commit')).toBe(DEPLOYED_SHA)
  })

  it('writes the stamp into the uploaded artifact, satisfying the probe unchanged', async () => {
    const { dir, binDir, outputFile } = scratchRepo()
    fakeCli(binDir, 'pnpm', PAGES_URL)

    await run(process.execPath, [deployScript], {
      cwd: dir,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        DEPLOY_PROVIDER: 'cloudflare-pages',
        DEPLOY_ENV: 'staging',
        DEPLOY_TARGET: 'web',
        CLOUDFLARE_API_TOKEN: 'test-token',
        CLOUDFLARE_ACCOUNT_ID: 'test-account',
        GITHUB_SHA: DEPLOYED_SHA,
        GITHUB_OUTPUT: outputFile,
      },
    })

    // `apps/web/out` is what `wrangler pages deploy` uploads, so a stamp written
    // anywhere else would 404 exactly like the route it replaces.
    const stamp = JSON.parse(
      readFileSync(join(dir, 'apps', 'web', 'out', 'deploy-stamp.json'), 'utf8'),
    )
    // `ok: true` + `service` is the existing probe contract, which is why a
    // static target needed no second probe script and no "expect mode" switch.
    expect(stamp.ok).toBe(true)
    expect(stamp.service).toBe('@playhall/web')
    expect(stamp.commit).toBe(DEPLOYED_SHA)
  })

  /**
   * End to end over loopback: the stamp this adapter wrote satisfies the probe
   * the composite action runs. Without this the two halves are asserted
   * separately and could still disagree on shape.
   */
  it('produces a stamp the probe accepts', async () => {
    const { dir, binDir, outputFile } = scratchRepo()
    fakeCli(binDir, 'pnpm', PAGES_URL)

    await run(process.execPath, [deployScript], {
      cwd: dir,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        DEPLOY_PROVIDER: 'cloudflare-pages',
        DEPLOY_ENV: 'staging',
        DEPLOY_TARGET: 'web',
        CLOUDFLARE_API_TOKEN: 'test-token',
        CLOUDFLARE_ACCOUNT_ID: 'test-account',
        GITHUB_SHA: DEPLOYED_SHA,
        GITHUB_OUTPUT: outputFile,
      },
    })

    const stamp = JSON.parse(
      readFileSync(join(dir, 'apps', 'web', 'out', 'deploy-stamp.json'), 'utf8'),
    )
    const out = outputs(outputFile)
    const host = await staticHost({ [out.get('probe-path')]: stamp })

    const probe = await run(process.execPath, [
      probeScript,
      `${host}${out.get('probe-path')}`,
      ...once,
      '--expect-commit',
      out.get('probe-commit'),
    ])

    expect(probe.status).toBe(0)
  })

  /**
   * The counterpart, and the reason this is additive rather than a rewrite: a
   * provider that runs a process declares nothing and the caller's
   * `health-path` stands. If this ever returned a path, every existing deploy
   * would silently stop probing `/api/health`.
   */
  it('leaves a process-backed provider on the caller-requested path', async () => {
    const { dir, binDir, outputFile } = scratchRepo()
    fakeCli(binDir, 'flyctl', 'deployed')
    writeFileSync(join(dir, 'apps', 'web', 'fly.toml'), 'app = "playhall-web-staging"\n')

    const result = await run(process.execPath, [deployScript], {
      cwd: dir,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        DEPLOY_PROVIDER: 'fly',
        DEPLOY_ENV: 'staging',
        DEPLOY_TARGET: 'web',
        FLY_API_TOKEN: 'test-token',
        FLY_APP_WEB: 'playhall-web-staging',
        GITHUB_SHA: DEPLOYED_SHA,
        GITHUB_OUTPUT: outputFile,
      },
    })

    expect(result.status).toBe(0)
    const out = outputs(outputFile)
    expect(out.get('status')).toBe('deployed')
    expect(out.get('probe-path')).toBe('')
    expect(out.get('probe-commit')).toBe('')
  })

  /**
   * The skip branch still emits the outputs. A composite action reading an
   * output that a skipped branch never wrote gets an empty string anyway, but
   * asserting it here keeps "not_configured" a complete result rather than a
   * partial one.
   */
  it('emits empty probe outputs when nothing was deployed', async () => {
    const { dir, outputFile } = scratchRepo()

    const result = await run(process.execPath, [deployScript], {
      cwd: dir,
      env: {
        DEPLOY_PROVIDER: '',
        DEPLOY_ENV: 'staging',
        DEPLOY_TARGET: 'web',
        GITHUB_OUTPUT: outputFile,
      },
    })

    expect(result.status).toBe(0)
    const out = outputs(outputFile)
    expect(out.get('status')).toBe('not_configured')
    expect(out.get('probe-path')).toBe('')
  })
})
