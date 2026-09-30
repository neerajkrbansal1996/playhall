import { describe, expect, it } from 'vitest'
import { buildHealthPayload, healthHttpStatus, type HealthDependency } from '../src/health'

const BASE = {
  service: '@playhall/realtime',
  version: '0.0.0',
  startedAtMs: Date.parse('2026-09-30T12:00:00.000Z'),
  nowMs: Date.parse('2026-09-30T12:02:30.000Z'),
} as const

const up = (name: string, required?: boolean): HealthDependency => ({ name, ok: true, required })
const down = (name: string, required?: boolean): HealthDependency => ({
  name,
  ok: false,
  required,
  detail: 'connection refused',
})

describe('buildHealthPayload', () => {
  it('is ok with no dependencies — this is the liveness case', () => {
    const payload = buildHealthPayload(BASE)

    expect(payload.ok).toBe(true)
    expect(payload.status).toBe('ok')
    expect(payload.dependencies).toEqual([])
    expect(healthHttpStatus(payload)).toBe(200)
  })

  it('reports uptime and timestamps from the injected clock', () => {
    const payload = buildHealthPayload(BASE)

    expect(payload.uptimeSeconds).toBe(150)
    expect(payload.checkedAt).toBe('2026-09-30T12:02:30.000Z')
    expect(payload.startedAt).toBe('2026-09-30T12:00:00.000Z')
  })

  it('clamps uptime at zero when the clock steps backwards', () => {
    // NTP correction or a container migration; a negative uptime in a
    // dashboard is worse than a zero.
    const payload = buildHealthPayload({ ...BASE, nowMs: BASE.startedAtMs - 5_000 })

    expect(payload.uptimeSeconds).toBe(0)
  })

  it('is ok when every dependency is up', () => {
    const payload = buildHealthPayload({ ...BASE, dependencies: [up('redis'), up('postgres')] })

    expect(payload.ok).toBe(true)
    expect(payload.status).toBe('ok')
  })

  it('is unhealthy when a required dependency is down', () => {
    const payload = buildHealthPayload({ ...BASE, dependencies: [up('postgres'), down('redis')] })

    expect(payload.ok).toBe(false)
    expect(payload.status).toBe('unhealthy')
    expect(healthHttpStatus(payload)).toBe(503)
  })

  it('treats a dependency with no `required` flag as required', () => {
    // Defaulting the other way would let a forgotten flag downgrade a real
    // outage to "degraded", and the probe would report healthy.
    const payload = buildHealthPayload({ ...BASE, dependencies: [{ name: 'redis', ok: false }] })

    expect(payload.ok).toBe(false)
    expect(payload.status).toBe('unhealthy')
  })

  it('stays ready but degraded when only an optional dependency is down', () => {
    const payload = buildHealthPayload({
      ...BASE,
      dependencies: [up('redis'), down('metrics-sink', false)],
    })

    expect(payload.ok).toBe(true)
    expect(payload.status).toBe('degraded')
    expect(healthHttpStatus(payload)).toBe(200)
  })

  it('prefers unhealthy over degraded when both kinds are down', () => {
    const payload = buildHealthPayload({
      ...BASE,
      dependencies: [down('redis', true), down('metrics-sink', false)],
    })

    expect(payload.status).toBe('unhealthy')
    expect(payload.ok).toBe(false)
  })

  it('passes dependency detail through for alert text', () => {
    const payload = buildHealthPayload({ ...BASE, dependencies: [down('redis')] })

    expect(payload.dependencies[0]).toMatchObject({
      name: 'redis',
      ok: false,
      detail: 'connection refused',
    })
  })

  it('names the answering service, so a misrouted probe is obvious', () => {
    const payload = buildHealthPayload({ ...BASE, service: '@playhall/web' })

    expect(payload.service).toBe('@playhall/web')
  })
})
