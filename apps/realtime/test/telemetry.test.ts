import { describe, expect, it, vi } from 'vitest'
import { loadEnv } from '../src/env'
import { createTelemetry, SERVICE_NAME } from '../src/telemetry'

describe('createTelemetry', () => {
  it('builds a fully-qualified release identity from the sha and the environment', () => {
    const { release } = createTelemetry(loadEnv({ DEPLOY_ENV: 'staging', GIT_SHA: '3dacaff' }))

    // A bare sha in an org shared with another product resolves the wrong
    // source map — the exact failure PER-7 exists to prevent.
    expect(release.release).toBe(`${SERVICE_NAME}@3dacaff`)
    expect(release.environment).toBe('staging')
  })

  it('falls back to the structured logger when no DSN is configured', () => {
    const { errors } = createTelemetry(loadEnv({}))

    // No DSN must mean "not aggregated", never "crashes" and never "silent".
    expect(() => errors.captureException(new Error('boom'))).not.toThrow()
    expect(() => errors.captureMessage('something odd')).not.toThrow()
  })

  it('flush resolves without a vendor wired', async () => {
    const { errors } = createTelemetry(loadEnv({}))
    await expect(errors.flush()).resolves.toBe(true)
  })

  it('reports to the vendor and the local log together when a DSN is set', async () => {
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })

    try {
      const { errors } = createTelemetry(
        loadEnv({
          DEPLOY_ENV: 'staging',
          GIT_SHA: '3dacaff',
          SENTRY_DSN: 'https://key@127.0.0.1:1/42',
        }),
      )
      errors.captureException(new Error('boom'))
      await errors.flush(50)
    } finally {
      log.mockRestore()
    }

    // An aggregated report we cannot also grep is one we lose the moment the
    // shared free-tier quota runs out.
    expect(lines.join('')).toContain('captured exception')
  })

  it('degrades to local-only reporting on a malformed DSN', async () => {
    const { errors } = createTelemetry(
      loadEnv({ DEPLOY_ENV: 'staging', GIT_SHA: '3dacaff', SENTRY_DSN: 'https://o1.example/42' }),
    )

    expect(() => errors.captureException(new Error('boom'))).not.toThrow()
    await expect(errors.flush()).resolves.toBe(true)
  })
})
