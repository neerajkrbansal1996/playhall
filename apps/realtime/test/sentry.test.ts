import { describe, expect, it, vi } from 'vitest'
import { createLogger, createReleaseIdentity, type LogRecord } from '@playhall/shared'
import { createSentryErrorReporter, parseDsn, parseStack, toArtifactPath } from '../src/sentry'

const RELEASE = createReleaseIdentity({
  service: 'playhall-realtime',
  gitSha: '3dacaff',
  environment: 'staging',
})

function testLogger() {
  const records: LogRecord[] = []
  const logger = createLogger({
    level: 'debug',
    clock: () => 0,
    base: { service: RELEASE.service, release: RELEASE.release },
    sink: { write: (record) => records.push(record) },
  })
  return { logger, records }
}

describe('parseDsn', () => {
  it('splits a real DSN into the envelope endpoint and public key', () => {
    const dsn = parseDsn(
      'https://57c2b07e74de89106179e193f7cfa82a@o4511157987573760.ingest.us.sentry.io/4512173853966336',
    )

    expect(dsn).toEqual({
      publicKey: '57c2b07e74de89106179e193f7cfa82a',
      projectId: '4512173853966336',
      envelopeUrl: 'https://o4511157987573760.ingest.us.sentry.io/api/4512173853966336/envelope/',
    })
  })

  it.each([
    ['not a url', 'nonsense'],
    ['no public key', 'https://o123.ingest.us.sentry.io/4512173853966336'],
    ['no project id', 'https://key@o123.ingest.us.sentry.io/'],
    ['non-numeric project id', 'https://key@o123.ingest.us.sentry.io/not-a-project'],
  ])('returns undefined for %s rather than throwing', (_label, dsn) => {
    expect(parseDsn(dsn)).toBeUndefined()
  })
})

describe('toArtifactPath', () => {
  const root = '/build/repo'

  it('rewrites a file:// url under the app root to the app:/// convention', () => {
    // This is the whole ballgame: `~/dist/index.js` is the uploaded artifact
    // name, and only `app:///dist/index.js` matches it.
    expect(toArtifactPath('file:///build/repo/dist/index.js', root)).toBe('app:///dist/index.js')
  })

  it('rewrites a plain absolute path too', () => {
    expect(toArtifactPath('/build/repo/dist/index.js', root)).toBe('app:///dist/index.js')
  })

  it('handles a root given with a trailing slash', () => {
    expect(toArtifactPath('/build/repo/dist/index.js', '/build/repo/')).toBe('app:///dist/index.js')
  })

  it('percent-decodes a path with spaces', () => {
    expect(toArtifactPath('file:///build/repo/my%20dir/index.js', root)).toBe(
      'app:///my dir/index.js',
    )
  })

  it('leaves node internals alone', () => {
    expect(toArtifactPath('node:_http_server', root)).toBe('node:_http_server')
  })

  it('keeps a path outside the app root absolute rather than faking a match', () => {
    expect(toArtifactPath('/usr/lib/node/thing.js', root)).toBe('app:///usr/lib/node/thing.js')
  })
})

describe('parseStack', () => {
  const stack = [
    'Error: boom',
    '    at Server.<anonymous> (file:///build/repo/dist/index.js:7:2423)',
    '    at Server.emit (node:events:514:28)',
    '    at file:///build/repo/dist/worker.js:2:10',
  ].join('\n')

  it('parses named, bare and node-internal frames', () => {
    const frames = parseStack(stack, '/build/repo')
    expect(frames).toHaveLength(3)
  })

  it('reverses the frames, because Sentry renders oldest first', () => {
    const frames = parseStack(stack, '/build/repo')
    expect(frames[frames.length - 1]).toMatchObject({
      abs_path: 'app:///dist/index.js',
      function: 'Server.<anonymous>',
      lineno: 7,
      colno: 2423,
      in_app: true,
    })
  })

  it('marks node internals and node_modules as not in_app', () => {
    const frames = parseStack(stack, '/build/repo')
    expect(frames.find((f) => f.abs_path === 'node:events')?.in_app).toBe(false)
    expect(
      parseStack('E\n    at x (/build/repo/node_modules/dep/i.js:1:1)', '/build/repo')[0]?.in_app,
    ).toBe(false)
  })

  it('ignores lines that are not frames instead of emitting NaN line numbers', () => {
    const frames = parseStack(
      'Error: boom\n  some prose\n    at a (/build/repo/x.js:3:4)',
      '/build/repo',
    )
    expect(frames).toHaveLength(1)
    expect(frames[0]?.lineno).toBe(3)
  })

  it('returns nothing for a stackless error', () => {
    expect(parseStack(undefined, '/build/repo')).toEqual([])
  })
})

describe('createSentryErrorReporter', () => {
  function reporterWithCapturedFetch() {
    const sent: Array<Record<string, unknown>> = []
    const { logger, records } = testLogger()
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      sent.push(JSON.parse(body.trim().split('\n')[2] ?? '{}'))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const reporter = createSentryErrorReporter({
      dsn: 'https://key@o1.ingest.us.sentry.io/42',
      release: RELEASE,
      logger,
      appRoot: '/build/repo',
      clock: () => 1_700_000_000_000,
      fetchImpl,
    })
    return { reporter, sent, records, fetchImpl }
  }

  it('falls back to the logging reporter on a malformed DSN instead of crashing the boot', () => {
    const { logger, records } = testLogger()
    const reporter = createSentryErrorReporter({ dsn: 'nonsense', release: RELEASE, logger })

    expect(reporter).toBeUndefined()
    expect(records.at(-1)?.fields?.event).toBe('telemetry.dsn_invalid')
  })

  it('sends an exception carrying the fully-qualified release and the environment tag', async () => {
    const { reporter, sent } = reporterWithCapturedFetch()
    reporter?.captureException(new Error('boom'), { correlationId: 'abc' })
    await reporter?.flush()

    expect(sent[0]).toMatchObject({
      release: 'playhall-realtime@3dacaff',
      environment: 'staging',
      extra: { correlationId: 'abc' },
    })
    // A bare sha in a shared org resolves the wrong project's source map.
    expect(String(sent[0]?.release)).toContain('playhall-realtime@')
  })

  it('scrubs a lobby code before the event leaves the process', async () => {
    const { reporter, sent } = reporterWithCapturedFetch()
    reporter?.captureException(new Error('boom'), { code: 'TCQ4MN', roomId: 'room_1' })
    await reporter?.flush()

    // A lobby code is a join capability; shipping one to a vendor is a security
    // bug, not a privacy preference.
    expect(JSON.stringify(sent[0])).not.toContain('TCQ4MN')
    expect(JSON.stringify(sent[0])).toContain('room_1')
  })

  it('logs rather than swallows an event Sentry rejects', async () => {
    const { logger, records } = testLogger()
    const fetchImpl = vi.fn(
      async () => new Response('bad project', { status: 400 }),
    ) as unknown as typeof fetch
    const reporter = createSentryErrorReporter({
      dsn: 'https://key@o1.ingest.us.sentry.io/42',
      release: RELEASE,
      logger,
      fetchImpl,
    })

    reporter?.captureException(new Error('boom'))
    await reporter?.flush()

    expect(records.some((r) => r.fields?.event === 'telemetry.vendor_rejected')).toBe(true)
  })

  it('logs a transport failure rather than rejecting into the void', async () => {
    const { logger, records } = testLogger()
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const reporter = createSentryErrorReporter({
      dsn: 'https://key@o1.ingest.us.sentry.io/42',
      release: RELEASE,
      logger,
      fetchImpl,
    })

    reporter?.captureException(new Error('boom'))
    await reporter?.flush()

    expect(records.some((r) => r.fields?.event === 'telemetry.vendor_unreachable')).toBe(true)
  })

  it('captures a non-Error throw without losing it', async () => {
    const { reporter, sent } = reporterWithCapturedFetch()
    reporter?.captureException('just a string')
    await reporter?.flush()

    expect(sent[0]?.exception).toMatchObject({
      values: [{ type: 'Error', value: 'just a string' }],
    })
  })

  it('sends a message event', async () => {
    const { reporter, sent } = reporterWithCapturedFetch()
    reporter?.captureMessage('something odd')
    await reporter?.flush()

    expect(sent[0]?.message).toEqual({ formatted: 'something odd' })
  })

  it('flush resolves true when nothing is in flight', async () => {
    const { reporter } = reporterWithCapturedFetch()
    await expect(reporter?.flush()).resolves.toBe(true)
  })

  it('flush gives up at the timeout rather than hanging shutdown forever', async () => {
    const { logger } = testLogger()
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch
    const reporter = createSentryErrorReporter({
      dsn: 'https://key@o1.ingest.us.sentry.io/42',
      release: RELEASE,
      logger,
      fetchImpl,
    })

    reporter?.captureException(new Error('boom'))
    await expect(reporter?.flush(10)).resolves.toBe(false)
  })
})
