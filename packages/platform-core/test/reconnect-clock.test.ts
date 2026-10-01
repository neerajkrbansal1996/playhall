/**
 * Reconnect and restart must not start a clock the game state says is stopped.
 *
 * Four invariants, each one a defect the first review pass found. They share a
 * root cause: a pause used to record nothing about *what it froze*, so a resume
 * started anything merely stopped — and "is this timer running" was being read
 * as the answer to "is this seat to move".
 *
 *   1. A reconnect starts only the timers that seat's disconnect actually froze.
 *   2. A drained restart (`chargeDowntime: false`) re-anchors running clocks and
 *      leaves paused ones paused. This is the deploy path: getting it wrong
 *      un-pauses every paused clock in every live room.
 *   3. The client renders a `simple`-delay clock the way the server computes it.
 *      The deadline has the unspent delay baked in, so the client has to take it
 *      back out or every clock reads ~`delayMs` too high for the first seconds
 *      of every turn.
 *   4. A flag-fall is never swallowed by a turn switch. Live the scheduler polls
 *      first; in replay nothing does, so the same seed and inputs would end in a
 *      flag-fall live and a position on replay.
 *
 * Origin: CTO review of PR #17, [PER-59](/PER/issues/PER-59) and the fix issue
 * [PER-70](/PER/issues/PER-70).
 */
import { type TimerSpec, asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { type MutableClock, fixedClock } from '../src/runtime.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { TimerService, restoreTimerService } from '../src/timers/service.js'
import { TimerSyncTracker } from '../src/timers/sync.js'

const MATCH = asMatchId('m1')
const WHITE = asSeatId('white')
const BLACK = asSeatId('black')
const WHITE_CLOCK = asTimerId('clock:white')
const BLACK_CLOCK = asTimerId('clock:black')
const TURN = asTimerId('turn')

const SPECS: readonly TimerSpec[] = [
  { id: 'turn', kind: 'turn', description: 'move deadline', pausesOnDisconnect: false },
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

describe('BLOCKING 1 — reconnect must not start the clock of a seat that is not to move', () => {
  it('Black reconnecting while White is to move leaves Black stopped', () => {
    const { clock, service } = chess()
    service.switchTurnTo(WHITE) // White on move, Black's clock paused

    expect(service.isRunning(BLACK_CLOCK)).toBe(false)

    service.pauseForSeat(BLACK) // Black drops
    clock.advance(10_000)
    service.resumeForSeat(BLACK) // Black comes back — still White's move

    expect(service.isRunning(BLACK_CLOCK)).toBe(false)

    clock.advance(30_000)
    expect(service.remainingMs(BLACK_CLOCK)).toBe(300_000)
    expect(service.remainingMs(WHITE_CLOCK)).toBe(300_000 - 40_000)
  })
})

describe('BLOCKING 2 — a drained restart must not start clocks that were paused', () => {
  it('restore(chargeDowntime: false) leaves the non-mover stopped', () => {
    const { clock, service } = chess()
    service.switchTurnTo(WHITE)
    clock.advance(20_000)
    const snapshot = JSON.parse(JSON.stringify(service.snapshot())) as unknown

    const restored = restoreTimerService(snapshot, {
      clock: fixedClock(clock.now() + 45_000),
      scheduler: createManualScheduler(),
      specs: SPECS,
      chargeDowntime: false,
    })

    expect(restored.isRunning(WHITE_CLOCK)).toBe(true)
    expect(restored.isRunning(BLACK_CLOCK)).toBe(false)
  })

  it('restore(chargeDowntime: false) does not un-pause a host-paused room', () => {
    const clock = fixedClock(1_000_000)
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
    })
    service.set(TURN, { delayMs: 30_000 })
    clock.advance(5_000)
    service.pauseAll() // host pause
    const snapshot = JSON.parse(JSON.stringify(service.snapshot())) as unknown

    const restored = restoreTimerService(snapshot, {
      clock: fixedClock(clock.now() + 60_000),
      scheduler: createManualScheduler(),
      chargeDowntime: false,
    })

    expect(restored.isRunning(TURN)).toBe(false)
  })
})

describe('BLOCKING 3 — the client must render a simple-delay clock like the server', () => {
  it('tracker.views() agrees with service.remainingMs() during the delay window', () => {
    const clock = fixedClock(1_000_000)
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: SPECS,
    })
    service.declarePlayerClock(WHITE_CLOCK, WHITE, {
      initialMs: 300_000,
      delayMs: 3_000,
      delayMode: 'simple',
    })
    service.switchTurnTo(WHITE)
    clock.advance(1_000) // 2 s of delay still unspent

    // Zero-latency, zero-offset client so only the formula is under test.
    const tracker = new TimerSyncTracker({ clock: fixedClock(clock.now()) })
    tracker.applySync(service.sync(), {
      requestedAtMs: clock.now(),
      receivedAtMs: clock.now(),
    })

    expect(tracker.remainingMs(WHITE_CLOCK)).toBe(service.remainingMs(WHITE_CLOCK))
  })
})

describe('CONTRACT — a flag-fall must not be swallowed by the turn switch', () => {
  it('switching away from a seat whose budget is gone still reports an expiry', () => {
    const clock = fixedClock(1_000_000)
    const expiries: string[] = []
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: SPECS,
      onExpire: (e) => expiries.push(e.timerId),
    })
    service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 10_000, incrementMs: 2_000 })
    service.declarePlayerClock(BLACK_CLOCK, BLACK, { initialMs: 10_000, incrementMs: 2_000 })
    service.switchTurnTo(WHITE)

    // White's flag falls at +10 s; White's own move lands at +12 s, after the
    // flag, without poll() having run. This is the replay path.
    clock.advance(12_000)
    service.switchTurnTo(BLACK)

    expect(service.remainingMs(WHITE_CLOCK)).toBe(0)
    expect(service.get(WHITE_CLOCK)?.expired).toBe(true)
    expect(expiries).toContain(WHITE_CLOCK)
  })
})
