/**
 * A hold is a property of a scope — the room, the seat, the timer id — not a
 * stamp on whichever records happened to be running when the pause ran.
 *
 * Five invariants from the second review pass, all faces of the same defect:
 *
 *   A. A room-wide pause covers a timer created *during* it.
 *   B. A disconnected seat's clock is not started by the opponent's move.
 *   C. `switchTurnTo` ends the outgoing seat's turn — and credits its
 *      increment — whether or not that clock was running.
 *   D. An expiry drained from inside a mutation is measured at the mutation
 *      instant, not the wall clock, so a replay reproduces `latenessMs`.
 *   E. The drain cap cannot silently leave a record at zero un-expired.
 *
 * Origin: CTO review pass 2 of PR #17, [PER-76](/PER/issues/PER-76).
 */
import { type TimerSpec, asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { type MutableClock, fixedClock } from '../src/runtime.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { TimerService } from '../src/timers/service.js'

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

function chess(startMs = 1_000_000): { clock: MutableClock; service: TimerService } {
  const clock = fixedClock(startMs)
  const service = new TimerService({
    matchId: MATCH,
    clock,
    scheduler: createManualScheduler(),
    specs: SPECS,
  })
  service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 300_000, incrementMs: 2_000 })
  service.declarePlayerClock(BLACK_CLOCK, BLACK, { initialMs: 300_000, incrementMs: 2_000 })
  return { clock, service }
}

describe('A — a room-wide pause must cover the timer that starts during it', () => {
  it('switchTurnTo during a host pause does not start the incoming seat', () => {
    const { clock, service } = chess()
    service.switchTurnTo(WHITE)
    clock.advance(5_000)

    service.pauseAll() // host pause: nothing may run
    expect(service.isRunning(WHITE_CLOCK)).toBe(false)
    expect(service.isRunning(BLACK_CLOCK)).toBe(false)

    // A move lands (queued action, rematch vote resolution, replay of the log).
    service.switchTurnTo(BLACK)

    expect(service.isRunning(BLACK_CLOCK)).toBe(false)

    clock.advance(30_000)
    expect(service.remainingMs(BLACK_CLOCK)).toBe(300_000)
  })

  it('a turn timer armed during a host pause does not count down through it', () => {
    const clock = fixedClock(1_000_000)
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: SPECS,
    })
    service.pauseAll()
    service.set(TURN, { delayMs: 30_000 })

    expect(service.isRunning(TURN)).toBe(false)
    clock.advance(30_000)
    expect(service.remainingMs(TURN)).toBe(30_000)
  })
})

describe('B — a disconnected seat must not have its clock started by the opponent', () => {
  it('switchTurnTo onto a seat that is away leaves that clock stopped', () => {
    const { clock, service } = chess()
    service.switchTurnTo(WHITE)

    // Black drops while it is White's move: nothing to freeze.
    service.pauseForSeat(BLACK)
    clock.advance(5_000)

    // White moves. Black is still gone.
    service.switchTurnTo(BLACK)

    expect(service.isRunning(BLACK_CLOCK)).toBe(false)
    clock.advance(30_000)
    expect(service.remainingMs(BLACK_CLOCK)).toBe(300_000)

    // Black returns and the clock starts from there.
    service.resumeForSeat(BLACK)
    expect(service.isRunning(BLACK_CLOCK)).toBe(true)
  })
})

describe('C — switchTurnTo must not lose the increment on a held clock', () => {
  it('the outgoing seat still gets its increment when the room is paused', () => {
    const { clock, service } = chess()
    service.switchTurnTo(WHITE)
    clock.advance(5_000)
    service.pauseAll()
    service.switchTurnTo(BLACK)
    service.resumeAll()

    // 300s - 5s spent + 2s increment.
    expect(service.remainingMs(WHITE_CLOCK)).toBe(297_000)
  })
})

describe('D — poll() fired from a mutation must use the mutation instant', () => {
  it('latenessMs is measured against the issued instant, not the wall clock', () => {
    const clock = fixedClock(1_000_000)
    const fired: number[] = []
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: SPECS,
      onExpire: (e) => fired.push(e.latenessMs),
    })
    // A reducer stamped at ctx.now = 1_000_000 arms a zero-length timer, but the
    // service's wall clock has already moved on by 8 s.
    clock.advance(8_000)
    service.apply(
      [{ op: 'set', timerId: TURN, seatId: null, delayMs: 0, replace: true }],
      1_000_000,
    )

    expect(fired).toEqual([0])
  })
})

describe('E — the drain cap must not silently violate the stated invariant', () => {
  it('a spent budget is never left un-expired after a mutator returns', () => {
    const clock = fixedClock(1_000_000)
    let rearm = 0
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      onExpire: () => {
        // A pathological handler: re-arms the same timer, already due, every pass.
        rearm += 1
        if (rearm < 100) service.set(TURN, { delayMs: 0, replace: true, issuedAtMs: clock.now() })
      },
    })
    service.set(TURN, { delayMs: 0, issuedAtMs: clock.now() })
    // After the mutator returns, either the timer is expired or the invariant in
    // #drainDue's docstring is false.
    const record = service.get(TURN)
    expect(record === undefined || record.expired || record.remainingMs > 0).toBe(true)
  })
})
