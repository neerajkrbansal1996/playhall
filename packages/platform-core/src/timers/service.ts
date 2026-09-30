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
  TIMER_HOLD_ORDER,
  type TimerHold,
  type TimerRecord,
  createTimerRecord,
  deadlineMsAt,
  delayRemainingMsAt,
  endTurnRecord,
  expireRecord,
  isHeld,
  isRunning,
  pauseRecord,
  remainingMsAt,
  resetRecord,
  resumeRecord,
  startRecord,
  withHolds,
} from './record.js'
import {
  type AnyTimerSnapshot,
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
  /**
   * Invoked when a single mutation's expiry drain hits `MAX_DRAIN_PASSES` — an
   * `onExpire` handler re-armed an already-due timer more than 32 times. The
   * records passed here were **force-expired without `onExpire` being called**,
   * so the game never hears about them. It is a bug signal, not a normal path:
   * log it loudly. See `#drainDue`.
   */
  readonly onDrainExhausted?: (dropped: readonly TimerExpiry[]) => void
}

/**
 * Tolerance for an early `setTimeout` wake-up. Node is late far more often, but
 * it can be a millisecond early, which is why `TimerExpiry.latenessMs` can be
 * `-1`.
 */
const FIRE_TOLERANCE_MS = 1

/**
 * Cap on how many expiry passes one drain performs. `poll()` delivers a single
 * pass by design, so the drain loops; the cap is there because an `onExpire`
 * handler that re-arms an already-due timer on every pass would otherwise spin
 * forever inside a mutator.
 *
 * Hitting it is a bug in the handler, not a load condition. See `#drainDue` for
 * what happens then and why it is not "leave it to the scheduler".
 */
const MAX_DRAIN_PASSES = 32

export class TimerService {
  readonly matchId: MatchId

  #clock: Clock
  #scheduler: Scheduler
  #specs: ReadonlyMap<string, TimerSpec> | null
  #onExpire: (expiry: TimerExpiry) => void
  #onDrainExhausted: (dropped: readonly TimerExpiry[]) => void
  #records = new Map<string, TimerRecord>()
  #disposed = false
  /** Guards against an `onExpire` handler that re-enters via `apply`. */
  #firing = false

  // ------------------------------------------------- game state vs hold scopes
  //
  // Two questions decide whether a timer runs, and reading both off one boolean
  // (`isRunning`) is what produced every defect in the first two reviews:
  //
  //   1. does the *game state* want this timer counting down?
  //   2. is any *hold scope* covering it?
  //
  // (1) is `#onMoveSeatId` for a `chess-clock` and "armed and not expired" for
  // everything else. (2) is the three scopes below. A hold lives where the thing
  // it describes lives — the room, the seat, the timer id — never on a record,
  // because a record that was not running when the pause ran would not have been
  // stamped, and one created afterwards could not have been.
  //
  // Every mutator changes one of these and then calls `#reconcile`, which
  // recomputes runnability for every record and re-anchors or freezes it.

  /** The seat whose `chess-clock` timers may run. Game state; no hold overrides it. */
  #onMoveSeatId: SeatId | null = null
  /** Host pause / rematch vote: nothing in the room may run. */
  #roomHeld = false
  /** Seats that are absent, by `SeatId`. */
  #heldSeats = new Set<string>()
  /** Timer ids a game reducer paused explicitly. */
  #heldTimers = new Set<string>()

  constructor(options: TimerServiceOptions) {
    this.matchId = options.matchId
    this.#clock = options.clock ?? createSystemClock()
    this.#scheduler = options.scheduler ?? createTimeoutScheduler(this.#clock)
    this.#specs = options.specs ? new Map(options.specs.map((spec) => [spec.id, spec])) : null
    this.#onExpire = options.onExpire ?? (() => {})
    this.#onDrainExhausted = options.onDrainExhausted ?? (() => {})
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

  /**
   * True while something outside the game state is holding this timer stopped —
   * a host pause, a disconnected seat, or a game's own `pause` command. A timer
   * that is merely not this seat's move is *not* held, and neither is an expired
   * one: a flag-fall is terminal, so no later resume may revive it.
   */
  isHeld(timerId: TimerId): boolean {
    const record = this.#records.get(timerId)
    return record !== undefined && isHeld(record)
  }

  /** The seat whose per-player clock may run, as last set by `switchTurnTo`. */
  get onMoveSeatId(): SeatId | null {
    return this.#onMoveSeatId
  }

  /**
   * Earliest deadline across all running timers, or null if nothing is armed.
   * This is the `dueAt` score the room runner writes into its scheduling set.
   *
   * Read it **after** the mutating call returns, never before. Every mutator
   * drains due expiries first, so a whole expiry pass — and the `onExpire`
   * handlers behind it — can run synchronously inside `apply()` or
   * `switchTurnTo()`. A value read beforehand is stale by the time you would
   * store it.
   */
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
    const nowMs = this.#clock.now()
    this.#records.set(
      timerId,
      createTimerRecord({
        timerId,
        seatId,
        kind: 'chess-clock',
        durationMs: merged.initialMs,
        clock: merged,
      }),
    )
    // Declaring a clock for the seat that is already on move starts it, which
    // is the only sane reading of "this seat is to move and now has a clock".
    this.#reconcile(nowMs)
    this.#rearm()
    return this.#records.get(timerId) as TimerRecord
  }

  /**
   * Arms a one-shot timer `delayMs` from `issuedAtMs`.
   *
   * `issuedAtMs` is the `ctx.now` of the call that produced the command, never
   * "now" — a game that asks for a 30 s turn timer must get 30 s from the
   * instant its action was stamped, not 30 s from whenever the service got
   * round to it. That is the whole reason `TimerCommand.delayMs` is relative.
   *
   * A timer armed while a hold covers it is created **stopped with its full
   * budget** and starts when the hold lifts. A turn timer set during a host
   * pause must not count down through the pause and hand the game a timeout for
   * a turn nobody was allowed to take.
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
    this.#drainDue(issuedAtMs)
    const existing = this.#records.get(timerId)

    if (existing !== undefined && options.replace === false && !existing.expired) {
      return existing
    }

    this.#records.set(
      timerId,
      existing === undefined
        ? createTimerRecord({
            timerId,
            seatId: options.seatId ?? null,
            kind: options.kind ?? this.#specs?.get(timerId)?.kind ?? 'custom',
            durationMs: options.delayMs,
            startedAtMs: issuedAtMs,
          })
        : resetRecord(existing, options.delayMs, issuedAtMs),
    )
    // A re-arm replaces the timer the reducer paused, so its own hold is stale.
    // Room and seat scopes are not the reducer's to drop and stay in force.
    this.#heldTimers.delete(timerId)
    this.#reconcile(issuedAtMs)
    this.#afterMutation(issuedAtMs)
    return this.#records.get(timerId) as TimerRecord
  }

  clear(timerId: TimerId): void {
    this.#heldTimers.delete(timerId)
    if (this.#records.delete(timerId)) this.#rearm()
  }

  /**
   * A game's explicit `pause`. Takes the `timer` scope, so the matching `resume`
   * is what lifts it and a *different* scope — a disconnect, a host pause —
   * still keeps the clock stopped afterwards.
   *
   * Scoped to a timer that exists: a pause for an id the match has never seen
   * is a no-op rather than a hold left lying in wait for a future `set`.
   */
  pause(timerId: TimerId, atMs?: number): void {
    const nowMs = atMs ?? this.#clock.now()
    this.#drainDue(nowMs)
    if (!this.#records.has(timerId)) return
    this.#heldTimers.add(timerId)
    this.#reconcile(nowMs)
    this.#afterMutation(nowMs)
  }

  resume(timerId: TimerId, atMs?: number): void {
    const nowMs = atMs ?? this.#clock.now()
    this.#drainDue(nowMs)
    if (!this.#records.has(timerId)) return
    this.#heldTimers.delete(timerId)
    this.#reconcile(nowMs)
    this.#afterMutation(nowMs)
  }

  /**
   * Moves the game state: `toSeatId` is now the seat to move. Ends the outgoing
   * seat's turn (crediting increment and any Bronstein refund) and starts the
   * incoming seat's clock **if nothing is holding it**. Passing null just ends
   * the turn — the match is over, or a phase without a mover has begun.
   *
   * This is the only correct way to hand the move over: doing it as a separate
   * `pause` then `resume` loses the increment.
   *
   * The outgoing seat is the one `#onMoveSeatId` names, **not** whichever clock
   * happens to be running. Inferring it from `isRunning` silently forfeits the
   * increment of a seat whose clock was held (host pause, opponent's turn
   * arriving during a drop), and starts the incoming seat's clock straight
   * through a room pause.
   */
  switchTurnTo(toSeatId: SeatId | null, atMs?: number): void {
    const nowMs = atMs ?? this.#clock.now()
    this.#drainDue(nowMs)
    const fromSeatId = this.#onMoveSeatId
    if (fromSeatId !== null && fromSeatId !== toSeatId) {
      for (const [id, record] of this.#records) {
        if (record.kind !== 'chess-clock' || record.seatId !== fromSeatId) continue
        this.#records.set(id, endTurnRecord(record, nowMs))
      }
    }
    this.#onMoveSeatId = toSeatId
    this.#reconcile(nowMs)
    this.#afterMutation(nowMs)
  }

  /**
   * Marks one seat absent. Every timer belonging to it stops, unless the
   * manifest declared `pausesOnDisconnect: false`. A timer with no spec is
   * treated as pausing — the safe default is the one that cannot take time off
   * a player who is not there.
   *
   * The hold is on the **seat**, for as long as the seat is away. That covers
   * the clock of a seat that was not on move when it dropped: when the opponent
   * then moves, `switchTurnTo` finds the seat held and leaves the clock stopped.
   * A per-record stamp cannot do this, and the resulting game turns on which
   * millisecond a socket closed relative to a move — which is the opposite of
   * server-authoritative.
   */
  pauseForSeat(seatId: SeatId, atMs?: number): void {
    const nowMs = atMs ?? this.#clock.now()
    this.#drainDue(nowMs)
    this.#heldSeats.add(seatId)
    this.#reconcile(nowMs)
    this.#afterMutation(nowMs)
  }

  /**
   * Marks the seat present again. Its timers resume only if the game state
   * still wants them running and no other scope covers them — a clock whose
   * seat is not to move stays stopped, and one the host also paused stays
   * stopped until the host unpauses too.
   */
  resumeForSeat(seatId: SeatId, atMs?: number): void {
    const nowMs = atMs ?? this.#clock.now()
    this.#drainDue(nowMs)
    this.#heldSeats.delete(seatId)
    this.#reconcile(nowMs)
    this.#afterMutation(nowMs)
  }

  /**
   * Freezes the whole room — a host pause, or a room waiting on a rematch vote.
   * The hold is on the room, so a turn switch or a newly armed timer inside the
   * pause is covered by it too, and `resumeAll` puts the room back exactly
   * where the game state says it should be rather than starting every clock.
   */
  pauseAll(atMs?: number): void {
    const nowMs = atMs ?? this.#clock.now()
    this.#drainDue(nowMs)
    this.#roomHeld = true
    this.#reconcile(nowMs)
    this.#afterMutation(nowMs)
  }

  resumeAll(atMs?: number): void {
    const nowMs = atMs ?? this.#clock.now()
    this.#drainDue(nowMs)
    this.#roomHeld = false
    this.#reconcile(nowMs)
    this.#afterMutation(nowMs)
  }

  /**
   * Executes the timer commands a game returned. `issuedAtMs` must be the
   * `ctx.now` the game saw.
   */
  apply(commands: readonly TimerCommand[], issuedAtMs: number): void {
    this.#drainDue(issuedAtMs)
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
   *
   * `atMs` overrides the instant "now" is taken at. Replay passes the reducer's
   * `ctx.now` so a replayed expiry gets the same `firedAtMs`/`latenessMs` as the
   * live one did; live callers omit it and get the wall clock.
   *
   * One pass per call, by design — a handler that arms another already-due timer
   * is picked up on the next call rather than recursing. Drain it in a loop.
   */
  poll(atMs?: number): readonly TimerExpiry[] {
    if (this.#disposed || this.#firing) return []
    const firedAtMs = atMs ?? this.#clock.now()

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

  /**
   * JSON-safe state for Redis. Anchors stay absolute so a restart can resume.
   *
   * `version: 2` carries the game state and the hold scopes alongside the
   * records, because neither can be reconstructed from the records alone: a
   * room pause is invisible on a timer that was not running when it started.
   * `restore` still reads `version: 1`, so the deploy that introduces this does
   * not strand a live match.
   */
  snapshot(atMs?: number): TimerSnapshot {
    return {
      version: 2,
      matchId: this.matchId,
      savedAtMs: atMs ?? this.#clock.now(),
      onMoveSeatId: this.#onMoveSeatId,
      roomHeld: this.#roomHeld,
      heldSeats: [...this.#heldSeats],
      heldTimers: [...this.#heldTimers],
      // `holds` is copied out of its readonly array: the snapshot is the
      // JSON-bound shape, and nothing downstream should share an array with a
      // live record.
      timers: this.list().map((record) => ({
        ...record,
        clock: record.clock,
        holds: [...record.holds],
      })),
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

  /**
   * Does the scope named by `hold` cover this record?
   *
   * The one place each scope says what it owns. A `switch` and not a chain of
   * `if`s so that adding a `TimerHold` fails to compile until it says what it
   * covers, rather than silently covering nothing.
   */
  #scopeCovers(hold: TimerHold, record: TimerRecord): boolean {
    switch (hold) {
      case 'room':
        return this.#roomHeld
      case 'seat-disconnect':
        return (
          record.seatId !== null &&
          this.#heldSeats.has(record.seatId) &&
          // The manifest's opt-out. Absent spec means "pauses": the safe
          // default cannot take time off a player who is not there.
          this.#specs?.get(record.timerId)?.pausesOnDisconnect !== false
        )
      case 'timer':
        return this.#heldTimers.has(record.timerId)
    }
  }

  /**
   * Which hold scopes cover this record right now, in `TIMER_HOLD_ORDER` so
   * that two snapshots of the same state compare equal.
   *
   * An expired record is never held. A flag-fall is terminal, so leaving a
   * scope on it would mean a later `resumeAll` trying to revive a dead clock.
   */
  #holdsFor(record: TimerRecord): readonly TimerHold[] {
    if (record.expired) return NO_HOLDS
    const holds = TIMER_HOLD_ORDER.filter((hold) => this.#scopeCovers(hold, record))
    return holds.length === 0 ? NO_HOLDS : holds
  }

  /**
   * Does the *game state* want this timer counting down, holds aside?
   *
   * A `chess-clock` runs only for the seat to move — that is what makes it a
   * chess clock, and no hold and no resume may override it. Everything else is
   * a one-shot: it was armed by `set` and it runs until it fires or is cleared.
   */
  #isWanted(record: TimerRecord): boolean {
    if (record.expired) return false
    if (record.kind !== 'chess-clock') return true
    return record.seatId !== null && record.seatId === this.#onMoveSeatId
  }

  /**
   * Brings every record back in line with the game state and the hold scopes.
   *
   * This is the single place that decides whether a timer runs, and every
   * mutator ends in it. Runnable iff the game state wants it and no scope
   * covers it; a record that should be running and is not gets anchored at
   * `nowMs`, one that should not be and is gets frozen there. Idempotent — a
   * pass that changes nothing bumps no versions.
   */
  #reconcile(nowMs: number): void {
    for (const [id, record] of this.#records) {
      const holds = this.#holdsFor(record)
      let next = withHolds(record, holds)
      const shouldRun = holds.length === 0 && this.#isWanted(next)
      if (shouldRun) {
        if (!isRunning(next)) next = startRecord(next, nowMs)
      } else if (isRunning(next)) {
        next = pauseRecord(next, nowMs)
      }
      if (next !== record) this.#records.set(id, next)
    }
  }

  /**
   * Delivers every expiry already due at `nowMs` *before* a mutation gets to
   * observe the records, and again after it.
   *
   * This is the determinism fix. Live, the scheduler polls first, so a flag that
   * fell at +10 s is delivered before the move that lands at +12 s. In replay
   * nothing polls: the runner drives a fixed clock straight from the match log,
   * so without this the same seed and the same inputs end in a flag-fall live
   * and in a position on replay. Rather than leave that as a contract the
   * service cannot enforce, every mutator drains here and the invariant
   * becomes: **once a mutator has returned, no record sits at
   * `remainingMs === 0` without its `TimerExpiry` having been accounted for.**
   *
   * ## The bound on that invariant
   *
   * "Accounted for" and not "delivered", because of `MAX_DRAIN_PASSES`. Each
   * pass is one `poll`, and an `onExpire` handler may legitimately arm the next
   * timer; a handler that arms an *already-due* one every single time would
   * loop forever. After 32 passes the drain stops looping and force-expires
   * whatever is still due **without calling `onExpire`**, reporting it through
   * `onDrainExhausted`.
   *
   * It is not "leave the remainder to the scheduler": in replay there is no
   * scheduler, so that escape hatch does not exist on the one path this
   * invariant was introduced for, and the record would sit at zero un-expired,
   * invisible to `deadlineMsAt`, never reported. Dropping an event loudly beats
   * a clock the game can never learn about.
   *
   * A no-op while firing — we are already inside a pass, and a handler that
   * mutates must not re-enter one.
   */
  #drainDue(nowMs: number): void {
    if (this.#disposed || this.#firing) return
    for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
      if (this.poll(nowMs).length === 0) return
    }
    this.#forceExpireDue(nowMs)
  }

  /** The `MAX_DRAIN_PASSES` escape hatch. See `#drainDue`. */
  #forceExpireDue(nowMs: number): void {
    const dropped: TimerExpiry[] = []
    for (const record of [...this.#records.values()]) {
      const dueAtMs = deadlineMsAt(record)
      if (dueAtMs === null || dueAtMs - FIRE_TOLERANCE_MS > nowMs) continue
      this.#records.set(record.timerId, expireRecord(record))
      dropped.push({
        timerId: record.timerId,
        seatId: record.seatId,
        kind: record.kind,
        dueAtMs,
        firedAtMs: nowMs,
        latenessMs: nowMs - dueAtMs,
      })
    }
    if (dropped.length === 0) return
    dropped.sort((a, b) => a.dueAtMs - b.dueAtMs)
    this.#onDrainExhausted(dropped)
    this.#rearm()
  }

  /**
   * After any change that can move a deadline into the past — `switchTurnTo`
   * onto a seat that already flagged, a `set` with `delayMs: 0` — fire first,
   * then re-arm. Otherwise a zero-length timer would wait for the next
   * unrelated event to be noticed.
   *
   * `nowMs` is the mutation's instant, not the wall clock. Passing the wall
   * clock here would measure `latenessMs` against it and break `poll`'s own
   * promise that a replayed expiry gets the same `firedAtMs`/`latenessMs` as
   * the live one — on the exact path that promise was written for.
   */
  #afterMutation(nowMs?: number): void {
    this.#drainDue(nowMs ?? this.#clock.now())
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
   *
   * ## Caveat for the room runner: `onExpire` fires before `restore` returns
   *
   * A flag may well have fallen while we were dead, and surfacing it on the next
   * unrelated event would be wrong — so `restore` runs an expiry pass before it
   * hands the service back. An `onExpire` passed in `options` therefore runs
   * while `restore` is still on the stack, at which point **the caller has no
   * service reference yet** and cannot call `sync()` or `nextDeadlineMs()` from
   * that handler.
   *
   * The runner's options are to queue the expiry and process it after `restore`
   * returns, or to restore with no `onExpire` and drain `poll()` itself
   * immediately afterwards. The second is the shape the M1.6 runner uses.
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

    // Game state and hold scopes before records, so the reconciliation pass at
    // the bottom has something to reconcile against.
    const scopes: TimerScopes =
      parsed.version === 2
        ? {
            onMoveSeatId: parsed.onMoveSeatId as SeatId | null,
            roomHeld: parsed.roomHeld,
            heldSeats: new Set(parsed.heldSeats),
            heldTimers: new Set(parsed.heldTimers),
          }
        : readV1Scopes(parsed)
    service.#onMoveSeatId = scopes.onMoveSeatId
    service.#roomHeld = scopes.roomHeld
    service.#heldSeats = scopes.heldSeats
    service.#heldTimers = scopes.heldTimers

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
      //
      // The `isRunning` guard is load-bearing. On a stopped record `pauseRecord`
      // is a no-op and the `resumeRecord` behind it would *start* the timer, so
      // without the guard a planned drain — which is the deploy path — un-pauses
      // every paused clock in every live room. A stopped timer has nothing to
      // re-anchor: its budget is already committed and absolute.
      const reanchor = !chargeDowntime && isRunning(record)
      service.#records.set(
        timer.timerId,
        reanchor ? resumeRecord(pauseRecord(record, parsed.savedAtMs), nowMs) : record,
      )
    }

    service.#reconcile(nowMs)
    // A flag may well have fallen while we were dead; surface it immediately
    // rather than on the next unrelated event.
    service.#afterMutation(nowMs)
    return service
  }
}

/** Canonical empty holds, shared so `withHolds` can compare by identity fast. */
const NO_HOLDS: readonly TimerHold[] = []

/**
 * Recovers the hold scopes and the seat to move from a pre-scope snapshot.
 *
 * A v1 snapshot only knows which records were stamped, so this reads the scopes
 * back out of the stamps. It recovers exactly what the old build could express
 * and no more — which is the correct reading, because a hold the old build
 * never took is a hold that was not in force.
 *
 * `onMoveSeatId` is the seat whose clock was running, or, if the room was
 * frozen at the time, the frozen clock that carried a hold. That second case is
 * the only thing a v1 snapshot can say about a paused room, and it is right:
 * under the old model a stopped-and-held chess clock was the mover's.
 */
function readV1Scopes(parsed: Extract<AnyTimerSnapshot, { version: 1 }>): TimerScopes {
  const scopes: TimerScopes = {
    onMoveSeatId: null,
    roomHeld: false,
    heldSeats: new Set<string>(),
    heldTimers: new Set<string>(),
  }
  let heldMover: string | null = null
  for (const timer of parsed.timers) {
    if (timer.holds.includes('room')) scopes.roomHeld = true
    if (timer.holds.includes('seat-disconnect') && timer.seatId !== null) {
      scopes.heldSeats.add(timer.seatId)
    }
    if (timer.holds.includes('timer')) scopes.heldTimers.add(timer.timerId)

    if (timer.kind !== 'chess-clock' || timer.seatId === null || timer.expired) continue
    if (timer.startedAtMs !== null) scopes.onMoveSeatId = timer.seatId as SeatId
    else if (heldMover === null && timer.holds.length > 0) heldMover = timer.seatId
  }
  if (scopes.onMoveSeatId === null) scopes.onMoveSeatId = heldMover as SeatId | null
  return scopes
}

interface TimerScopes {
  onMoveSeatId: SeatId | null
  roomHeld: boolean
  heldSeats: Set<string>
  heldTimers: Set<string>
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
