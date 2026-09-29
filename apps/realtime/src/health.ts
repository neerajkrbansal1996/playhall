import { buildHealthPayload, type HealthDependency, type HealthPayload } from '@atrium/shared'

/**
 * Liveness and readiness for the realtime service.
 *
 * The split matters more here than in `apps/web`, because this is the service
 * that genuinely cannot work without Redis (live room state, presence, pub/sub)
 * and Postgres (rooms, matches, match log):
 *
 *   * `GET /health`  — liveness. Process is up. No I/O, no dependencies. An
 *     orchestrator restarts on failure, so a Redis blip must not appear here.
 *   * `GET /ready`   — readiness. Safe to route players to. Checks every
 *     registered dependency and returns 503 if a required one is down, which
 *     takes this instance out of rotation without killing it.
 *
 * `DEPENDENCY_CHECKS` is empty for M0 because no client is wired up yet. It is
 * a registry rather than a hard-coded list so M1 adds a Redis and a Postgres
 * check by appending one entry each — no change to the endpoints, the probe
 * script, or the uptime workflow.
 */

/** A readiness probe for one dependency. Must never throw; must be bounded. */
export interface DependencyCheck {
  readonly name: string
  /** False marks a dependency we can serve degraded without. Default: required. */
  readonly required?: boolean
  run(signal: AbortSignal): Promise<Omit<HealthDependency, 'name' | 'required'>>
}

/**
 * M1 registers Redis and Postgres here. Empty today, and that is stated rather
 * than implied: `/ready` currently answers the same question as `/health`.
 */
export const DEPENDENCY_CHECKS: readonly DependencyCheck[] = []

/** Per-check budget. A readiness probe that hangs is itself an outage. */
const CHECK_TIMEOUT_MS = 2_000

export interface HealthContext {
  readonly service: string
  readonly version: string
  readonly startedAtMs: number
  /** Injected so tests can pin the clock. */
  now(): number
}

/** Liveness: no dependency I/O, so this cannot be slow and cannot be flaky. */
export function liveness(context: HealthContext): HealthPayload {
  return buildHealthPayload({
    service: context.service,
    version: context.version,
    nowMs: context.now(),
    startedAtMs: context.startedAtMs,
    dependencies: [],
  })
}

/** Readiness: probes every registered dependency in parallel, with a timeout. */
export async function readiness(
  context: HealthContext,
  checks: readonly DependencyCheck[] = DEPENDENCY_CHECKS,
): Promise<HealthPayload> {
  const dependencies = await Promise.all(checks.map((check) => runCheck(check, context)))

  return buildHealthPayload({
    service: context.service,
    version: context.version,
    nowMs: context.now(),
    startedAtMs: context.startedAtMs,
    dependencies,
  })
}

async function runCheck(check: DependencyCheck, context: HealthContext): Promise<HealthDependency> {
  const startedAt = context.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)

  try {
    const result = await check.run(controller.signal)
    return {
      name: check.name,
      required: check.required,
      latencyMs: result.latencyMs ?? context.now() - startedAt,
      ok: result.ok,
      detail: result.detail,
    }
  } catch (error) {
    // A check that throws is a check that failed. Never let one dependency's
    // bug turn the readiness endpoint itself into a 500 — that would look like
    // a total outage regardless of the other dependencies.
    return {
      name: check.name,
      required: check.required,
      ok: false,
      latencyMs: context.now() - startedAt,
      // Message only, never the error object: a connection error can carry a
      // URL with credentials in it.
      detail: error instanceof Error ? error.message : 'check threw a non-Error',
    }
  } finally {
    clearTimeout(timer)
  }
}
