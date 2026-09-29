import {
  createLoggingErrorReporter,
  createReleaseIdentity,
  createServiceLogger,
  type ErrorReporter,
  type Logger,
  type ReleaseIdentity,
} from '@playhall/shared'
import type { Env } from './env'

/**
 * The Node-side telemetry bootstrap. This file is the *only* place in the
 * realtime service allowed to know it is running on Node — everything else takes
 * a `Logger` and an `ErrorReporter`.
 *
 * `pino` (ADR-0001 §8) plugs in here as a `LogSink`, and the vendor error SDK
 * plugs in here as an `ErrorReporter`. Both are deliberately deferred:
 *   - the Sentry project and DSN do not exist yet (see [PER-40](/PER/issues/PER-40));
 *   - the hosting runtime is still open on [PER-38](/PER/issues/PER-38), and if
 *     it lands on `workerd` a Node-only pino transport is dead code.
 * Until then the default JSON-lines sink emits the same newline-delimited JSON a
 * pino stdout transport would, so the log format does not change when it lands.
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

  // Reports go to the structured logger until the vendor adapter exists. They
  // are then still structured, still carry correlationId and roomId, and are
  // still greppable — they are just not aggregated. Silence would be worse.
  const errors = createLoggingErrorReporter(logger)

  if (env.SENTRY_DSN) {
    // Fail loudly rather than pretending: a DSN is set, so the operator expects
    // aggregation, and they are not getting it yet.
    logger.warn('SENTRY_DSN is set but no vendor adapter is wired; reports stay local', {
      event: 'telemetry.vendor_missing',
      issue: 'PER-40',
    })
  }

  return { release, logger, errors }
}
