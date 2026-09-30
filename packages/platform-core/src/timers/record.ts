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
 * Why a timer is being held stopped from *outside* the game's own state.
 *
 * ## A hold is a scope, not a property of a record
 *
 * A stopped timer has two completely different meanings and conflating them is
 * how a reconnect starts the clock of the player who is not to move. Black's
 * clock is stopped because it is White's move — that is the *game state*
 * speaking, and no resume should ever override it. Black's clock is also stopped
 * when Black drops — that is a *hold*, and the matching resume must lift it.
 *
 * The thing that makes holds correct is **where they live**. `room` is a
 * property of the room, `seat-disconnect` of the seat, and `timer` of the timer
 * id — so `TimerService` owns them as three scopes (`#roomHeld`, `#heldSeats`,
 * `#heldTimers`) and asks, for each record, which scopes cover it. Modelling a
 * hold as state stamped onto a record at the instant the pause ran cannot work:
 * a timer that was not running then — or that is created afterwards — escapes
 * the hold entirely, and a turn switch or a `set` inside a host pause starts a
 * clock that the room had stopped.
 *
 * The array on `TimerRecord.holds` is therefore **derived** bookkeeping: it is
 * recomputed from the scopes on every mutation, and it exists so that the wire
 * frame, the snapshot and `isHeld()` can say *why* a clock is stopped without
 * the reader having to re-run the scope arithmetic.
 *
 * Because it is a set, overlapping holds nest properly: a host pauses the room,
 * then a player drops, then the host unpauses — and that player's clock stays
 * stopped, because the seat scope still covers it.
 *
 * - `room` — a whole-room freeze: host pause, or a rematch vote.
 * - `seat-disconnect` — one seat is not there and its manifest does not say
 *   `pausesOnDisconnect: false`.
 * - `timer` — an explicit `pause` command from a game reducer.
 *
 * The values are duplicated in `timerRecordSchema`, which is what makes a new
 * hold reach Redis safely: the snapshot round-trip tests parse a real snapshot,
 * so a hold added here and not there fails immediately rather than in a restart.
 */
export type TimerHold = 'room' | 'seat-disconnect' | 'timer'

/** Canonical order, so two snapshots of the same state compare equal. */
export const TIMER_HOLD_ORDER: readonly TimerHold[] = ['room', 'seat-disconnect', 'timer']

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
   * Which hold scopes currently cover this timer, in `TIMER_HOLD_ORDER`. Empty
   * for a timer that is running, that is stopped because the game state says
   * so, or that has expired. Derived — `TimerService` recomputes it from its
   * scopes on every mutation. See `TimerHold`.
   */
  readonly holds: readonly TimerHold[]
  /**
   * Bumped on every mutation of this record, so a reader can tell two otherwise
   * identical snapshots apart. It rides on `timer:sync` for debugging and for a
   * future per-record ordering check; the client does **not** use it to order
   * frames today — `TimerSyncTracker.applySync` orders whole frames on
   * `serverTime`, because a sync frame is a complete picture and a per-record
   * counter cannot tell you that a timer was deleted.
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
    holds: [],
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

/** True while at least one hold is keeping this timer stopped. */
export function isHeld(record: TimerRecord): boolean {
  return record.holds.length > 0
}

/**
 * Starts (or restarts) the timer running from `nowMs`.
 *
 * Refuses while any hold is outstanding. That is deliberate: a hold outranks a
 * start, so a game reducer's `resume` can never un-pause a clock the platform is
 * holding because the player is not there. `TimerService` recomputes `holds`
 * before it decides to start anything, so this guard is the belt to that
 * braces — it makes a caller who skipped the reconciliation pass fail closed.
 */
export function startRecord(record: TimerRecord, nowMs: number): TimerRecord {
  if (record.expired || isRunning(record) || isHeld(record)) return record
  return bump(record, { startedAtMs: nowMs })
}

/**
 * Freezes the timer, committing everything spent so far. Idempotent, so the
 * disconnect path can pause a timer that is already paused without corrupting
 * it.
 *
 * Takes no hold. This is the raw freeze used by `switchTurnTo` and the restart
 * path, where the timer is stopped because the *game state* changed. Use
 * `applyHold` for a pause that something outside the game must later lift.
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

/** Re-anchors a paused, unheld timer to `nowMs`. */
export function resumeRecord(record: TimerRecord, nowMs: number): TimerRecord {
  return startRecord(record, nowMs)
}

/**
 * Records which hold scopes currently cover this timer.
 *
 * Purely bookkeeping — it moves no anchor and charges no time. Freezing and
 * re-anchoring are `pauseRecord` and `startRecord`, and `TimerService` calls
 * them from the same reconciliation pass that computes `holds`. Returns the
 * same object (no version bump) when nothing changed, so an idle pass over an
 * unchanged room does not churn the version every client is watching.
 */
export function withHolds(record: TimerRecord, holds: readonly TimerHold[]): TimerRecord {
  if (sameHolds(record.holds, holds)) return record
  return bump(record, { holds: [...holds] })
}

function sameHolds(left: readonly TimerHold[], right: readonly TimerHold[]): boolean {
  return left.length === right.length && left.every((hold, index) => hold === right[index])
}

/**
 * Marks the timer fired. The budget is spent; `onTimer` is the runner's job.
 *
 * Holds and the turn's unspent delay go with it: an expired clock is terminal
 * until `resetRecord`, and leaving a hold on it would mean a `releaseHold`
 * after a flag-fall tried to start a dead clock.
 */
export function expireRecord(record: TimerRecord): TimerRecord {
  if (record.expired) return record
  return bump(record, {
    expired: true,
    remainingMs: 0,
    startedAtMs: null,
    delayRemainingMs: 0,
    holds: [],
  })
}

/**
 * Ends the current turn on a per-player clock: commit what was spent, then
 * credit the Fischer increment and (under `bronstein`) refund the delay
 * actually used. Resets the per-turn delay budget for the next turn.
 *
 * Order matters and is the FIDE order: the increment is credited *after* the
 * move, so a player who flags mid-move does not get it. `endTurn` on an
 * already-expired clock is therefore a no-op.
 *
 * A budget that has reached zero is **expired**, never merely paused. The
 * invariant is that a record cannot reach `remainingMs === 0` and stay
 * un-expired: a record in that state is unrunnable, invisible to
 * `deadlineMsAt`, and would never produce a `TimerExpiry` — so the game would
 * never learn the player flagged. `TimerService` drains due expiries before
 * every mutation, so in practice a flag-fall is delivered by `poll()` and this
 * branch is the belt to that braces.
 */
export function endTurnRecord(record: TimerRecord, nowMs: number): TimerRecord {
  const config = record.clock
  if (config === null) return pauseRecord(record, nowMs)

  const paused = pauseRecord(record, nowMs)
  if (paused.expired) return paused
  if (paused.remainingMs <= 0) return expireRecord(paused)

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
 *
 * A re-armed timer starts from a clean slate: the turn's delay and elapsed time
 * reset and `expired` clears. `holds` is cleared too, but only as a starting
 * point — the service's reconciliation pass immediately puts back every scope
 * that still covers the timer, so a room pause survives a re-arm and only the
 * game's own `timer` hold (which the service drops on `set`) does not.
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
    holds: [],
  })
}
