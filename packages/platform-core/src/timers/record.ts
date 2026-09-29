/**
 * The timer record and the pure arithmetic over it.
 *
 * ## The one idea that makes drift impossible
 *
 * A timer is never decremented. It stores a **budget** (`remainingMs`) and the
 * **instant that budget was exact** (`startedAtMs`), and the remaining time at
 * any later instant is recomputed from those two numbers:
 *
 *     remaining(now) = remainingMs - chargeable(now - startedAtMs)
 *
 * The alternative — a tick loop that subtracts the elapsed slice each pass —
 * accumulates the error of every single tick, and `setTimeout`/`setInterval`
 * are late by a few milliseconds on every pass under load. At 30 Hz that is
 * seconds of error over a five-minute game. Recomputing from an anchor has
 * *no* accumulating term: the only error is the error of the current reading.
 *
 * Every function here is pure, takes `nowMs` explicitly, and returns a new
 * record. That is what lets the room runner replay the match log and land on
 * exactly the clock state a live server would have had.
 */

import type { SeatId, TimerId, TimerKind } from '@playhall/game-sdk'

/**
 * How a per-player clock hands time back.
 *
 * - `none` — the budget is all there is.
 * - `simple` (US delay / Bronstein-delay's stricter cousin) — the first
 *   `delayMs` of a turn does not touch the budget at all. The clock visibly
 *   waits, then counts down.
 * - `bronstein` — the budget counts down from the first millisecond, and at the
 *   end of the turn the smaller of `delayMs` and the time actually used is
 *   handed back. Same total as `simple` over a whole game, different display.
 */
export type DelayMode = 'none' | 'simple' | 'bronstein'

/**
 * A per-player clock. Chess is the obvious consumer, but nothing here is
 * chess-specific: any game whose manifest declares a `chess-clock` timer gets
 * increment and delay for free and must not implement its own.
 */
export interface PlayerClockConfig {
  /** Starting budget. */
  readonly initialMs: number
  /** Fischer increment, credited when the seat completes a turn. */
  readonly incrementMs: number
  /** Delay budget per turn. Ignored when `delayMode` is `none`. */
  readonly delayMs: number
  readonly delayMode: DelayMode
  /**
   * Ceiling the budget may not exceed after an increment, or null for none.
   * Some time controls cap accumulation; most do not.
   */
  readonly maxMs: number | null
}

export const DEFAULT_PLAYER_CLOCK: PlayerClockConfig = {
  initialMs: 0,
  incrementMs: 0,
  delayMs: 0,
  delayMode: 'none',
  maxMs: null,
}

/**
 * One timer instance.
 *
 * Deliberately a flat, JSON-safe record: this is what goes into Redis, so a
 * server that dies mid-match can be replaced by one that reads these fields
 * back and resumes with the same deadlines.
 */
export interface TimerRecord {
  readonly timerId: TimerId
  /** The seat the timer belongs to; null for a match-wide or phase timer. */
  readonly seatId: SeatId | null
  readonly kind: TimerKind
  /** Budget remaining as of `startedAtMs`, or the frozen value when paused. */
  readonly remainingMs: number
  /** Server time at which `remainingMs` was exact. Null when not running. */
  readonly startedAtMs: number | null
  /** Unconsumed `simple` delay for the current turn. */
  readonly delayRemainingMs: number
  /** Raw wall time already spent on the current turn, across pauses. */
  readonly turnElapsedMs: number
  /** Present only for `chess-clock` timers. */
  readonly clock: PlayerClockConfig | null
  /** True once the budget reached zero. Terminal until the timer is re-set. */
  readonly expired: boolean
  /**
   * Bumped on every mutation. The client uses it to drop a `timer:sync` that
   * overtook a newer one on a different socket frame.
   */
  readonly version: number
}

export interface CreateTimerRecordInput {
  readonly timerId: TimerId
  readonly seatId: SeatId | null
  readonly kind: TimerKind
  readonly durationMs: number
  readonly clock?: PlayerClockConfig | null
  /** Omit to create the timer stopped; supply to start it immediately. */
  readonly startedAtMs?: number | null
}

export function createTimerRecord(input: CreateTimerRecordInput): TimerRecord {
  const clock = input.clock ?? null
  return {
    timerId: input.timerId,
    seatId: input.seatId,
    kind: input.kind,
    remainingMs: Math.max(0, input.durationMs),
    startedAtMs: input.startedAtMs ?? null,
    delayRemainingMs: clock?.delayMode === 'simple' ? clock.delayMs : 0,
    turnElapsedMs: 0,
    clock,
    expired: false,
    version: 1,
  }
}

function bump(record: TimerRecord, patch: Partial<TimerRecord>): TimerRecord {
  return { ...record, ...patch, version: record.version + 1 }
}

export function isRunning(record: TimerRecord): boolean {
  return !record.expired && record.startedAtMs !== null
}

/**
 * Wall time since the timer was last anchored. Clamped at zero so a wall-clock
 * step backwards across a restart cannot *add* time to a player's clock.
 */
export function rawElapsedMs(record: TimerRecord, nowMs: number): number {
  if (record.startedAtMs === null) return 0
  return Math.max(0, nowMs - record.startedAtMs)
}

/**
 * The part of the elapsed time that actually comes out of the budget. Under
 * `simple` delay the first `delayRemainingMs` of the turn is free; under
 * `bronstein` and `none` every millisecond is charged (bronstein refunds at
 * the end of the turn instead).
 */
export function chargeableElapsedMs(record: TimerRecord, nowMs: number): number {
  const elapsed = rawElapsedMs(record, nowMs)
  if (record.clock?.delayMode === 'simple') {
    return Math.max(0, elapsed - record.delayRemainingMs)
  }
  return elapsed
}

/** Remaining budget at `nowMs`. Never negative. */
export function remainingMsAt(record: TimerRecord, nowMs: number): number {
  if (record.expired) return 0
  return Math.max(0, record.remainingMs - chargeableElapsedMs(record, nowMs))
}

/**
 * How much of the current turn's `simple` delay is still unspent at `nowMs`.
 * This is what a client renders as the "delay" pip before the digits move.
 */
export function delayRemainingMsAt(record: TimerRecord, nowMs: number): number {
  if (record.clock?.delayMode !== 'simple') return 0
  return Math.max(0, record.delayRemainingMs - rawElapsedMs(record, nowMs))
}

/**
 * Absolute server time at which this timer expires, or null if it is not
 * running. This — not a countdown — is what goes on the wire: an absolute
 * deadline is self-correcting on the client, a countdown is not.
 */
export function deadlineMsAt(record: TimerRecord): number | null {
  if (!isRunning(record) || record.startedAtMs === null) return null
  const free = record.clock?.delayMode === 'simple' ? record.delayRemainingMs : 0
  return record.startedAtMs + free + record.remainingMs
}

/** Starts (or restarts) the timer running from `nowMs`. */
export function startRecord(record: TimerRecord, nowMs: number): TimerRecord {
  if (record.expired || isRunning(record)) return record
  return bump(record, { startedAtMs: nowMs })
}

/**
 * Freezes the timer, committing everything spent so far. Idempotent, so the
 * disconnect path can pause a timer that is already paused without corrupting
 * it.
 */
export function pauseRecord(record: TimerRecord, nowMs: number): TimerRecord {
  if (!isRunning(record)) return record
  const elapsed = rawElapsedMs(record, nowMs)
  return bump(record, {
    remainingMs: remainingMsAt(record, nowMs),
    delayRemainingMs: delayRemainingMsAt(record, nowMs),
    turnElapsedMs: record.turnElapsedMs + elapsed,
    startedAtMs: null,
  })
}

/** Re-anchors a paused timer to `nowMs`. */
export function resumeRecord(record: TimerRecord, nowMs: number): TimerRecord {
  return startRecord(record, nowMs)
}

/** Marks the timer fired. The budget is spent; `onTimer` is the runner's job. */
export function expireRecord(record: TimerRecord): TimerRecord {
  if (record.expired) return record
  return bump(record, { expired: true, remainingMs: 0, startedAtMs: null })
}

/**
 * Ends the current turn on a per-player clock: commit what was spent, then
 * credit the Fischer increment and (under `bronstein`) refund the delay
 * actually used. Resets the per-turn delay budget for the next turn.
 *
 * Order matters and is the FIDE order: the increment is credited *after* the
 * move, so a player who flags mid-move does not get it. `endTurn` on an
 * already-expired clock is therefore a no-op.
 */
export function endTurnRecord(record: TimerRecord, nowMs: number): TimerRecord {
  const config = record.clock
  if (config === null) return pauseRecord(record, nowMs)

  const paused = pauseRecord(record, nowMs)
  if (paused.expired || paused.remainingMs <= 0) {
    return paused
  }

  const refundMs =
    config.delayMode === 'bronstein' ? Math.min(config.delayMs, paused.turnElapsedMs) : 0
  const credited = paused.remainingMs + refundMs + config.incrementMs
  const capped = config.maxMs === null ? credited : Math.min(credited, config.maxMs)

  return bump(paused, {
    remainingMs: capped,
    delayRemainingMs: config.delayMode === 'simple' ? config.delayMs : 0,
    turnElapsedMs: 0,
  })
}

/**
 * Replaces the budget without touching identity or configuration. Used by the
 * SDK `set` command when a game re-arms a timer it already owns.
 */
export function resetRecord(
  record: TimerRecord,
  durationMs: number,
  startedAtMs: number | null,
): TimerRecord {
  return bump(record, {
    remainingMs: Math.max(0, durationMs),
    startedAtMs,
    delayRemainingMs: record.clock?.delayMode === 'simple' ? record.clock.delayMs : 0,
    turnElapsedMs: 0,
    expired: false,
  })
}
