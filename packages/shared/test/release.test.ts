import { describe, expect, it } from 'vitest'
import {
  createLoggingErrorReporter,
  createMemorySink,
  createNoopErrorReporter,
  createReleaseIdentity,
  DEFAULT_SAMPLING,
  DEPLOY_ENVIRONMENTS,
  DeployEnvironmentSchema,
  createLogger,
  formatRelease,
  parseRelease,
  REDACTED,
  scrubEventForVendor,
} from '../src/index'

describe('release identity', () => {
  it('is fully qualified as <service>@<git-sha>', () => {
    expect(formatRelease('playhall-realtime', 'a1b2c3d')).toBe('playhall-realtime@a1b2c3d')
    expect(formatRelease('playhall-web', 'A1B2C3D4E5F6')).toBe('playhall-web@a1b2c3d4e5f6')
  })

  it('rejects a service name or sha that would resolve the wrong source map', () => {
    expect(() => formatRelease('Playhall Web', 'a1b2c3d')).toThrow()
    expect(() => formatRelease('playhall-web', 'nothex')).toThrow()
    expect(() => formatRelease('playhall-web', 'a1b2c3')).toThrow() // < 7 chars
  })

  it('refuses to parse a bare sha — that is the shared-org collision', () => {
    expect(parseRelease('a1b2c3d')).toBeUndefined()
    expect(parseRelease('@a1b2c3d')).toBeUndefined()
    expect(parseRelease('playhall-web@')).toBeUndefined()
    expect(parseRelease('playhall-web@a1b2c3d')).toEqual({
      service: 'playhall-web',
      gitSha: 'a1b2c3d',
    })
  })

  it('treats the environment as a tag on one project per service', () => {
    const identity = createReleaseIdentity({
      service: 'playhall-realtime',
      gitSha: 'A1B2C3D',
      environment: 'staging',
    })
    expect(identity).toEqual({
      service: 'playhall-realtime',
      gitSha: 'a1b2c3d',
      release: 'playhall-realtime@a1b2c3d',
      environment: 'staging',
    })
    expect(DEPLOY_ENVIRONMENTS).toContain('production')
    expect(DeployEnvironmentSchema.safeParse('preview').success).toBe(false)
  })
})

describe('error reporter facade', () => {
  it('the no-op reporter is inert and still flushes', async () => {
    const reporter = createNoopErrorReporter()
    reporter.captureException(new Error('x'))
    reporter.captureMessage('y')
    await expect(reporter.flush()).resolves.toBe(true)
  })

  it('the $0 fallback routes reports into the structured logger, scrubbed', async () => {
    const sink = createMemorySink()
    const logger = createLogger({
      sink,
      clock: () => Date.parse('2026-09-30T12:00:00.000Z'),
      base: { service: 'playhall-realtime' },
    })
    const reporter = createLoggingErrorReporter(logger)

    reporter.captureException(new Error('join failed'), {
      correlationId: 'abcdefghijklmnopqrstuvwxyz',
      roomId: 'room_1',
      roomCode: 'TCQ4MN',
    })
    reporter.captureMessage('degraded', { roomId: 'room_1' })
    await expect(reporter.flush()).resolves.toBe(true)

    expect(sink.records).toHaveLength(2)
    expect(sink.records[0]!.level).toBe('error')
    expect(sink.records[0]!.fields['roomCode']).toBe(REDACTED)
    expect(sink.records[0]!.fields['correlationId']).toBe('abcdefghijklmnopqrstuvwxyz')
    expect((sink.records[0]!.fields['err'] as { message: string }).message).toBe('join failed')
    expect(sink.records[1]!.fields['captured']).toBe(true)
  })

  it('scrubEventForVendor keeps the event shape while stripping capabilities', () => {
    const scrubbed = scrubEventForVendor({
      message: 'boom',
      environment: 'staging',
      release: 'playhall-web@a1b2c3d',
      request: { url: 'https://playhall.example/j/TCQ4MN' },
      tags: { roomCode: 'TCQ4MN', roomId: 'room_1' },
    })

    expect(scrubbed).toEqual({
      message: 'boom',
      environment: 'staging',
      release: 'playhall-web@a1b2c3d',
      request: { url: `https://playhall.example/j/${REDACTED}` },
      tags: { roomCode: REDACTED, roomId: 'room_1' },
    })
  })

  it('states the event budget in one reviewable place', () => {
    expect(DEFAULT_SAMPLING).toEqual({
      errorSampleRate: 1,
      tracesSampleRate: 0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
    })
  })
})
