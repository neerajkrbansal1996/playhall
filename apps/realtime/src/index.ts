import { createServer, type ServerResponse } from 'node:http'
import { BRAND, healthHttpStatus, type HealthPayload } from '@playhall/shared'
import { PLATFORM_CORE_VERSION, platformBuildInfo } from '@playhall/platform-core'
import { createSystemClock } from './clock'
import { loadEnv } from './env'
import { liveness, readiness, type HealthContext } from './health'

const env = loadEnv()

/**
 * The process clock, constructed exactly once. Everything that needs "now" —
 * the health routes today, every room's `TimerService` from M1.6 — is handed
 * this instance. See `./clock` for why it is not `Date.now()`.
 */
const clock = createSystemClock()

const healthContext: HealthContext = {
  service: '@playhall/realtime',
  version: PLATFORM_CORE_VERSION,
  startedAtMs: clock.now(),
  now: () => clock.now(),
}

/**
 * M0 skeleton: HTTP only, so `pnpm dev` has something that actually boots and
 * the deploy pipeline has something to probe. The wire protocol (`room:*`,
 * `game:action`, `game:view`, `timer:sync`, …) and the room runner land in M1.
 *
 * Two health routes, not one — see `./health` for why liveness and readiness
 * must not be the same endpoint.
 */
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]

  // Liveness. Synchronous and dependency-free on purpose: an orchestrator
  // restarts the process when this fails.
  if (path === '/health') {
    sendHealth(res, liveness(healthContext))
    return
  }

  // Readiness. Returns 503 when a required dependency is down, which removes
  // this instance from rotation without killing it.
  if (path === '/ready') {
    readiness(healthContext).then(
      (payload) => sendHealth(res, payload),
      // `readiness` is written not to reject, so reaching here is a bug in a
      // check. Report it as not-ready rather than as a 500, which a load
      // balancer would treat identically but an operator would not.
      (error: unknown) =>
        sendJson(res, 503, {
          ok: false,
          status: 'unhealthy',
          service: healthContext.service,
          error: error instanceof Error ? error.message : 'readiness failed',
        }),
    )
    return
  }

  sendJson(res, 404, { error: { code: 'not_found', message: 'No such route.' } })
})

server.listen(env.REALTIME_PORT, () => {
  console.log(`[realtime] listening on http://localhost:${env.REALTIME_PORT} (${env.NODE_ENV})`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}

function sendHealth(res: ServerResponse, payload: HealthPayload): void {
  sendJson(res, healthHttpStatus(payload), {
    ...payload,
    // Carried over from the M0 skeleton rather than dropped. The brand name is
    // still a board decision, so every service reports which one it booted
    // with — that is how a stale deploy under an old name gets spotted.
    brand: BRAND.name,
    brandIsProvisional: BRAND.isProvisional,
    versions: platformBuildInfo(),
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    // A cached health response can report a dead instance as healthy.
    'cache-control': 'no-store, no-cache, must-revalidate',
  })
  res.end(JSON.stringify(body))
}
