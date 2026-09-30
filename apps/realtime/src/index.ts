import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  BRAND,
  CORRELATION_ID_HEADER,
  healthHttpStatus,
  resolveCorrelationId,
  withScope,
  type CorrelationId,
  type HealthPayload,
} from '@playhall/shared'
import { PLATFORM_CORE_VERSION, platformBuildInfo } from '@playhall/platform-core'
import { loadEnv } from './env'
import { createTelemetry } from './telemetry'
import { pathOf } from './http'
import { liveness, readiness, type HealthContext } from './health'

const env = loadEnv()
const { logger, release, errors } = createTelemetry(env)
const startedAt = new Date().toISOString()

const healthContext: HealthContext = {
  service: release.service,
  version: PLATFORM_CORE_VERSION,
  startedAtMs: Date.now(),
  now: () => Date.now(),
}

/**
 * Take the correlation id off the wire, or mint one. `minted: true` on a hop
 * that should have received an id from `apps/web` means propagation broke
 * upstream, so it is logged rather than hidden.
 */
function correlationFor(req: IncomingMessage): { correlationId: CorrelationId; minted: boolean } {
  return resolveCorrelationId(req.headers[CORRELATION_ID_HEADER])
}

/** Path without the query string. `undefined` and malformed urls become `/`. */
export function pathOf(url: string | undefined): string {
  if (!url) return '/'
  const queryAt = url.indexOf('?')
  const hashAt = url.indexOf('#')
  const end = Math.min(queryAt === -1 ? url.length : queryAt, hashAt === -1 ? url.length : hashAt)
  return url.slice(0, end) || '/'
}

/**
 * M0 skeleton: HTTP only, so `pnpm dev` has something that actually boots and
 * the deploy pipeline has something to probe. The wire protocol (`room:*`,
 * `game:action`, `game:view`, `timer:sync`, …) and the room runner land in M1 —
 * at which point `withScope` also binds `roomId`, and one room's whole life
 * becomes greppable.
 *
 * Two health routes, not one — see `./health` for why liveness and readiness
 * must not be the same endpoint.
 */
const server = createServer((req, res) => {
  const { correlationId, minted } = correlationFor(req)
  const log = withScope(logger, { correlationId })

  // Route on the path, never on the raw url. `/health?x=1` is the same route as
  // `/health`, and an exact-match comparison silently 404s the moment anything
  // appends a query string — a share link, an analytics tag, a cache buster.
  const path = pathOf(req.url)

  // Echo it back so a browser, a load test or a curl can follow one chain.
  res.setHeader(CORRELATION_ID_HEADER, correlationId)

  if (minted) {
    log.debug('minted a correlation id for an inbound request', {
      event: 'telemetry.correlation_minted',
      path,
    })
  }

  // Liveness. Synchronous and dependency-free on purpose: an orchestrator
  // restarts the process when this fails.
  if (path === '/health') {
    log.debug('health probe', { event: 'http.health' })
    sendHealth(res, liveness(healthContext))
    return
  }

  // Readiness. Returns 503 when a required dependency is down, which removes
  // this instance from rotation without killing it.
  if (path === '/ready') {
    log.debug('readiness probe', { event: 'http.ready' })
    readiness(healthContext).then(
      (payload) => sendHealth(res, payload),
      // `readiness` is written not to reject, so reaching here is a bug in a
      // check. Report it as not-ready rather than as a 500, which a load
      // balancer would treat identically but an operator would not.
      (error: unknown) => {
        const err = error instanceof Error ? error : new Error('readiness failed')
        log.error('readiness check threw', { event: 'http.ready_failed', err })
        errors.captureException(err, { correlationId, route: '/ready' })
        sendJson(res, 503, {
          ok: false,
          status: 'unhealthy',
          service: healthContext.service,
          error: err.message,
        })
      },
    )
    return
  }

  // Exists only to prove the source-map pipeline resolves a stack trace on a
  // staging build. Off unless ENABLE_DEBUG_THROW_ROUTE=true.
  if (path === '/debug/throw' && env.ENABLE_DEBUG_THROW_ROUTE) {
    const error = new Error(`Deliberate ${release.environment} error from ${release.release}`)
    log.error('deliberate error route hit', { event: 'debug.throw', err: error })
    errors.captureException(error, { correlationId, route: '/debug/throw' })
    sendJson(res, 500, { error: { code: 'deliberate_error', correlationId } })
    return
  }

  sendJson(res, 404, { error: { code: 'not_found', message: 'No such route.' } })
})

server.listen(env.REALTIME_PORT, () => {
  logger.info('realtime service listening', {
    event: 'server.started',
    port: env.REALTIME_PORT,
    nodeEnv: env.NODE_ENV,
    debugThrowRoute: env.ENABLE_DEBUG_THROW_ROUTE,
  })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('shutting down', { event: 'server.stopping', signal })
    server.close(() => {
      void errors.flush(2_000).then(() => process.exit(0))
    })
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
    // Telemetry identity, so one probe answers "which build is this, really".
    release: release.release,
    environment: release.environment,
    startedAt,
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
