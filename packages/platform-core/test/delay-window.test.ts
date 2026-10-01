/**
 * "Reached zero" means the **budget** was spent, not that wall time passed.
 *
 * A `simple`-delay clock separates the two: the first `delayRemainingMs` of a
 * turn is free, so inside the delay window raw elapsed time is positive while
 * the budget has not been touched. A zero-budget clock inside its delay is the
 * one state where `remainingMsAt(now) === 0` does *not* mean the deadline has
 * passed — `deadlineMsAt` is `startedAtMs + delayRemainingMs`, still ahead.
 * Everywhere else the two are equivalent, which is why the expiry drain catches
 * everything else before these guards are reached.
 *
 * Both guards that turn "remaining is zero" into a flag-fall therefore read
 * `chargeableElapsedMs`:
 *
 *   - `TimerService.#reconcile`, on the entry point that skipped the drain —
 *     a mutator called from inside an `onExpire` handler, where `#drainDue`
 *     no-ops because the service is already firing.
 *   - `endTurnRecord`, which must credit the increment for a turn that spent
 *     nothing rather than flag the seat that played it.
 *
 * Reading raw elapsed there flags a player up to `delayMs` early, terminally
 * (`expireRecord` clears the holds, so no later `resumeAll` revives it), and
 * without ever delivering a `TimerExpiry` — the game is never told.
 *
 * Origin: CTO review pass 6 of PR #17, finding F2, [PER-224](/PER/issues/PER-224).
 */
import { type TimerSpec, asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { type MutableClock, fixedClock } from '../src/runtime.js'
import {
  type TimerRecord,
  chargeableElapsedMs,
  endTurnRecord,
  rawElapsedMs,
} from '../src/timers/record.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { type TimerExpiry, TimerService } from '../src/timers/service.js'

const MATCH = asMatchId('m1')
const WHITE = asSeatId('white')
const BLACK = asSeatId('black')
const WHITE_CLOCK = asTimerId('clock:white')
const BLACK_CLOCK = asTimerId('clock:black')
const TURN = asTimerId('turn')

const SPECS: readonly TimerSpec[] = [
  { id: 'turn', kind: 'turn', description: 'move deadline', pausesOnDisconnect: true },
  { id: 'clock:white', kind: 'chess-clock', description: 'white', pausesOnDisconnect: true },
  { id: 'clock:black', kind: 'chess-clock', description: 'black', pausesOnDisconnect: true },
]

const T0 = 1_000_000

/** A record the test expects to exist; a missing one is a test bug, not a failure. */
function recordOf(service: TimerService, timerId: typeof WHITE_CLOCK): TimerRecord {
  const record = service.get(timerId)
  if (record === undefined) throw new Error(`no record for ${timerId}`)
  return record
}

interface Harness {
  readonly clock: MutableClock
  readonly service: TimerService
  readonly expiries: TimerExpiry[]
}

/**
 * A chess clock in the one shape that separates raw from charged elapsed: no
 * budget left, five seconds of per-turn delay. `set(id, { delayMs: 0 })` on a
 * declared clock and an increment-only time control both reach it legitimately.
 */
function zeroBudgetWithDelay(
  onExpire?: (service: TimerService, expiry: TimerExpiry) => void,
): Harness {
  const clock = fixedClock(T0)
  const expiries: TimerExpiry[] = []
  // The handler needs the service the handler is being installed on, so the
  // reference arrives one tick after construction.
  const box: { service?: TimerService } = {}
  const service = new TimerService({
    matchId: MATCH,
    clock,
    scheduler: createManualScheduler(),
    specs: SPECS,
    onExpire: (expiry) => {
      expiries.push(expiry)
      if (box.service !== undefined) onExpire?.(box.service, expiry)
    },
  })
  box.service = service
  for (const [id, seat] of [
    [WHITE_CLOCK, WHITE],
    [BLACK_CLOCK, BLACK],
  ] as const) {
    service.declarePlayerClock(id, seat, {
      initialMs: 0,
      incrementMs: 2_000,
      delayMs: 5_000,
      delayMode: 'simple',
    })
  }
  return { clock, service, expiries }
}

describe('the two elapsed quantities are different numbers inside a simple delay', () => {
  it('raw counts the delay window and chargeable does not', () => {
    const { service, clock } = zeroBudgetWithDelay()
    service.switchTurnTo(WHITE)
    clock.advance(1_000)

    const record = recordOf(service, WHITE_CLOCK)
    expect(rawElapsedMs(record, service.now)).toBe(1_000)
    expect(chargeableElapsedMs(record, service.now)).toBe(0)
  })
})

describe('#reconcile must not flag a clock whose budget it did not spend', () => {
  /**
   * The live path: `#drainDue` no-ops while `#firing`, so a mutator called from
   * inside an `onExpire` handler reaches `#reconcile` on undrained records.
   * That is the entry point the guard exists for.
   */
  it('a host pause from inside an expiry handler leaves the delay window intact', () => {
    const { service, clock, expiries } = zeroBudgetWithDelay((live) => {
      live.pauseAll()
    })
    service.switchTurnTo(WHITE)
    // White's deadline is T0 + 5_000: the budget is zero but the delay is not.
    service.set(TURN, { delayMs: 1_000, issuedAtMs: T0 })

    clock.advance(1_000)
    const fired = service.poll()

    expect(fired.map((e) => e.timerId)).toEqual([TURN])
    const white = recordOf(service, WHITE_CLOCK)
    expect(white.expired).toBe(false)
    expect(white.remainingMs).toBe(0)
    expect(white.delayRemainingMs).toBe(4_000)
    expect(expiries.map((e) => e.timerId)).toEqual([TURN])
  })

  it('and the clock still flags when the delay finally runs out', () => {
    const { service, clock, expiries } = zeroBudgetWithDelay((live) => {
      if (live.isRunning(WHITE_CLOCK)) live.pauseAll()
    })
    service.switchTurnTo(WHITE)
    service.set(TURN, { delayMs: 1_000, issuedAtMs: T0 })

    clock.advance(1_000)
    service.poll()
    // The host resumes 9 s later. White owes the 4 s of delay it had left, so
    // the flag falls at resume + 4_000 — not at the pause, and not never.
    clock.advance(9_000)
    service.resumeAll()
    expect(service.nextDeadlineMs()).toBe(T0 + 10_000 + 4_000)

    clock.advance(4_000)
    service.poll()
    expect(service.get(WHITE_CLOCK)?.expired).toBe(true)
    expect(expiries.map((e) => e.timerId)).toEqual([TURN, WHITE_CLOCK])
  })

  /**
   * The control. The guard must still close on a record whose budget genuinely
   * ran out — `chargedMs > 0` is a discriminator, not an off switch.
   */
  it('still flags a clock that did spend its budget before the mutation', () => {
    const clock = fixedClock(T0)
    const expiries: TimerExpiry[] = []
    const box: { service?: TimerService } = {}
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: SPECS,
      onExpire: (expiry) => {
        expiries.push(expiry)
        // A replayed mutator carries the reducer's `ctx.now`, which can be past
        // the handler's own instant. The drain is still suppressed, so this is
        // `#reconcile` seeing a genuinely exhausted clock.
        if (expiry.timerId === TURN) box.service?.pauseAll(T0 + 3_000)
      },
    })
    box.service = service
    service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 1_000, incrementMs: 2_000 })
    service.switchTurnTo(WHITE)
    service.set(TURN, { delayMs: 500, issuedAtMs: T0 })

    clock.advance(500)
    service.poll()

    expect(recordOf(service, WHITE_CLOCK).expired).toBe(true)
    expect(recordOf(service, WHITE_CLOCK).remainingMs).toBe(0)
    expect(expiries.map((e) => e.timerId)).toEqual([TURN])
  })
})

describe('endTurnRecord credits a turn that spent nothing', () => {
  it('switchTurnTo inside the delay window pays the increment instead of flagging', () => {
    const { service, clock } = zeroBudgetWithDelay()
    service.switchTurnTo(WHITE)
    clock.advance(1_000)

    service.switchTurnTo(BLACK)

    const white = recordOf(service, WHITE_CLOCK)
    expect(white.expired).toBe(false)
    // FIDE order: the budget was untouched, so the increment lands in full.
    expect(white.remainingMs).toBe(2_000)
    expect(service.isRunning(BLACK_CLOCK)).toBe(true)
  })

  it('but a turn that exhausted the budget still flags', () => {
    const clock = fixedClock(T0)
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: SPECS,
    })
    service.declarePlayerClock(WHITE_CLOCK, WHITE, {
      initialMs: 1_000,
      incrementMs: 2_000,
      delayMs: 5_000,
      delayMode: 'simple',
    })
    service.declarePlayerClock(BLACK_CLOCK, BLACK, { initialMs: 1_000, incrementMs: 2_000 })
    service.switchTurnTo(WHITE)

    // 5 s of free delay, then the whole 1 s budget.
    clock.advance(6_000)
    expect(endTurnRecord(recordOf(service, WHITE_CLOCK), service.now).expired).toBe(true)
  })

  it('is unaffected under delayMode none, where raw and charged agree', () => {
    const clock = fixedClock(T0)
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: SPECS,
    })
    service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 1_000, incrementMs: 2_000 })
    service.declarePlayerClock(BLACK_CLOCK, BLACK, { initialMs: 1_000, incrementMs: 2_000 })
    service.switchTurnTo(WHITE)

    clock.advance(1_000)
    expect(endTurnRecord(recordOf(service, WHITE_CLOCK), service.now).expired).toBe(true)
  })
})
