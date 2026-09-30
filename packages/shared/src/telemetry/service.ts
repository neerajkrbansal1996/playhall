import { createLogger, createSampler, type LogLevel, type Logger, type LogSink } from './log'
import { createJsonLineSink } from './sinks'
import type { CorrelationId } from './correlation'
import type { ReleaseIdentity } from './release'

/**
 * Assembles the per-service logger. One place decides which fields are on every
 * line, so "filter one room's whole life out of the log stream" is a property of
 * the platform rather than a convention each call site remembers.
 */

/** Room lifecycle events are never sampled away (ADR-0001 §8). */
export const ALWAYS_LOGGED_EVENTS = [
  'room.created',
  'room.joined',
  'room.left',
  'room.seat_changed',
  'room.host_transferred',
  'room.closed',
  'room.expired',
  'match.started',
  'match.finished',
  'match.aborted',
  'client.reconnected',
  'client.version_gap',
  'server.started',
  'server.stopping',
] as const

export interface ServiceLoggerOptions {
  readonly release: ReleaseIdentity
  readonly level?: LogLevel
  /** Defaults to newline-delimited JSON on `console.log`. */
  readonly sink?: LogSink
  /** Fraction of non-lifecycle events kept. `1` in dev, lower under load. */
  readonly hotPathSampleRate?: number
  /** Injected wall clock. See `LoggerOptions.clock` for why it is required. */
  readonly clock: () => number
}

export function createServiceLogger(options: ServiceLoggerOptions): Logger {
  const rate = options.hotPathSampleRate ?? 1
  return createLogger({
    sink: options.sink ?? createJsonLineSink(),
    level: options.level ?? (options.release.environment === 'production' ? 'info' : 'debug'),
    clock: options.clock,
    base: {
      service: options.release.service,
      release: options.release.release,
      environment: options.release.environment,
    },
    sampler: rate >= 1 ? undefined : createSampler({ always: [...ALWAYS_LOGGED_EVENTS], rate }),
  })
}

export interface RequestScope {
  readonly correlationId: CorrelationId
  readonly roomId?: string
  readonly guestId?: string
}

/**
 * Binds the correlation scope. `correlationId` and `roomId` are **distinct and
 * both present**: one follows a player's causal chain across hops, the other
 * groups every player in a match. Filtering by either has to work.
 */
export function withScope(logger: Logger, scope: RequestScope): Logger {
  const fields: Record<string, unknown> = { correlationId: scope.correlationId }
  if (scope.roomId !== undefined) fields['roomId'] = scope.roomId
  if (scope.guestId !== undefined) fields['guestId'] = scope.guestId
  return logger.child(fields)
}
