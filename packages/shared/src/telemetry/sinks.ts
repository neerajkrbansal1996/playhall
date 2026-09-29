import { LOG_LEVEL_VALUES, type LogLevel, type LogRecord, type LogSink } from './log'

/**
 * Sinks are the only place a runtime leaks in, and none of these needs Node.
 * `console.log` exists in Node, in `workerd` and in the browser; a `pino`
 * transport does not. That asymmetry is the whole reason for this seam.
 */

/** Emits newline-delimited JSON with pino-compatible field names. */
export function serializeLogRecord(record: LogRecord): string {
  return JSON.stringify({
    level: record.levelValue,
    levelName: record.level,
    time: record.time,
    msg: record.msg,
    ...record.fields,
  })
}

export interface JsonLineSinkOptions {
  /** Where a serialised line goes. Defaults to `console.log`. */
  readonly write?: (line: string) => void
}

export function createJsonLineSink(options: JsonLineSinkOptions = {}): LogSink {
  const write = options.write ?? ((line: string) => console.log(line))
  return { write: (record) => write(serializeLogRecord(record)) }
}

export interface MemorySink extends LogSink {
  readonly records: readonly LogRecord[]
  lines(): string[]
  clear(): void
}

/** For tests and for the testkit — asserts on records, not on stdout scraping. */
export function createMemorySink(): MemorySink {
  const records: LogRecord[] = []
  return {
    records,
    write: (record) => {
      records.push(record)
    },
    lines: () => records.map(serializeLogRecord),
    clear: () => {
      records.length = 0
    },
  }
}

export function createMultiSink(...sinks: readonly LogSink[]): LogSink {
  return {
    write: (record) => {
      for (const sink of sinks) sink.write(record)
    },
  }
}

/** Drops anything below `level`. Useful to send only warnings to a second sink. */
export function createLevelFilterSink(level: LogLevel, sink: LogSink): LogSink {
  const threshold = LOG_LEVEL_VALUES[level]
  return {
    write: (record) => {
      if (record.levelValue >= threshold) sink.write(record)
    },
  }
}

export const nullSink: LogSink = { write: () => undefined }
