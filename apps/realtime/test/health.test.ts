import { describe, expect, it } from 'vitest'
import { liveness, readiness, type DependencyCheck, type HealthContext } from '../src/health'

function context(overrides: Partial<HealthContext> = {}): HealthContext {
  const startedAtMs = Date.parse('2026-09-30T12:00:00.000Z')
  return {
    service: '@playhall/realtime',
    version: '0.0.0',
    startedAtMs,
    now: () => startedAtMs + 30_000,
    ...overrides,
  }
}

const okCheck = (name: string, required?: boolean): DependencyCheck => ({
  name,
  required,
  run: async () => ({ ok: true, latencyMs: 3 }),
})

const failingCheck = (name: string, required?: boolean): DependencyCheck => ({
  name,
  required,
  run: async () => ({ ok: false, detail: 'ECONNREFUSED' }),
})

describe('liveness', () => {
  it('is healthy with no dependency I/O at all', () => {
    const payload = liveness(context())

    // The point of the split: `liveness` takes no checks and reports none, so
    // a dead Redis cannot fail it. A liveness failure restarts the process,
    // and a restart loop is a worse outage than a degraded one.
    expect(payload.ok).toBe(true)
    expect(payload.status).toBe('ok')
    expect(payload.dependencies).toEqual([])
    expect(liveness).toHaveLength(1)
  })

  it('reports uptime from the injected clock', () => {
    expect(liveness(context()).uptimeSeconds).toBe(30)
  })
})

describe('readiness', () => {
  it('is ready when there are no registered checks', async () => {
    // M0 state: no client is wired up yet, so /ready answers the same question
    // as /health. Asserted so the day a check is registered, this test changes
    // and the change is deliberate.
    const payload = await readiness(context(), [])

    expect(payload.ok).toBe(true)
    expect(payload.status).toBe('ok')
  })

  it('is ready when every check passes', async () => {
    const payload = await readiness(context(), [okCheck('redis'), okCheck('postgres')])

    expect(payload.ok).toBe(true)
    expect(payload.dependencies.map((d) => d.name)).toEqual(['redis', 'postgres'])
  })

  it('is not ready when a required check fails', async () => {
    const payload = await readiness(context(), [okCheck('postgres'), failingCheck('redis')])

    expect(payload.ok).toBe(false)
    expect(payload.status).toBe('unhealthy')
    expect(payload.dependencies.find((d) => d.name === 'redis')?.detail).toBe('ECONNREFUSED')
  })

  it('stays ready but degraded when only an optional check fails', async () => {
    const payload = await readiness(context(), [
      okCheck('redis'),
      failingCheck('metrics-sink', false),
    ])

    expect(payload.ok).toBe(true)
    expect(payload.status).toBe('degraded')
  })

  it('treats a check that throws as failed, not as a server error', async () => {
    // One dependency's bug must not turn /ready itself into a 500 — that reads
    // as a total outage no matter what the other dependencies are doing.
    const thrower: DependencyCheck = {
      name: 'redis',
      run: async () => {
        throw new Error('client not initialised')
      },
    }

    const payload = await readiness(context(), [okCheck('postgres'), thrower])

    expect(payload.ok).toBe(false)
    expect(payload.dependencies.find((d) => d.name === 'redis')).toMatchObject({
      ok: false,
      detail: 'client not initialised',
    })
  })

  it('handles a check that throws a non-Error without leaking the value', async () => {
    const thrower: DependencyCheck = {
      name: 'postgres',
      // A rejected string is a real pattern in driver code; the detail must
      // still be a safe, fixed message rather than the raw thrown value, which
      // could be a connection URL with credentials in it.
      run: async () => Promise.reject('postgresql://user:secret@host/db'),
    }

    const payload = await readiness(context(), [thrower])

    expect(payload.dependencies[0]?.detail).toBe('check threw a non-Error')
    expect(JSON.stringify(payload)).not.toContain('secret')
  })

  it('runs checks in parallel rather than in series', async () => {
    const order: string[] = []
    const slow = (name: string, ms: number): DependencyCheck => ({
      name,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, ms))
        order.push(name)
        return { ok: true }
      },
    })

    // Serial execution would finish a-then-b; parallel finishes b first
    // because it is faster. Readiness must not be the sum of its checks —
    // that is how a probe times out as dependencies are added.
    await readiness(context(), [slow('a', 40), slow('b', 5)])

    expect(order).toEqual(['b', 'a'])
  })

  it('measures latency when a check does not report its own', async () => {
    let clock = Date.parse('2026-09-30T12:00:00.000Z')
    const ctx = context({ now: () => clock })
    const check: DependencyCheck = {
      name: 'redis',
      run: async () => {
        clock += 12
        return { ok: true }
      },
    }

    const payload = await readiness(ctx, [check])

    expect(payload.dependencies[0]?.latencyMs).toBe(12)
  })
})
