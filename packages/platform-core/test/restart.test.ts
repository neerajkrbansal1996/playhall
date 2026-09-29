/**
 * Crash recovery: after a restart, does a live match resume with the correct
 * state *and the correct clocks*?
 *
 * The snapshot goes through `JSON.parse(JSON.stringify(...))` in every test
 * here, because that is what Redis does to it. A field that only survives
 * in-process is a field that does not survive a restart.
 */
import { asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { createManualClock } from '../src/timers/clock.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { TimerService, restoreTimerService } from '../src/timers/service.js'

const MATCH = asMatchId('m1')
const WHITE = asSeatId('white')
const BLACK = asSeatId('black')
const WHITE_CLOCK = asTimerId('clock:white')
const BLACK_CLOCK = asTimerId('clock:black')
const TURN = asTimerId('turn')

/** Whatever Redis gives back is JSON, not our objects. */
const throughRedis = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown

function liveMatch(startMs = 1_700_000_000_000) {
  const clock = createManualClock(startMs)
  const service = new TimerService({
    matchId: MATCH,
    clock,
    scheduler: createManualScheduler(),
  })
  service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 300_000, incrementMs: 2_000 })
  service.declarePlayerClock(BLACK_CLOCK, BLACK, { initialMs: 300_000, incrementMs: 2_000 })
  return { clock, service }
}

describe('snapshot / restore', () => {
  it('resumes a running clock with the downtime charged', () => {
    const live = liveMatch()
    live.service.switchTurnTo(WHITE)
    live.clock.advance(20_000)

    const snapshot = throughRedis(live.service.snapshot())

    // The process dies. A replacement comes up 8 s later.
    const restartedClock = createManualClock(live.clock.now() + 8_000)
    const restored = restoreTimerService(snapshot, {
      clock: restartedClock,
      scheduler: createManualScheduler(),
    })

    expect(restored.matchId).toBe(MATCH)
    expect(restored.isRunning(WHITE_CLOCK)).toBe(true)
    // 20 s of play plus 8 s of downtime: from White's point of view the clock
    // never stopped, because from their point of view it did not.
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(272_000)
    expect(restored.remainingMs(BLACK_CLOCK)).toBe(300_000)
    expect(restored.isRunning(BLACK_CLOCK)).toBe(false)
  })

  it('does not charge downtime for a drained restart', () => {
    const live = liveMatch()
    live.service.switchTurnTo(WHITE)
    live.clock.advance(20_000)
    const snapshot = throughRedis(live.service.snapshot())

    const restored = restoreTimerService(snapshot, {
      clock: createManualClock(live.clock.now() + 45_000),
      scheduler: createManualScheduler(),
      chargeDowntime: false,
    })

    expect(restored.remainingMs(WHITE_CLOCK)).toBe(280_000)
  })

  it('keeps the configuration, so the increment still lands after a restart', () => {
    const live = liveMatch()
    live.service.switchTurnTo(WHITE)
    live.clock.advance(10_000)
    const snapshot = throughRedis(live.service.snapshot())

    const restartedClock = createManualClock(live.clock.now())
    const restored = restoreTimerService(snapshot, {
      clock: restartedClock,
      scheduler: createManualScheduler(),
    })

    restored.switchTurnTo(BLACK)
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(292_000) // 290 + 2 increment
    expect(restored.isRunning(BLACK_CLOCK)).toBe(true)
  })

  it('preserves an unspent simple delay across a restart', () => {
    const clock = createManualClock(1_700_000_000_000)
    const service = new TimerService({ matchId: MATCH, clock, scheduler: createManualScheduler() })
    service.declarePlayerClock(WHITE_CLOCK, WHITE, {
      initialMs: 60_000,
      delayMs: 5_000,
      delayMode: 'simple',
    })
    service.switchTurnTo(WHITE)
    clock.advance(2_000) // 2 s of the 5 s delay spent

    const restored = restoreTimerService(throughRedis(service.snapshot()), {
      clock: createManualClock(clock.now()),
      scheduler: createManualScheduler(),
    })

    expect(restored.remainingMs(WHITE_CLOCK)).toBe(60_000)
    expect(restored.delayRemainingMs(WHITE_CLOCK)).toBe(3_000)
  })

  it('keeps a paused clock paused, and pauses stay free', () => {
    const live = liveMatch()
    live.service.switchTurnTo(WHITE)
    live.clock.advance(20_000)
    live.service.pauseForSeat(WHITE)
    const snapshot = throughRedis(live.service.snapshot())

    const restored = restoreTimerService(snapshot, {
      clock: createManualClock(live.clock.now() + 600_000),
      scheduler: createManualScheduler(),
    })

    expect(restored.isRunning(WHITE_CLOCK)).toBe(false)
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(280_000)
  })

  it('fires a flag that fell while the process was dead, immediately on restore', () => {
    const live = liveMatch()
    live.service.switchTurnTo(WHITE)
    live.clock.advance(20_000)
    const snapshot = throughRedis(live.service.snapshot())

    const expiries: string[] = []
    const restored = restoreTimerService(snapshot, {
      // Down for six minutes. White had 280 s left; they flagged 80 s ago.
      clock: createManualClock(live.clock.now() + 360_000),
      scheduler: createManualScheduler(),
      onExpire: (expiry) => expiries.push(expiry.timerId),
    })

    expect(expiries).toEqual([WHITE_CLOCK])
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(0)
  })

  it('round-trips a plain one-shot timer', () => {
    const clock = createManualClock(1_700_000_000_000)
    const service = new TimerService({ matchId: MATCH, clock, scheduler: createManualScheduler() })
    service.set(TURN, { seatId: WHITE, delayMs: 30_000, kind: 'turn' })
    clock.advance(5_000)

    const restored = restoreTimerService(throughRedis(service.snapshot()), {
      clock: createManualClock(clock.now()),
      scheduler: createManualScheduler(),
    })
    expect(restored.remainingMs(TURN)).toBe(25_000)
    expect(restored.get(TURN)?.seatId).toBe(WHITE)
    expect(restored.get(TURN)?.kind).toBe('turn')
  })
})

describe('restore refuses to guess', () => {
  it('rejects a snapshot stamped in the future rather than handing out free time', () => {
    const live = liveMatch()
    live.service.switchTurnTo(WHITE)
    live.clock.advance(20_000)
    const snapshot = throughRedis(live.service.snapshot())

    expect(() =>
      restoreTimerService(snapshot, {
        // The replacement host's wall clock is 5 s behind the dead one's.
        clock: createManualClock(live.clock.now() - 5_000),
        scheduler: createManualScheduler(),
      }),
    ).toThrow(/stepped backwards/)
  })

  it('rejects a blob whose shape has drifted', () => {
    expect(() =>
      restoreTimerService({ version: 1, matchId: 'm1' }, { scheduler: createManualScheduler() }),
    ).toThrow()
    expect(() =>
      restoreTimerService(
        { version: 2, matchId: 'm1', savedAtMs: 0, timers: [] },
        { scheduler: createManualScheduler() },
      ),
    ).toThrow()
  })

  it('rejects a timer with a negative budget', () => {
    expect(() =>
      restoreTimerService(
        {
          version: 1,
          matchId: 'm1',
          savedAtMs: 0,
          timers: [
            {
              timerId: 'turn',
              seatId: null,
              kind: 'turn',
              remainingMs: -1,
              startedAtMs: null,
              delayRemainingMs: 0,
              turnElapsedMs: 0,
              clock: null,
              expired: false,
              version: 1,
            },
          ],
        },
        { clock: createManualClock(1_000), scheduler: createManualScheduler() },
      ),
    ).toThrow()
  })

  it('accepts an empty match', () => {
    const restored = restoreTimerService(
      { version: 1, matchId: 'm1', savedAtMs: 0, timers: [] },
      { clock: createManualClock(1_000), scheduler: createManualScheduler() },
    )
    expect(restored.list()).toHaveLength(0)
    expect(restored.nextDeadlineMs()).toBeNull()
  })
})

describe('TimerService.restore', () => {
  it('is the same thing as the free function', () => {
    const snapshot = { version: 1, matchId: 'm1', savedAtMs: 0, timers: [] }
    const restored = TimerService.restore(snapshot, {
      clock: createManualClock(1_000),
      scheduler: createManualScheduler(),
    })
    expect(restored.matchId).toBe(MATCH)
  })
})
