import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

/**
 * M0 AC2a — the round trip against the artifact the deploy pipeline runs.
 *
 * The in-process tests in `ws-probe.test.ts` attach the probe to a server they
 * build themselves, which proves the module but not the wiring. This file spawns
 * the real entrypoint — the same `tsx src/index.ts` that `pnpm start` runs and
 * that the container image runs — so what is under test is `index.ts` reading
 * `REALTIME_WS_PROBE` out of `loadEnv` and attaching the probe, over a real
 * socket to a real listening port.
 *
 * That is also what makes AC3 meaningful: the flag-off case is a second spawn of
 * the same entrypoint with the variable removed from the environment, not a
 * different code path chosen by a test.
 *
 * It runs in the `unit` CI gate rather than the `integration` gate on purpose —
 * `integration` is still PENDING behind Redis and Postgres (see
 * `scripts/ci/gate.mjs`), and this needs neither. Holding the one round trip M0
 * AC2a is about behind that gate would mean it did not run in CI at all.
 */

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(appRoot, '..', '..')

/**
 * The service is started as plain `node --import <tsx loader>` rather than
 * through the `tsx` CLI. Same loader and same module graph as `pnpm start`, but
 * the CLI additionally opens a unix-domain IPC socket in `TMPDIR` for its watch
 * channel, and a sandboxed or restricted `TMPDIR` makes that fail with EINVAL
 * before `index.ts` ever runs. Nothing here needs that channel.
 *
 * pnpm links a package's own devDependencies into its own `node_modules`, so tsx
 * normally resolves under `apps/realtime`; the root is a fallback for a hoisted
 * install. A missing loader fails with a readable message rather than as a bare
 * `spawn ENOENT` from inside a `beforeAll`.
 */
const tsxLoader = [
  join(appRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
  join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
].find((candidate) => existsSync(candidate))

interface Service {
  readonly process: ChildProcessByStdio<null, Readable, Readable>
  readonly port: number
  /** Everything the service has written to stdout so far. A live read, not a
   * snapshot taken at boot — the enabled-probe line is printed in the same
   * `listen` callback as the port line, so a captured string can miss it. */
  log(): string
  /** Resolves when `pattern` appears in stdout, or rejects on timeout. */
  waitForLog(pattern: RegExp, timeoutMs?: number): Promise<void>
}

/**
 * Boots the entrypoint on an OS-assigned port and waits for it to say which one
 * it got. `REALTIME_PORT=0` rather than a hard-coded port so two suites, or a
 * dev server already running, cannot make this flaky.
 */
async function boot(env: Record<string, string | undefined>): Promise<Service> {
  if (tsxLoader === undefined) {
    throw new Error('tsx loader not found — run `pnpm install` before this suite.')
  }
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(tsxLoader).href, 'src/index.ts'],
    {
      cwd: appRoot,
      env: { ...process.env, REALTIME_PORT: '0', NODE_ENV: 'test', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => (stderr += chunk))

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`realtime did not report a port in 20s.\nstderr:\n${stderr}`)),
      20_000,
    )
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      const match = /listening on http:\/\/localhost:(\d+)/.exec(stdout)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`realtime exited with ${String(code)} before listening.\n${stderr}`))
    })
  })

  const log = (): string => stdout
  const waitForLog = async (pattern: RegExp, timeoutMs = 5_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!pattern.test(log())) {
      if (Date.now() > deadline) {
        throw new Error(`stdout never matched ${pattern.source}. Saw:\n${log()}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  return { process: child, port, log, waitForLog }
}

async function stop(service: Service | undefined): Promise<void> {
  if (service === undefined || service.process.exitCode !== null) return
  const exited = new Promise<void>((resolve) => service.process.once('exit', () => resolve()))
  service.process.kill('SIGTERM')
  await exited
}

function readFrame(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data: Buffer) => resolve(JSON.parse(data.toString('utf8'))))
    ws.once('close', () => reject(new Error('socket closed before a frame arrived')))
    ws.once('error', reject)
  })
}

describe('REALTIME_WS_PROBE=1 — the artifact answers a WebSocket round trip', () => {
  let service: Service

  beforeAll(async () => {
    service = await boot({ REALTIME_WS_PROBE: '1' })
  }, 30_000)

  afterAll(async () => {
    await stop(service)
  })

  it('still serves liveness, so the probe did not displace the health routes', async () => {
    const response = await fetch(`http://127.0.0.1:${service.port}/health`)

    expect(response.status).toBe(200)
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true)
  })

  it('completes a ping/pong round trip with the nonce echoed', async () => {
    // AC1. This is the whole of M0 AC2a: one frame out, the matching frame back,
    // over a real WebSocket against the real entrypoint.
    const ws = new WebSocket(`ws://127.0.0.1:${service.port}/ws/probe`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })

    const nonce = 'ac2a-round-trip'
    const clientSentAtMs = Date.now()
    ws.send(JSON.stringify({ t: 'ping', nonce, clientSentAtMs }))
    const pong = (await readFrame(ws)) as {
      t: string
      nonce: string
      clientSentAtMs: number
      serverRecvAtMs: number
      serverSentAtMs: number
    }

    expect(pong.t).toBe('pong')
    expect(pong.nonce).toBe(nonce)
    expect(pong.clientSentAtMs).toBe(clientSentAtMs)
    expect(pong.serverRecvAtMs).toBeLessThanOrEqual(pong.serverSentAtMs)
    ws.close()
  })

  it('answers a malformed frame with an error frame and then closes', async () => {
    // AC2.
    const ws = new WebSocket(`ws://127.0.0.1:${service.port}/ws/probe`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })

    const closed = new Promise<number>((resolve) =>
      ws.once('close', (code: number) => resolve(code)),
    )
    ws.send('{ this is not json')

    expect((await readFrame(ws)) as { t: string }).toMatchObject({ t: 'error' })
    expect(await closed).toBe(1003)
  })

  it('logs that the probe is enabled, so a staging boot is auditable', async () => {
    // A flag that is on and says nothing is how nobody notices it shipped to
    // production. The boot log is the audit trail.
    await service.waitForLog(/ws transport probe enabled at ws:\/\/[^\s]+\/ws\/probe/)
  })
})

describe('REALTIME_WS_PROBE unset — the route does not exist', () => {
  let service: Service

  beforeAll(async () => {
    // Explicitly removed rather than set to '0': the production case is an
    // absent variable, and that is what has to be tested.
    service = await boot({ REALTIME_WS_PROBE: undefined })
  }, 30_000)

  afterAll(async () => {
    await stop(service)
  })

  it('answers a plain GET /ws/probe with 404', async () => {
    // AC3. Exactly today's behaviour: the route falls through to the 404 in the
    // request handler, because nothing was attached.
    const response = await fetch(`http://127.0.0.1:${service.port}/ws/probe`)

    expect(response.status).toBe(404)
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'not_found' },
    })
  })

  it('does not upgrade a WebSocket handshake', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${service.port}/ws/probe`)
    const outcome = await new Promise<'open' | 'failed'>((resolve) => {
      ws.once('open', () => resolve('open'))
      ws.once('error', () => resolve('failed'))
      ws.once('close', () => resolve('failed'))
    })

    expect(outcome).toBe('failed')
  })

  it('does not mention the probe in its boot log', () => {
    // Runs last in this block, by which point the two tests above have each done
    // a full request round trip against the service — so stdout has settled and
    // this is an assertion about the log rather than about timing.
    expect(service.log()).not.toContain('/ws/probe')
    expect(service.log()).toContain('listening on http://localhost:')
  })
})
