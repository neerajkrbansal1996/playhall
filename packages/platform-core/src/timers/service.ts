/**
 * The timer service. Every clock in the platform is one of these; no game ever
 * implements its own.
 *
 * ## Responsibilities
 *
 * - Own per-player clocks (increment + delay), per-turn timers, phase timers
 *   and the match timer for one match.
 * - Execute the `TimerCommand`s a game returns from `applyAction`. A game
 *   *asks*; the service *schedules*. That split is what keeps `applyAction`
 *   pure and replayable.
 * - Fire expiries outwards so the room runner can call
 *   `game.onTimer(ctx, state, timerId, seatId)` — flag-fall and turn timeout.
 * - Produce `timer:sync` frames and a JSON snapshot that survives a restart.
 *
 * ## What it deliberately does not do
 *
 * It does not know what a game is, does not call `onTimer` itself, and does not
 * touch Redis. The room runner (M1.6) owns the game module, the match log and
 * persistence; handing this service any of those would put a game-shaped
 * dependency into platform-core and make the clock untestable without a
 * database.
 */

import type {
  MatchId,
  SeatId,
  TimerCommand,
  TimerId,
  TimerKind,
  TimerSpec,
  Viewer,
} from '@playhall/game-sdk'
import type { Clock } from './clock.js'
import { createSystemClock } from './clock.js'
import { type Scheduler, createTimeoutScheduler } from './scheduler.js'
import {
  DEFAULT_PLAYER_CLOCK,
  type PlayerClockConfig,
  type TimerRecord,
  createTimerRecord,
  deadlineMsAt,
  delayRemainingMsAt,
  endTurnRecord,
  expireRecord,
  isRunning,
  pauseRecord,
  remainingMsAt,
  resetRecord,
  resumeRecord,
  startRecord,
} from './record.js'
import {
  type TimerSnapshot,
  type TimerSyncEntry,
  type TimerSyncMessage,
  timerSnapshotSchema,
} from './wire.js'

/** Shape the room runner receives when a timer fires. */
export interface TimerExpiry {
  readonly timerId: TimerId
  readonly seatId: SeatId | null
  readonly kind: TimerKind
  /** Server time the timer was *due*. Use this as `ctx.now` when replaying. */
  readonly dueAtMs: number
  /** Server time the service actually noticed. */
  readonly firedAtMs: number
  /**
   * `firedAtMs - dueAtMs`. Event-loop jitter, not clock error — the budget was
   * charged against `dueAtMs`, so a late wake-up never costs a player time. We
   * surface it so the room runner can log it and we can watch it in production.
   */
  readonly latenessMs: number
}

/** The subset of `TimerView` the SDK hands to a game's UI, built from a record. */
export interface TimerViewEntry {
  readonly timerId: string
  readonly seatId: SeatId | null
  readonly kind: TimerKind
  readonly remainingMs: number
  readonly isRunning: boolean
}

export interface TimerServiceOptions {
  readonly matchId: MatchId
  /** Defaults to the shared system clock. Tests pass a manual clock. */
  readonly clock?: Clock
  /** Defaults to a `setTimeout` scheduler over `clock`. */
  readonly scheduler?: Scheduler
  /**
   * The manifest's declared timers. When supplied, a `set` for an id the game
   * never declared is rejected — the same "reject what was not declared" rule
   * the SDK applies to `onTimer`.
   */
  readonly specs?: readonly TimerSpec[]
  /** Invoked once per expiry, in deadline order. */
  readonly onExpire?: (expiry: TimerExpiry) => void
}

/** Tolerance for an early `setTimeout` wake-up. Node is late far more often. */
const FIRE_TOLERANCE_MS = 1

export class TimerService {
  readonly matchId: MatchId

  #clock: Clock
  #scheduler: Scheduler
  #specs: ReadonlyMap<string, TimerSpec> | null
  #onExpire: (expiry: TimerExpiry) => void
  #records = new Map<string, TimerRecord>()
  #disposed = false
  /** Guards against an `onExpire` handler that re-enters via `apply`. */
  #firing = false

  constructor(options: TimerServiceOptions) {
    this.matchId = options.matchId
    this.#clock = options.clock ?? createSystemClock()
    this.#scheduler = options.scheduler ?? createTimeoutScheduler(this.#clock)
    this.#specs = options.specs ? new Map(options.specs.map((spec) => [spec.id, spec])) : null
    this.#onExpire = options.onExpire ?? (() => {})
  }

  get now(): number {
    return this.#clock.now()
  }

  // ---------------------------------------------------------------- queries

  get(timerId: TimerId): TimerRecord | undefined {
    return this.#records.get(timerId)
  }

  list(): readonly TimerRecord[] {
    return [...this.#records.values()]
  }

  /** Remaining budget right now. Zero for an unknown or expired timer. */
  remainingMs(timerId: TimerId): number {
    const record = this.#records.get(timerId)
    return record === undefined ? 0 : remainingMsAt(record, this.#clock.now())
  }

  /** Unspent `simple` delay right now. Zero unless the clock uses that mode. */
  delayRemainingMs(timerId: TimerId): number {
    const record = this.#records.get(timerId)
    return record === undefined ? 0 : delayRemainingMsAt(record, this.#clock.now())
  }

  isRunning(timerId: TimerId): boolean {
    const record = this.#records.get(timerId)
    return record !== undefined && isRunning(record)
  }

  /** Earliest deadline across all running timers, or null if nothing is armed. */
  nextDeadlineMs(): number | null {
    let earliest: number | null = null
    for (const record of this.#records.values()) {
      const deadline = deadlineMsAt(record)
      if (deadline !== null && (earliest === null || deadline < earliest)) earliest = deadline
    }
    return earliest
  }

  // --------------------------------------------------------------- mutation

  /**
   * Declares a per-player clock. Created stopped: the runner starts it by
   * calling `switchTurnTo` when the first seat is to move.
   */
  declarePlayerClock(
    timerId: TimerId,
    seatId: SeatId,
    config: Partial<PlayerClockConfig>,
  ): TimerRecord {
    const merged: PlayerClockConfig = { ...DEFAULT_PLAYER_CLOCK, ...config }
    this.#assertDeclared(timerId)
    const record = createTimerRecord({
      timerId,
      seatId,
      kind: 'chess-clock',
      durationMs: merged.initialMs,
      clock: merged,
    })
    this.#records.set(timerId, record)
    this.#rearm()
    return record
  }

  /**
   * Arms a one-shot timer `delayMs` from `issuedAtMs`.
   *
   * `issuedAtMs` is the `ctx.now` of the call that produced the command, never
   * "now" — a game that asks for a 30 s turn timer must get 30 s from the
   * instant its action was stamped, not 30 s from whenever the service got
   * round to it. That is the whole reason `TimerCommand.delayMs` is relative.
   */
  set(
    timerId: TimerId,
    options: {
      seatId?: SeatId | null
      delayMs: number
      kind?: TimerKind
      replace?: boolean
      issuedAtMs?: number
    },
  ): TimerRecord {
    this.#assertDeclared(timerId)
    const issuedAtMs = options.issuedAtMs ?? this.#clock.now()
    const existing = this.#records.get(timerId)

    if (existing !== undefined && options.replace === false && !existing.expired) {
      return existing
    }

    const record =
      existing === undefined
        ? createTimerRecord({
            timerId,
            seatId: options.seatId ?? null,
            kind: options.kind ?? this.#specs?.get(timerId)?.kind ?? 'custom',
            durationMs: options.delayMs,
            startedAtMs: issuedAtMs,
          })
        : resetRecord(existing, options.delayMs, issuedAtMs)

    this.#records.set(timerId, record)
    this.#afterMutation()
    return record
  }

  clear(timerId: TimerId): void {
    if (this.#records.delete(timerId)) this.#rearm()
  }

  pause(timerId: TimerId, atMs?: number): void {
    this.#mutate(timerId, (record) => pauseRecord(record, atMs ?? this.#clock.now()))
  }

  resume(timerId: TimerId, atMs?: number): void {
    this.#mutate(timerId, (record) => resumeRecord(record, atMs ?? this.#clock.now()))
  }

  /**
   * Ends the running per-player clock's turn (crediting increment and any
   * Bronstein refund) and starts `toSeatId`'s clock. Passing null just stops
   * the clock — the match is over, or a phase without a mover has begun.
   *
   * This is the only correct way to hand the move over: doing it as a separate
   * `pause` then `resume` loses the increment.
   */
  switchTurnTo(toSeatId: SeatId | null, atMs?: number): void {
    const nowMs = atMs ?? this.#clock.now()
    for (const [id, record] of this.#records) {
      if (record.kind !== 'chess-clock') continue
      if (isRunning(record) && record.seatId !== toSeatId) {
        this.#records.set(id, endTurnRecord(record, nowMs))
      }
    }
    if (toSeatId !== null) {
      for (const [id, record] of this.#records) {
        if (record.kind === 'chess-clock' && record.seatId === toSeatId && !record.expired) {
          this.#records.set(id, startRecord(record, nowMs))
        }
      }
    }
    this.#afterMutation(nowMs)
  }

  /**
   * Freezes every timer that the manifest says pauses on disconnect, for one
   * seat. Timers without a spec are treated as pausing — the safe default is
   * the one that cannot take time off a player who is not there.
   */
  pauseForSeat(seatId: SeatId, atMs?: number): void {
    const nowMs = atMs ?? this.#clock.now()
    for (const [id, record] of this.#records) {
      if (record.seatId !== seatId) continue
      if (this.#specs?.get(id)?.pausesOnDisconnect === false) continue
      this.#records.set(id, pauseRecord(record, nowMs))
    }
    this.#rearm()
  }

  /** Resumes what `pauseForSeat` froze. */
  resumeForSeat(seatId: SeatId, atMs?: number): void {
    const nowMs = atMs ?? this.#clock.now()
    for (const [id, record] of this.#records) {
      if (record.seatId !== seatId) continue
      if (this.#specs?.get(id)?.pausesOnDisconnect === false) continue
      this.#records.set(id, resumeRecord(record, nowMs))
    }
    this.#rearm()
  }

  /** Freezes everything — a host pause, or a room waiting on a rematch vote. */
  pauseAll(atMs?: number): void {
    const nowMs = atMs ?? this.#clock.now()
    for (const [id, record] of this.#records) this.#records.set(id, pauseRecord(record, nowMs))
    this.#rearm()
  }

  resumeAll(atMs?: number): void {
    const nowMs = atMs ?? this.#clock.now()
    for (const [id, record] of this.#records) this.#records.set(id, resumeRecord(record, nowMs))
    this.#rearm()
  }

  /**
   * Executes the timer commands a game returned. `issuedAtMs` must be the
   * `ctx.now` the game saw.
   */
  apply(commands: readonly TimerCommand[], issuedAtMs: number): void {
    for (const command of commands) {
      switch (command.op) {
        case 'set':
          this.set(command.timerId, {
            seatId: command.seatId,
            delayMs: command.delayMs,
            replace: command.replace,
            issuedAtMs,
          })
          break
        case 'clear':
          this.clear(command.timerId)
          break
        case 'pause':
          this.pause(command.timerId, issuedAtMs)
          break
        case 'resume':
          this.resume(command.timerId, issuedAtMs)
          break
      }
    }
  }

  // ----------------------------------------------------------------- firing

  /**
   * Fires every timer now due. Called by the scheduler; tests call it directly
   * after advancing a manual clock.
   *
   * Expiries are delivered in deadline order so a match timer and a player
   * clock that expire in the same pass reach the runner in the order they
   * actually happened.
   */
  poll(): readonly TimerExpiry[] {
    if (this.#disposed || this.#firing) return []
    const firedAtMs = this.#clock.now()

    const due: { record: TimerRecord; dueAtMs: number }[] = []
    for (const record of this.#records.values()) {
      const deadline = deadlineMsAt(record)
      if (deadline === null) continue
      if (deadline - FIRE_TOLERANCE_MS <= firedAtMs) due.push({ record, dueAtMs: deadline })
    }
    if (due.length === 0) {
      this.#rearm()
      return []
    }
    due.sort((a, b) => a.dueAtMs - b.dueAtMs)

    // Expire everything before invoking a single handler: a handler that calls
    // back into `apply` must not observe a half-expired set.
    const expiries: TimerExpiry[] = due.map(({ record, dueAtMs }) => {
      this.#records.set(record.timerId, expireRecord(record))
      return {
        timerId: record.timerId,
        seatId: record.seatId,
        kind: record.kind,
        dueAtMs,
        firedAtMs,
        latenessMs: firedAtMs - dueAtMs,
      }
    })

    this.#firing = true
    try {
      for (const expiry of expiries) this.#onExpire(expiry)
    } finally {
      this.#firing = false
    }
    this.#rearm()
    return expiries
  }

  // ------------------------------------------------------------------- sync

  /**
   * Builds a `timer:sync` frame.
   *
   * Timers are not redacted: a remaining time is not hidden information in any
   * game we support, and hiding an opponent's clock would break the one thing
   * every player checks. `viewer` is accepted so the room runner has a single
   * call shape with the rest of the fan-out, and so a future game that *does*
   * hide a clock has a place to say so rather than a new code path.
   */
  sync(options?: { viewer?: Viewer; replyTo?: string | null; atMs?: number }): TimerSyncMessage {
    const serverTime = options?.atMs ?? this.#clock.now()
    return {
      type: 'timer:sync',
      matchId: this.matchId,
      serverTime,
      replyTo: options?.replyTo ?? null,
      timers: this.list().map((record) => toSyncEntry(record, serverTime)),
    }
  }

  /** The `TimerView[]` the SDK hands a game's UI. */
  views(atMs?: number): readonly TimerViewEntry[] {
    const nowMs = atMs ?? this.#clock.now()
    return this.list().map((record) => ({
      timerId: record.timerId,
      seatId: record.seatId,
      kind: record.kind,
      remainingMs: remainingMsAt(record, nowMs),
      isRunning: isRunning(record),
    }))
  }

  // ------------------------------------------------------------- durability

  /** JSON-safe state for Redis. Anchors stay absolute so a restart can resume. */
  snapshot(atMs?: number): TimerSnapshot {
    return {
      version: 1,
      matchId: this.matchId,
      savedAtMs: atMs ?? this.#clock.now(),
      timers: this.list().map((record) => ({ ...record, clock: record.clock })),
    }
  }

  dispose(): void {
    this.#disposed = true
    this.#scheduler.disarm()
    this.#records.clear()
  }

  // --------------------------------------------------------------- internal

  #assertDeclared(timerId: TimerId): void {
    if (this.#specs !== null && !this.#specs.has(timerId)) {
      throw new Error(
        `timer '${timerId}' is not declared in the game manifest; add a TimerSpec for it`,
      )
    }
  }

  #mutate(timerId: TimerId, fn: (record: TimerRecord) => TimerRecord): void {
    const record = this.#records.get(timerId)
    if (record === undefined) return
    this.#records.set(timerId, fn(record))
    this.#rearm()
  }

  /**
   * After any change that can move a deadline into the past — `switchTurnTo`
   * onto a seat that already flagged, a `set` with `delayMs: 0` — fire first,
   * then re-arm. Otherwise a zero-length timer would wait for the next
   * unrelated event to be noticed.
   */
  #afterMutation(nowMs?: number): void {
    const next = this.nextDeadlineMs()
    if (
      next !== null &&
      next - FIRE_TOLERANCE_MS <= (nowMs ?? this.#clock.now()) &&
      !this.#firing
    ) {
      this.poll()
      return
    }
    this.#rearm()
  }

  #rearm(): void {
    if (this.#disposed) return
    const next = this.nextDeadlineMs()
    if (next === null) {
      this.#scheduler.disarm()
      return
    }
    this.#scheduler.arm(next, () => this.poll())
  }

  /**
   * Rebuilds a service from a snapshot. This is the restart path.
   *
   * Anchors in the snapshot are absolute epoch milliseconds, because a
   * monotonic counter does not survive a process, let alone a move to another
   * host. The cost is that the restored clock depends on the wall clock
   * agreeing across the two processes — so a snapshot stamped *after* the
   * restoring process's own clock (a backwards wall-clock step) is rejected
   * rather than trusted.
   *
   * The snapshot is parsed, not cast. It comes back out of Redis, which is the
   * one place a stale-shaped blob can silently become a wrong clock.
   */
  static restore(snapshot: unknown, options: RestoreTimerServiceOptions): TimerService {
    const parsed = timerSnapshotSchema.parse(snapshot)
    const clock = options.clock ?? createSystemClock()
    const service = new TimerService({ ...options, clock, matchId: parsed.matchId as MatchId })
    const nowMs = clock.now()
    const chargeDowntime = options.chargeDowntime ?? true

    if (parsed.savedAtMs > nowMs) {
      throw new Error(
        `timer snapshot for match ${parsed.matchId} is stamped ${parsed.savedAtMs - nowMs} ms in the future; ` +
          'refusing to restore against a wall clock that stepped backwards',
      )
    }

    for (const timer of parsed.timers) {
      const record: TimerRecord = {
        ...timer,
        timerId: timer.timerId as TimerId,
        seatId: timer.seatId as SeatId | null,
      }
      // A crash keeps the original anchor: from the players' point of view the
      // clock never stopped, so the downtime is theirs. A planned drain commits
      // what was spent up to the snapshot and re-anchors to now, which is the
      // only way to *not* charge it — simply moving the anchor forward without
      // committing would hand back everything played since the clock started.
      service.#records.set(
        timer.timerId,
        chargeDowntime ? record : resumeRecord(pauseRecord(record, parsed.savedAtMs), nowMs),
      )
    }

    // A flag may well have fallen while we were dead; surface it immediately
    // rather than on the next unrelated event.
    service.#afterMutation(nowMs)
    return service
  }
}

export interface RestoreTimerServiceOptions extends Omit<TimerServiceOptions, 'matchId'> {
  /**
   * Charge the wall time the process was down against running timers.
   *
   * `true` (the default) is correct for a crash: the players' clocks kept
   * running from their point of view. `false` is for a planned restart where
   * the room was drained first and nobody could move.
   */
  readonly chargeDowntime?: boolean
}

/** Free-function alias for `TimerService.restore`. */
export function restoreTimerService(
  snapshot: unknown,
  options: RestoreTimerServiceOptions,
): TimerService {
  return TimerService.restore(snapshot, options)
}

function toSyncEntry(record: TimerRecord, serverTime: number): TimerSyncEntry {
  const running = isRunning(record)
  return {
    timerId: record.timerId,
    seatId: record.seatId,
    kind: record.kind,
    state: record.expired ? 'expired' : running ? 'running' : 'paused',
    remainingMs: Math.round(remainingMsAt(record, serverTime)),
    deadlineAtMs: running ? Math.round(deadlineMsAt(record) ?? 0) : null,
    delayRemainingMs: Math.round(delayRemainingMsAt(record, serverTime)),
    version: record.version,
  }
}
