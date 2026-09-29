import type { Logger, LogFields } from './log'
import type { DeployEnvironment } from './release'
import { scrubValue } from './redact'

/**
 * Vendor-agnostic error reporting. No call site anywhere in the repo names
 * Sentry (ADR-0001 §8) — swapping vendors is then a change inside one adapter
 * rather than a repo-wide find-and-replace.
 *
 * The vendor SDK itself is deliberately **not** a dependency of
 * `packages/shared`: `@sentry/node` is Node-only and `@sentry/nextjs` would add
 * bytes to every bundle that touches shared code, against the "adding a game
 * adds zero bytes to other bundles" rule. Each app owns a thin adapter that
 * implements `ErrorReporter` and passes `scrubEventForVendor` as `beforeSend`.
 */

export interface ErrorReporterContext {
  readonly service: string
  readonly release: string
  readonly environment: DeployEnvironment
}

export interface ErrorReporter {
  captureException(error: unknown, fields?: LogFields): void
  captureMessage(message: string, fields?: LogFields): void
  /** Awaited on shutdown so a crash report is not lost with the process. */
  flush(timeoutMs?: number): Promise<boolean>
}

/** Used when no DSN is configured — local dev, tests, and CI. */
export function createNoopErrorReporter(): ErrorReporter {
  return {
    captureException: () => undefined,
    captureMessage: () => undefined,
    flush: async () => true,
  }
}

/**
 * Routes reports into the structured logger instead of a vendor. This is the
 * honest $0 fallback: with no DSN, errors are still structured, still carry the
 * correlation id and room id, and are still greppable — they just are not
 * aggregated. Silence would be worse.
 */
export function createLoggingErrorReporter(logger: Logger): ErrorReporter {
  return {
    captureException: (error, fields) => {
      logger.error('captured exception', { ...fields, err: error })
    },
    captureMessage: (message, fields) => {
      logger.error(message, { ...fields, captured: true })
    },
    flush: async () => true,
  }
}

/**
 * The `beforeSend` body, expressed once and vendor-shaped nowhere.
 *
 * Applies the capability scrub across the whole event — message, exception
 * values, request url and query string, headers, cookies, breadcrumbs, tags and
 * extra — because a lobby code leaks through whichever of those the reporter
 * forgot about, not through the one it remembered.
 *
 * Returning `null` drops the event entirely; we never do that here, since an
 * error we chose not to see is worse than a scrubbed one.
 */
export function scrubEventForVendor<T>(event: T): T {
  return scrubValue(event, { maxDepth: 16 }) as T
}

export interface SamplingConfig {
  /** Errors: 1.0. We want every error; there are not many at our volume. */
  readonly errorSampleRate: number
  /**
   * Tracing: 0 to start. We have no latency question yet that justifies
   * spending a free-tier quota, and the quota is shared with another product.
   */
  readonly tracesSampleRate: number
  /** Session replay: off. The free allowance would be consumed by accident. */
  readonly replaysSessionSampleRate: number
  readonly replaysOnErrorSampleRate: number
}

/**
 * The deliberate event budget from [PER-7](/PER/issues/PER-7), in one place so
 * both app adapters read the same numbers and a change is reviewable.
 */
export const DEFAULT_SAMPLING: SamplingConfig = {
  errorSampleRate: 1,
  tracesSampleRate: 0,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
}
