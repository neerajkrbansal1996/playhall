import { buildHealthPayload, healthHttpStatus } from '@atrium/shared'

/**
 * `GET /api/health` — liveness for the web app.
 *
 * Probed by the preview smoke test, the production smoke test and the uptime
 * monitor (`.github/workflows/uptime.yml`). It answers exactly one question:
 * is this Next.js server process up and serving? It deliberately does **not**
 * check Redis, Postgres or the realtime service:
 *
 *   * the web app renders and serves the landing page without any of them, so
 *     failing here would remove a page that works;
 *   * a liveness failure gets the process restarted, so a dependency blip here
 *     becomes a restart loop.
 *
 * Readiness for the data path belongs to `apps/realtime` (`GET /ready`), which
 * is the service that actually cannot work without Redis and Postgres.
 */

// Must run on the Node runtime and never be prerendered or cached: a health
// endpoint that returns a build-time snapshot answers about the build, not the
// running process — which is exactly the failure the probe exists to catch.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Module evaluation time is the closest thing to process start available inside
 * a route handler, and it is accurate enough for the uptime figure: a cold
 * start evaluates this module, so `uptimeSeconds` reports the age of the
 * instance that answered.
 */
const startedAtMs = Date.now()

export async function GET(): Promise<Response> {
  const payload = buildHealthPayload({
    service: '@atrium/web',
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0',
    nowMs: Date.now(),
    startedAtMs,
    // Liveness: no dependency I/O by design. See the note above.
    dependencies: [],
  })

  return Response.json(payload, {
    status: healthHttpStatus(payload),
    headers: {
      // Belt and braces alongside `dynamic`: a CDN edge caching this would let
      // a dead instance keep reporting healthy.
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
