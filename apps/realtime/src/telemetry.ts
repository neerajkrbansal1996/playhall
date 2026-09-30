import {
  createLoggingErrorReporter,
  createReleaseIdentity,
  createServiceLogger,
  type ErrorReporter,
  type Logger,
  type ReleaseIdentity,
} from '@playhall/shared'
import type { Env } from './env'
import { createSentryErrorReporter } from './sentry'

/**
 * The Node-side telemetry bootstrap. This file is the *only* place in the
 * realtime service allowed to know it is running on Node — everything else takes
 * a `Logger` and an `ErrorReporter`.
 *
 * `pino` (ADR-0001 §8) plugs in here as a `LogSink`; it stays deferred while the
 * hosting runtime is open on [PER-38](/PER/issues/PER-38), since a Node-only
 * pino transport is dead code on `workerd`. The default JSON-lines sink already
 * emits the same newline-delimited JSON a pino stdout transport would, so the
 * log format will not change when it lands.
 *
 * The Sentry adapter is wired (see `./sentry`). With no DSN configured, reports
 * fall back to the structured logger rather than vanishing.
 */

export const SERVICE_NAME = 'playhall-realtime'

export interface Telemetry {
  readonly release: ReleaseIdentity
  readonly logger: Logger
  readonly errors: ErrorReporter
}

export function createTelemetry(env: Env): Telemetry {
  const release = createReleaseIdentity({
    service: SERVICE_NAME,
    gitSha: env.GIT_SHA,
    environment: env.DEPLOY_ENV,
  })

  const logger = createServiceLogger({
    release,
    level: env.LOG_LEVEL,
    hotPathSampleRate: env.LOG_SAMPLE_RATE,
    // The app is the only layer allowed to read ambient time. Packages take it
    // as an injection so the determinism rule holds structurally.
    clock: () => Date.now(),
  })

  // With no DSN — local dev, tests, CI — reports go to the structured logger.
  // They are still structured, still carry correlationId and roomId, and are
  // still greppable; they are just not aggregated. Silence would be worse.
  const local = createLoggingErrorReporter(logger)
  const vendor = env.SENTRY_DSN
    ? createSentryErrorReporter({ dsn: env.SENTRY_DSN, release, logger })
    : undefined

  // Both, deliberately. An aggregated report we cannot also grep locally is one
  // we lose the moment the vendor quota runs out, and the free tier is shared
  // with an unrelated product.
  const errors: ErrorReporter = vendor
    ? {
        captureException: (error, fields) => {
          local.captureException(error, fields)
          vendor.captureException(error, fields)
        },
        captureMessage: (message, fields) => {
          local.captureMessage(message, fields)
          vendor.captureMessage(message, fields)
        },
        flush: (timeoutMs) => vendor.flush(timeoutMs),
      }
    : local

  return { release, logger, errors }
}
