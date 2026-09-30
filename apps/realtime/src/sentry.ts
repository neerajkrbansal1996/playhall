import {
  DEFAULT_SAMPLING,
  scrubEventForVendor,
  type ErrorReporter,
  type LogFields,
  type Logger,
  type ReleaseIdentity,
} from '@playhall/shared'

/**
 * The Sentry adapter for the realtime service: one implementation of
 * `ErrorReporter`, behind the facade, so no other file in the repo names a
 * vendor (ADR-0001 §8).
 *
 * **Why the envelope HTTP API and not `@sentry/node`.** The hosting runtime is
 * still open on [PER-38](/PER/issues/PER-38), and Cloudflare Durable Objects
 * (`workerd`) is a live candidate. `@sentry/node` binds to `async_hooks`,
 * `process` and Node's http internals, so adopting it here would quietly spend
 * the escape hatch the CTO asked us to keep open. The envelope endpoint is a
 * documented, stable HTTP API; talking to it with `fetch` costs no dependency,
 * no bundle bytes, and runs unchanged on Node, `workerd` and a browser.
 *
 * The trade-off, stated rather than hidden: we give up automatic breadcrumbs,
 * auto-instrumentation and the SDK's retry/backoff queue. We capture explicitly
 * everywhere anyway, and tracing is off by budget (PER-7 §7), so the parts we
 * give up are the parts we had already switched off. `apps/web` is a different
 * question and should use `@sentry/nextjs`, which earns its bytes on browser
 * specifics (replay, CSP, route instrumentation) that no hand-rolled transport
 * should attempt.
 */

export interface ParsedDsn {
  readonly publicKey: string
  readonly projectId: string
  readonly envelopeUrl: string
}

/**
 * A DSN is `https://<publicKey>@<host>/<projectId>`. Returns `undefined` rather
 * than throwing: a malformed DSN must degrade to the logging reporter, never
 * take the service down on boot.
 */
export function parseDsn(dsn: string): ParsedDsn | undefined {
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    return undefined
  }

  const projectId = url.pathname.replace(/^\/+/, '')
  if (!url.username || !projectId || !/^\d+$/.test(projectId)) return undefined

  return {
    publicKey: url.username,
    projectId,
    envelopeUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
  }
}

/**
 * Sentry resolves a source map by matching a frame's `abs_path` against the
 * artifact names uploaded for the release. A deployed build's absolute
 * `file:///var/task/...` path is machine-specific and matches nothing, so frames
 * are rewritten to the `app:///<path-relative-to-appRoot>` convention that the
 * upload step names artifacts with (`~/<path>`).
 *
 * Get this wrong and errors still arrive — they just arrive minified, which is
 * the exact failure PER-7 exists to prevent.
 */
export function toArtifactPath(rawPath: string, appRoot: string): string {
  let path = rawPath
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      path = path.slice('file://'.length)
    }
  }
  if (!path.startsWith('/')) return path

  const root = appRoot.endsWith('/') ? appRoot : `${appRoot}/`
  if (path.startsWith(root)) return `app:///${path.slice(root.length)}`
  return `app://${path}`
}

interface StackFrame {
  readonly filename: string
  readonly abs_path: string
  readonly function?: string
  readonly lineno: number
  readonly colno: number
  readonly in_app: boolean
}

const FRAME_WITH_NAME = /^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/
const FRAME_BARE = /^\s*at\s+(.+):(\d+):(\d+)$/

/**
 * Parses a V8 stack into Sentry frames. Sentry renders frames oldest-first, the
 * reverse of how V8 prints them.
 */
export function parseStack(stack: string | undefined, appRoot: string): StackFrame[] {
  if (!stack) return []

  const frames: StackFrame[] = []
  for (const line of stack.split('\n').slice(1)) {
    const named = FRAME_WITH_NAME.exec(line)
    const bare = named ? null : FRAME_BARE.exec(line)

    const fn = named?.[1]
    const rawPath = named ? named[2] : bare?.[1]
    const lineno = Number(named ? named[3] : bare?.[2])
    const colno = Number(named ? named[4] : bare?.[3])
    if (rawPath === undefined || !Number.isFinite(lineno) || !Number.isFinite(colno)) continue

    const abs = toArtifactPath(rawPath, appRoot)
    frames.push({
      filename: abs,
      abs_path: abs,
      ...(fn ? { function: fn } : {}),
      lineno,
      colno,
      in_app: !abs.includes('node_modules') && !abs.startsWith('node:'),
    })
  }

  return frames.reverse()
}

function randomEventId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function toError(value: unknown): { type: string; value: string; stack?: string } {
  if (value instanceof Error) {
    return { type: value.name, value: value.message, stack: value.stack }
  }
  return { type: 'Error', value: typeof value === 'string' ? value : JSON.stringify(value) }
}

export interface SentryReporterOptions {
  readonly dsn: string
  readonly release: ReleaseIdentity
  /** Reports that fail to send are logged here rather than swallowed. */
  readonly logger: Logger
  /** Frames under this root become `app:///…`. Defaults to the process cwd. */
  readonly appRoot?: string
  readonly clock?: () => number
  readonly fetchImpl?: typeof fetch
}

/**
 * Builds an `ErrorReporter` that posts scrubbed envelopes to Sentry.
 *
 * Every event passes through `scrubEventForVendor` — the same capability scrub
 * the logger uses — before it leaves the process. A lobby code is a join
 * capability (ADR-0001 §6), and shipping one to a third party is a security bug.
 */
export function createSentryErrorReporter(
  options: SentryReporterOptions,
): ErrorReporter | undefined {
  const parsed = parseDsn(options.dsn)
  if (!parsed) {
    options.logger.warn('SENTRY_DSN is malformed; falling back to local reporting', {
      event: 'telemetry.dsn_invalid',
    })
    return undefined
  }
  const dsn = parsed

  const { release, logger } = options
  const appRoot = options.appRoot ?? process.cwd()
  const clock = options.clock ?? (() => Date.now())
  const doFetch = options.fetchImpl ?? fetch
  const inFlight = new Set<Promise<unknown>>()

  function send(event: Record<string, unknown>): void {
    if (DEFAULT_SAMPLING.errorSampleRate < 1 && Math.random() >= DEFAULT_SAMPLING.errorSampleRate) {
      return
    }

    const scrubbed = scrubEventForVendor(event)
    const header = { event_id: event.event_id, sent_at: new Date(clock()).toISOString() }
    const body = `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(scrubbed)}\n`

    const request = doFetch(dsn.envelopeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_client=playhall-realtime/0.0.0, sentry_key=${dsn.publicKey}`,
      },
      body,
    })
      .then(async (response) => {
        if (!response.ok) {
          // Losing a report silently is the failure mode this ticket exists to
          // prevent, so a rejected envelope is itself a log line.
          logger.warn('sentry rejected an event', {
            event: 'telemetry.vendor_rejected',
            status: response.status,
            detail: (await response.text()).slice(0, 200),
          })
        }
      })
      .catch((cause: unknown) => {
        logger.warn('sentry transport failed', {
          event: 'telemetry.vendor_unreachable',
          err: cause,
        })
      })

    inFlight.add(request)
    void request.finally(() => inFlight.delete(request))
  }

  function baseEvent(fields: LogFields | undefined): Record<string, unknown> {
    return {
      event_id: randomEventId(),
      timestamp: clock() / 1000,
      platform: 'node',
      level: 'error',
      logger: release.service,
      release: release.release,
      environment: release.environment,
      tags: { service: release.service },
      ...(fields && Object.keys(fields).length > 0 ? { extra: fields } : {}),
    }
  }

  return {
    captureException(error, fields) {
      const { type, value, stack } = toError(error)
      send({
        ...baseEvent(fields),
        exception: {
          values: [
            {
              type,
              value,
              stacktrace: { frames: parseStack(stack, appRoot) },
              mechanism: { type: 'generic', handled: true },
            },
          ],
        },
      })
    },

    captureMessage(message, fields) {
      send({ ...baseEvent(fields), message: { formatted: message } })
    },

    /**
     * Awaited on shutdown. A crash report that loses its race with
     * `process.exit` is a report we never see.
     */
    async flush(timeoutMs = 2_000) {
      if (inFlight.size === 0) return true
      const settled = Promise.allSettled([...inFlight]).then(() => true)
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
      return Promise.race([settled, timeout])
    },
  }
}
