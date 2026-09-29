/**
 * The health-check payload shape, shared by every service that has one.
 *
 * It lives here rather than in either app because the uptime monitor, the
 * preview smoke test and the production smoke test all parse the same shape
 * (`scripts/ci/health-probe.mjs`). If `apps/web` and `apps/realtime` each
 * invented their own, the probe would need a per-service branch — and the day a
 * third service appears, someone would forget.
 *
 * Two distinct questions, two distinct endpoints. Conflating them is why
 * deploys thrash:
 *
 *   * **liveness** — "is this process running?" No dependency I/O, always fast,
 *     and never fails because Redis is slow. An orchestrator restarts the
 *     process when this fails, so a dependency blip here becomes a restart
 *     loop.
 *   * **readiness** — "should this process receive traffic?" Checks the
 *     dependencies it cannot serve without. A failure here removes the instance
 *     from the load balancer; it does not kill it.
 *
 * No ambient clock: `nowMs` and `startedAtMs` are passed in. The determinism
 * lint rule bans `Date.now()` inside every package's `src`, and that is the
 * right rule — it means this module is directly testable at a fixed instant
 * instead of needing a faked timer.
 */

/** One dependency's observed state at probe time. */
export interface HealthDependency {
  /** Stable identifier, e.g. `redis`, `postgres`. Used in alert text. */
  readonly name: string
  readonly ok: boolean
  /** Observed round-trip in ms, when the check measured one. */
  readonly latencyMs?: number
  /**
   * Whether serving traffic without this dependency is possible. A degraded
   * optional dependency reports `status: "degraded"` but stays ready, so a
   * flaky nice-to-have cannot take the whole service out of rotation.
   */
  readonly required?: boolean
  /** Short human-readable cause when `ok` is false. Never include secrets. */
  readonly detail?: string
}

export interface HealthPayload {
  /**
   * The single field every probe reads. True means "healthy for the question
   * that was asked" — process is up for liveness, safe to serve for readiness.
   */
  readonly ok: boolean
  readonly status: 'ok' | 'degraded' | 'unhealthy'
  /** Which service answered, so a misrouted probe is obvious. */
  readonly service: string
  readonly version: string
  readonly checkedAt: string
  readonly startedAt: string
  readonly uptimeSeconds: number
  readonly dependencies: readonly HealthDependency[]
}

export interface HealthInput {
  readonly service: string
  readonly version: string
  /** Wall-clock ms for this probe. Supplied by the caller, never read here. */
  readonly nowMs: number
  /** Wall-clock ms at process start. */
  readonly startedAtMs: number
  /** Omit or pass `[]` for a liveness check. */
  readonly dependencies?: readonly HealthDependency[]
}

/**
 * Builds a health payload and derives `ok`/`status` from the dependencies.
 *
 * - no dependencies, or all ok       -> `ok: true`,  `status: "ok"`
 * - only optional dependencies down  -> `ok: true`,  `status: "degraded"`
 * - any required dependency down     -> `ok: false`, `status: "unhealthy"`
 *
 * A dependency with `required` unset counts as required. Defaulting the other
 * way would mean a forgotten flag silently downgrades an outage to "degraded",
 * and the probe would report healthy while the service could not serve.
 */
export function buildHealthPayload(input: HealthInput): HealthPayload {
  const dependencies = input.dependencies ?? []
  const down = dependencies.filter((dependency) => !dependency.ok)
  const requiredDown = down.filter((dependency) => dependency.required !== false)

  const status: HealthPayload['status'] =
    requiredDown.length > 0 ? 'unhealthy' : down.length > 0 ? 'degraded' : 'ok'

  return {
    ok: status !== 'unhealthy',
    status,
    service: input.service,
    version: input.version,
    checkedAt: new Date(input.nowMs).toISOString(),
    startedAt: new Date(input.startedAtMs).toISOString(),
    // Clamped at 0: a clock stepping backwards (NTP correction, container
    // migration) must not produce a negative uptime in a dashboard.
    uptimeSeconds: Math.max(0, Math.round((input.nowMs - input.startedAtMs) / 1000)),
    dependencies,
  }
}

/** HTTP status for a payload. Readiness failures must not be cached anywhere. */
export function healthHttpStatus(payload: HealthPayload): 200 | 503 {
  return payload.ok ? 200 : 503
}
