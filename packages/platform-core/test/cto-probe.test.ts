/**
 * CTO review probe for PR #17 (PER-59).
 *
 * These tests assert the behaviour I believe is CORRECT, so a failure here is a
 * defect in the timer service, not in the probe. All four fail against 58848b5.
 * Drop into packages/platform-core/test/ and use as the regression suite.
 */
import { type TimerSpec, asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { type ManualClock, createManualClock } from '../src/timers/clock.js'
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

function chess(startMs = 1_000_000): { clock: ManualClock; service: TimerService } {
  const clock = createManualClock(startMs)
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
      clock: createManualClock(clock.now() + 45_000),
      scheduler: createManualScheduler(),
      specs: SPECS,
      chargeDowntime: false,
    })

    expect(restored.isRunning(WHITE_CLOCK)).toBe(true)
    expect(restored.isRunning(BLACK_CLOCK)).toBe(false)
  })

  it('restore(chargeDowntime: false) does not un-pause a host-paused room', () => {
    const clock = createManualClock(1_000_000)
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
      clock: createManualClock(clock.now() + 60_000),
      scheduler: createManualScheduler(),
      chargeDowntime: false,
    })

    expect(restored.isRunning(TURN)).toBe(false)
  })
})

describe('BLOCKING 3 — the client must render a simple-delay clock like the server', () => {
  it('tracker.views() agrees with service.remainingMs() during the delay window', () => {
    const clock = createManualClock(1_000_000)
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
    const tracker = new TimerSyncTracker({ clock: createManualClock(clock.now()) })
    tracker.applySync(service.sync(), {
      requestedAtMs: clock.now(),
      receivedAtMs: clock.now(),
    })

    expect(tracker.remainingMs(WHITE_CLOCK)).toBe(service.remainingMs(WHITE_CLOCK))
  })
})

describe('CONTRACT — a flag-fall must not be swallowed by the turn switch', () => {
  it('switching away from a seat whose budget is gone still reports an expiry', () => {
    const clock = createManualClock(1_000_000)
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
