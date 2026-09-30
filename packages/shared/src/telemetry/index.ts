/**
 * The one thin telemetry facade (ADR-0001 §8). No call site outside this folder
 * names a vendor, and nothing in here needs Node — both properties are load
 * bearing, and both are cheaper to keep than to retrofit.
 */

export {
  CORRELATION_ID_FIELD,
  CORRELATION_ID_HEADER,
  CORRELATION_ID_LENGTH,
  CorrelationIdSchema,
  mintCorrelationId,
  parseCorrelationId,
  resolveCorrelationId,
  webCryptoRandomBytes,
  type CorrelationId,
  type RandomBytes,
  type ResolvedCorrelationId,
} from './correlation'

export {
  createLogger,
  createSampler,
  LOG_LEVEL_VALUES,
  LOG_LEVELS,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  type LogRecord,
  type LogSampler,
  type LogSink,
  type SamplingPolicy,
} from './log'

export {
  createJsonLineSink,
  createLevelFilterSink,
  createMemorySink,
  createMultiSink,
  nullSink,
  serializeLogRecord,
  type JsonLineSinkOptions,
  type MemorySink,
} from './sinks'

export {
  isSensitiveKey,
  redactRoomCode,
  REDACTED,
  scrubString,
  scrubValue,
  type ScrubOptions,
} from './redact'

export {
  createReleaseIdentity,
  DEPLOY_ENVIRONMENTS,
  DeployEnvironmentSchema,
  formatRelease,
  GitShaSchema,
  parseRelease,
  RELEASE_SEPARATOR,
  ServiceNameSchema,
  type DeployEnvironment,
  type ParsedRelease,
  type ReleaseIdentity,
  type ReleaseIdentityInput,
} from './release'

export {
  createLoggingErrorReporter,
  createNoopErrorReporter,
  DEFAULT_SAMPLING,
  scrubEventForVendor,
  type ErrorReporter,
  type ErrorReporterContext,
  type SamplingConfig,
} from './errors'

export {
  ALWAYS_LOGGED_EVENTS,
  createServiceLogger,
  withScope,
  type RequestScope,
  type ServiceLoggerOptions,
} from './service'
