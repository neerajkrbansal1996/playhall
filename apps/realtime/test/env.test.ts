import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/env'

describe('loadEnv', () => {
  it('defaults to a local development configuration that ships nothing to a vendor', () => {
    const env = loadEnv({})

    expect(env).toMatchObject({
      REALTIME_PORT: 3001,
      NODE_ENV: 'development',
      DEPLOY_ENV: 'development',
      GIT_SHA: '0000000',
      LOG_SAMPLE_RATE: 1,
      ENABLE_DEBUG_THROW_ROUTE: false,
    })
    expect(env.SENTRY_DSN).toBeUndefined()
  })

  it('coerces the port and the sample rate from their string env values', () => {
    const env = loadEnv({ REALTIME_PORT: '8080', LOG_SAMPLE_RATE: '0.25' })
    expect(env.REALTIME_PORT).toBe(8080)
    expect(env.LOG_SAMPLE_RATE).toBe(0.25)
  })

  it('treats the debug throw route as off unless it is exactly "true"', () => {
    expect(loadEnv({ ENABLE_DEBUG_THROW_ROUTE: 'true' }).ENABLE_DEBUG_THROW_ROUTE).toBe(true)
    expect(loadEnv({ ENABLE_DEBUG_THROW_ROUTE: 'false' }).ENABLE_DEBUG_THROW_ROUTE).toBe(false)
    // Anything else is a misconfiguration, not a quiet "on".
    expect(() => loadEnv({ ENABLE_DEBUG_THROW_ROUTE: 'yes' })).toThrow()
  })

  it.each([
    ['a port outside the valid range', { REALTIME_PORT: '70000' }],
    ['a non-hex git sha', { GIT_SHA: 'not-a-sha' }],
    ['an unknown deploy environment', { DEPLOY_ENV: 'qa' }],
    ['a sample rate above 1', { LOG_SAMPLE_RATE: '2' }],
    ['a malformed database url', { DATABASE_URL: 'not-a-url' }],
    ['a malformed DSN', { SENTRY_DSN: 'not-a-url' }],
  ])('fails the boot on %s rather than surfacing it later', (_label, source) => {
    // A service that boots half-configured fails later and less clearly.
    expect(() => loadEnv(source)).toThrow(/Invalid environment/)
  })

  it('names the offending variable in the error', () => {
    expect(() => loadEnv({ DEPLOY_ENV: 'qa' })).toThrow(/DEPLOY_ENV/)
  })

  it('accepts a full staging configuration', () => {
    const env = loadEnv({
      DEPLOY_ENV: 'staging',
      GIT_SHA: '3dacaff2a44190aeb83ff6ea60cf4fa63b77a02e',
      SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/42',
      ENABLE_DEBUG_THROW_ROUTE: 'true',
    })

    expect(env.DEPLOY_ENV).toBe('staging')
    expect(env.SENTRY_DSN).toBe('https://key@o1.ingest.us.sentry.io/42')
  })
})
