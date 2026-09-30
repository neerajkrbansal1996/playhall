import { scrubValue } from './redact'

/**
 * Structured logging, written as an **injected sink** rather than a hard
 * dependency on `process.stdout` or a Node-only `pino` transport.
 *
 * The reason is hosting, and it is not hypothetical: ADR-0003 has Cloudflare
 * Durable Objects live as a candidate, whose runtime is `workerd`, not Node. A
 * logger that reaches for `process.stdout` pins `packages/platform-core` and the
 * room runner to Node. With the sink behind an interface, moving runtime is one
 * file; without it, it is every file.
 *
 * `pino` remains the intended Node sink (ADR-0001 §8). It wires in as a
 * `LogSink` adapter inside `apps/realtime`, where Node-only code is allowed —
 * it does not belong in `packages/shared`, which both runtimes import.
 */

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

/** pino-compatible numeric levels, so a pino sink needs no translation table. */
export const LOG_LEVEL_VALUES: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

export type LogFields = Readonly<Record<string, unknown>>

export interface LogRecord {
  readonly level: LogLevel
  readonly levelValue: number
  /** ISO-8601, from the injected clock. Never `Date.now()` inside the facade. */
  readonly time: string
  readonly msg: string
  /** Already scrubbed and serialisable. A sink must not re-scrub. */
  readonly fields: Readonly<Record<string, unknown>>
}

export interface LogSink {
  write(record: LogRecord): void
}

/**
 * Decides whether a record is emitted. Returning `false` drops it.
 *
 * ADR-0001 §8: per-action logs at 2,000 rooms would dominate CPU, so log every
 * room lifecycle event and sample the hot path.
 */
export type LogSampler = (record: LogRecord) => boolean

export interface Logger {
  readonly level: LogLevel
  /** Bind fields for every subsequent line. This is how `roomId` gets everywhere. */
  child(fields: LogFields): Logger
  isLevelEnabled(level: LogLevel): boolean
  trace(msg: string, fields?: LogFields): void
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  fatal(msg: string, fields?: LogFields): void
}

export interface LoggerOptions {
  readonly sink: LogSink
  readonly level?: LogLevel
  /**
   * Milliseconds since epoch. **Required, and injected** for the same reason the
   * sink is: `packages/shared` and `packages/platform-core` must not read
   * ambient time. That keeps the determinism rule structural rather than
   * lint-enforced, and it is what lets a test assert on an exact timestamp. The
   * app entry point supplies `() => Date.now()`; nothing in a package does.
   */
  readonly clock: () => number
  /** Fields bound on every line (service, environment, release, …). */
  readonly base?: LogFields
  readonly sampler?: LogSampler
  /** Extra field names to redact, on top of the built-in capability list. */
  readonly extraRedactKeys?: readonly string[]
}

interface LoggerInternals {
  readonly sink: LogSink
  readonly level: LogLevel
  readonly threshold: number
  readonly clock: () => number
  readonly sampler: LogSampler | undefined
  readonly extraRedactKeys: readonly string[]
}

function makeLogger(internals: LoggerInternals, bound: LogFields): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    const levelValue = LOG_LEVEL_VALUES[level]
    if (levelValue < internals.threshold) return

    const merged = fields ? { ...bound, ...fields } : bound
    const scrubbed = scrubValue(merged, { extraKeys: internals.extraRedactKeys }) as Readonly<
      Record<string, unknown>
    >

    const record: LogRecord = {
      level,
      levelValue,
      time: new Date(internals.clock()).toISOString(),
      msg: scrubValue(msg) as string,
      fields: scrubbed,
    }

    // Errors and worse are never sampled away — the whole point of sampling is
    // to shed volume from the hot path, not to lose the failures.
    if (internals.sampler && levelValue < LOG_LEVEL_VALUES.error && !internals.sampler(record)) {
      return
    }
    internals.sink.write(record)
  }

  return {
    level: internals.level,
    child: (fields) => makeLogger(internals, { ...bound, ...fields }),
    isLevelEnabled: (level) => LOG_LEVEL_VALUES[level] >= internals.threshold,
    trace: (msg, fields) => emit('trace', msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    fatal: (msg, fields) => emit('fatal', msg, fields),
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info'
  return makeLogger(
    {
      sink: options.sink,
      level,
      threshold: LOG_LEVEL_VALUES[level],
      clock: options.clock,
      sampler: options.sampler,
      extraRedactKeys: options.extraRedactKeys ?? [],
    },
    options.base ?? {},
  )
}

export interface SamplingPolicy {
  /**
   * `event` values always kept, whatever the rate. Room lifecycle events go
   * here: `room.created`, `room.closed`, `match.started`, `match.finished`.
   */
  readonly always?: readonly string[]
  /** Fraction of everything else to keep, 0..1. `1` keeps all. */
  readonly rate?: number
}

/**
 * Counter-based 1-in-N sampling, per `event`. Deterministic on purpose: no
 * `Math.random()` anywhere near the room runner, and a test can assert exactly
 * which lines survive.
 */
export function createSampler(policy: SamplingPolicy): LogSampler {
  const always = new Set(policy.always ?? [])
  const rate = policy.rate ?? 1
  if (rate >= 1) return () => true
  const keepEvery = rate <= 0 ? Number.POSITIVE_INFINITY : Math.max(1, Math.round(1 / rate))
  const counters = new Map<string, number>()

  return (record) => {
    const event = record.fields['event']
    const key = typeof event === 'string' ? event : ''
    if (always.has(key)) return true
    if (keepEvery === Number.POSITIVE_INFINITY) return false
    const seen = (counters.get(key) ?? 0) + 1
    counters.set(key, seen === keepEvery ? 0 : seen)
    return seen === 1
  }
}
