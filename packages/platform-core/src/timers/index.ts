/**
 * The platform timer service.
 *
 * One clock implementation for every game, turn-based and (later) real-time.
 * A game declares its timers in the manifest, asks for them with the SDK's
 * `setTimer`/`clearTimer`/`pauseTimer`/`resumeTimer` commands, and renders the
 * `TimerView[]` it is handed. It never reads a clock and never counts down.
 */

export type { DelayMode, PlayerClockConfig, TimerHold, TimerRecord } from './record.js'
export {
  DEFAULT_PLAYER_CLOCK,
  TIMER_HOLD_ORDER,
  chargeableElapsedMs,
  createTimerRecord,
  deadlineMsAt,
  delayRemainingMsAt,
  endTurnRecord,
  expireRecord,
  isHeld as isTimerHeld,
  isRunning as isTimerRunning,
  pauseRecord,
  rawElapsedMs,
  remainingMsAt,
  resetRecord,
  resumeRecord,
  startRecord,
  withHolds,
} from './record.js'

export type { Scheduler } from './scheduler.js'
export { createManualScheduler, createTimeoutScheduler } from './scheduler.js'

export type {
  RestoreTimerServiceOptions,
  TimerExpiry,
  TimerServiceOptions,
  TimerViewEntry,
} from './service.js'
export { TimerService, restoreTimerService } from './service.js'

export type {
  ClientTimerView,
  OffsetEstimate,
  RoundTripSample,
  TimerSyncTrackerOptions,
} from './sync.js'
export { ServerTimeSync, TimerSyncTracker } from './sync.js'

export type {
  AnyTimerSnapshot,
  TimerSnapshot,
  TimerSyncEntry,
  TimerSyncMessage,
  TimerSyncRequest,
} from './wire.js'
export {
  timerSnapshotSchema,
  timerSnapshotV1Schema,
  timerSnapshotV2Schema,
  timerSyncEntrySchema,
  timerSyncMessageSchema,
  timerSyncRequestSchema,
} from './wire.js'
