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
import { fixedClock } from '../src/runtime.js'
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
  const clock = fixedClock(startMs)
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
    const restartedClock = fixedClock(live.clock.now() + 8_000)
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
      clock: fixedClock(live.clock.now() + 45_000),
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

    const restartedClock = fixedClock(live.clock.now())
    const restored = restoreTimerService(snapshot, {
      clock: restartedClock,
      scheduler: createManualScheduler(),
    })

    restored.switchTurnTo(BLACK)
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(292_000) // 290 + 2 increment
    expect(restored.isRunning(BLACK_CLOCK)).toBe(true)
  })

  it('preserves an unspent simple delay across a restart', () => {
    const clock = fixedClock(1_700_000_000_000)
    const service = new TimerService({ matchId: MATCH, clock, scheduler: createManualScheduler() })
    service.declarePlayerClock(WHITE_CLOCK, WHITE, {
      initialMs: 60_000,
      delayMs: 5_000,
      delayMode: 'simple',
    })
    service.switchTurnTo(WHITE)
    clock.advance(2_000) // 2 s of the 5 s delay spent

    const restored = restoreTimerService(throughRedis(service.snapshot()), {
      clock: fixedClock(clock.now()),
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
      clock: fixedClock(live.clock.now() + 600_000),
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
      clock: fixedClock(live.clock.now() + 360_000),
      scheduler: createManualScheduler(),
      onExpire: (expiry) => expiries.push(expiry.timerId),
    })

    expect(expiries).toEqual([WHITE_CLOCK])
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(0)
  })

  it('round-trips a plain one-shot timer', () => {
    const clock = fixedClock(1_700_000_000_000)
    const service = new TimerService({ matchId: MATCH, clock, scheduler: createManualScheduler() })
    service.set(TURN, { seatId: WHITE, delayMs: 30_000, kind: 'turn' })
    clock.advance(5_000)

    const restored = restoreTimerService(throughRedis(service.snapshot()), {
      clock: fixedClock(clock.now()),
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
        clock: fixedClock(live.clock.now() - 5_000),
        scheduler: createManualScheduler(),
      }),
    ).toThrow(/stepped backwards/)
  })

  it('rejects a blob whose shape has drifted', () => {
    expect(() =>
      restoreTimerService(
        { version: 1, matchId: 'm1' },
        { clock: fixedClock(0), scheduler: createManualScheduler() },
      ),
    ).toThrow()
    expect(() =>
      restoreTimerService(
        { version: 2, matchId: 'm1', savedAtMs: 0, timers: [] },
        { clock: fixedClock(0), scheduler: createManualScheduler() },
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
        { clock: fixedClock(1_000), scheduler: createManualScheduler() },
      ),
    ).toThrow()
  })

  it('accepts an empty match', () => {
    const restored = restoreTimerService(
      { version: 1, matchId: 'm1', savedAtMs: 0, timers: [] },
      { clock: fixedClock(1_000), scheduler: createManualScheduler() },
    )
    expect(restored.list()).toHaveLength(0)
    expect(restored.nextDeadlineMs()).toBeNull()
  })
})

/**
 * The invariant these guard is the one `endTurnRecord` states and
 * `docs/timers.md` promises: **a record can never reach `remainingMs === 0`
 * without a `TimerExpiry` having been delivered.** Every live mutator keeps it
 * by draining at the mutation instant before it touches anything; `restore`
 * used to reconcile first, which froze the flagged record at zero and made it
 * invisible to `deadlineMsAt` — so the drain behind it had no deadline left to
 * find and the expiry was lost for good.
 *
 * A planned drain is the deploy path and a crash is the common one, so this is
 * the single place a flag-fall is most likely to go missing in production.
 */
describe('a flag-fall during downtime survives the restart', () => {
  /**
   * A `chess-clock` record, anchored and running, with `n` ms left.
   *
   * These tests build the snapshot by hand rather than through `snapshot()`,
   * and that is the honest shape to test: the restore path parses untrusted
   * JSON out of Redis, and "a record is still anchored while the scopes say it
   * must not run" is schema-valid, is exactly what the pre-hold build wrote,
   * and is what `#reconcile` then froze at zero. A live service never *writes*
   * it, which is precisely why no test built through the live API caught this.
   */
  const runningClock = (
    timerId: string,
    seatId: string,
    remainingMs: number,
    anchorMs: number,
  ) => ({
    timerId,
    seatId,
    kind: 'chess-clock' as const,
    remainingMs,
    startedAtMs: anchorMs,
    delayRemainingMs: 0,
    turnElapsedMs: 0,
    clock: {
      initialMs: 300_000,
      incrementMs: 0,
      delayMs: 0,
      delayMode: 'none' as const,
      maxMs: null,
    },
    expired: false,
    holds: [] as string[],
    version: 4,
  })

  it('fires for a room the snapshot says was held', () => {
    const snapshot = {
      version: 2 as const,
      matchId: 'm1',
      savedAtMs: 1_000_000,
      onMoveSeatId: WHITE,
      roomHeld: true,
      heldSeats: [],
      heldTimers: [],
      timers: [runningClock(WHITE_CLOCK, WHITE, 1_000, 1_000_000)],
    }

    // 90 s of downtime against a clock with 1 s left.
    const fired: string[] = []
    const restored = restoreTimerService(throughRedis(snapshot), {
      clock: fixedClock(1_090_000),
      scheduler: createManualScheduler(),
      onExpire: (expiry) => fired.push(expiry.timerId),
    })

    expect(fired).toEqual([WHITE_CLOCK])
    expect(restored.get(WHITE_CLOCK)?.expired).toBe(true)
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(0)
    // Terminal: lifting the hold cannot revive a dead clock.
    restored.resumeAll()
    expect(restored.isRunning(WHITE_CLOCK)).toBe(false)
  })

  it('fires for a seat the snapshot says was absent', () => {
    const snapshot = {
      version: 2 as const,
      matchId: 'm1',
      savedAtMs: 1_000_000,
      onMoveSeatId: WHITE,
      roomHeld: false,
      heldSeats: [WHITE as string],
      heldTimers: [],
      timers: [runningClock(WHITE_CLOCK, WHITE, 1_000, 1_000_000)],
    }

    const fired: string[] = []
    restoreTimerService(throughRedis(snapshot), {
      clock: fixedClock(1_030_000),
      scheduler: createManualScheduler(),
      onExpire: (expiry) => fired.push(expiry.timerId),
    })

    expect(fired).toEqual([WHITE_CLOCK])
  })

  it('fires when the game state alone says the record must stop', () => {
    // No hold at all: the snapshot says Black is to move while White's clock is
    // the one still anchored. `#reconcile` stops White because `#onMoveSeatId`
    // says so, and that freeze is what used to swallow the expiry.
    const snapshot = {
      version: 2 as const,
      matchId: 'm1',
      savedAtMs: 1_000_000,
      onMoveSeatId: BLACK,
      roomHeld: false,
      heldSeats: [],
      heldTimers: [],
      timers: [runningClock(WHITE_CLOCK, WHITE, 1_000, 1_000_000)],
    }

    const fired: string[] = []
    restoreTimerService(throughRedis(snapshot), {
      clock: fixedClock(1_090_000),
      scheduler: createManualScheduler(),
      onExpire: (expiry) => fired.push(expiry.timerId),
    })

    expect(fired).toEqual([WHITE_CLOCK])
  })

  it('loses nothing when both clocks flag, including on the ambiguous v1 shape', () => {
    // Two running clocks is a shape only the pre-hold build could produce (its
    // `resumeForSeat` started the non-mover's clock), and `readV1Scopes`
    // refuses to name a mover from it. Refusing to guess must not also mean
    // losing both expiries: the budgets still ran out.
    const snapshot = {
      version: 1 as const,
      matchId: 'm1',
      savedAtMs: 1_000_000,
      timers: [
        {
          timerId: WHITE_CLOCK,
          seatId: WHITE,
          kind: 'chess-clock' as const,
          remainingMs: 500,
          startedAtMs: 1_000_000,
          delayRemainingMs: 0,
          turnElapsedMs: 0,
          clock: {
            initialMs: 1_000,
            incrementMs: 0,
            delayMs: 0,
            delayMode: 'none' as const,
            maxMs: null,
          },
          expired: false,
          version: 3,
        },
        {
          timerId: BLACK_CLOCK,
          seatId: BLACK,
          kind: 'chess-clock' as const,
          remainingMs: 800,
          startedAtMs: 1_000_000,
          delayRemainingMs: 0,
          turnElapsedMs: 0,
          clock: {
            initialMs: 1_000,
            incrementMs: 0,
            delayMs: 0,
            delayMode: 'none' as const,
            maxMs: null,
          },
          expired: false,
          version: 3,
        },
      ],
    }

    const fired: string[] = []
    const restored = restoreTimerService(throughRedis(snapshot), {
      clock: fixedClock(1_060_000),
      scheduler: createManualScheduler(),
      onExpire: (expiry) => fired.push(expiry.timerId),
    })

    // In deadline order: White had 500 ms, Black 800 ms.
    expect(fired).toEqual([WHITE_CLOCK, BLACK_CLOCK])
    expect(restored.get(WHITE_CLOCK)?.expired).toBe(true)
    expect(restored.get(BLACK_CLOCK)?.expired).toBe(true)
  })

  it('still leaves an un-flagged paused clock paused and unexpired', () => {
    // The guard against the fix over-reaching. A clock with budget left must
    // come back paused, not expired, and must not have been charged.
    const live = liveMatch()
    live.service.switchTurnTo(WHITE)
    live.clock.advance(10_000)
    live.service.pauseAll()
    const snapshot = throughRedis(live.service.snapshot())

    const fired: string[] = []
    const restored = restoreTimerService(snapshot, {
      clock: fixedClock(live.clock.now() + 90_000),
      scheduler: createManualScheduler(),
      onExpire: (expiry) => fired.push(expiry.timerId),
    })

    expect(fired).toEqual([])
    expect(restored.get(WHITE_CLOCK)?.expired).toBe(false)
    expect(restored.isRunning(WHITE_CLOCK)).toBe(false)
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(290_000)
  })
})

/**
 * `#reconcile`'s own guard, independent of the restore ordering. It is the
 * belt to the drain's braces, and it has to be scoped correctly: a *running*
 * record frozen at zero flagged, but a record merely *armed* with a zero
 * budget under a hold has never had the chance to run.
 */
describe('reconcile fails closed on a record frozen at zero', () => {
  it('does not expire a zero-budget timer armed while a hold covers it', () => {
    const live = liveMatch()
    live.service.pauseAll()
    live.service.set(TURN, { delayMs: 0 })

    expect(live.service.get(TURN)?.expired).toBe(false)
    expect(live.service.isRunning(TURN)).toBe(false)

    // It fires the moment the hold lifts, which is `set`'s stated contract.
    const fired: string[] = []
    const service = new TimerService({
      matchId: MATCH,
      clock: live.clock,
      scheduler: createManualScheduler(),
      onExpire: (expiry) => fired.push(expiry.timerId),
    })
    service.pauseAll()
    service.set(TURN, { delayMs: 0 })
    expect(fired).toEqual([])
    service.resumeAll()
    expect(fired).toEqual([TURN])
  })
})

describe('TimerService.restore', () => {
  it('is the same thing as the free function', () => {
    const snapshot = { version: 1, matchId: 'm1', savedAtMs: 0, timers: [] }
    const restored = TimerService.restore(snapshot, {
      clock: fixedClock(1_000),
      scheduler: createManualScheduler(),
    })
    expect(restored.matchId).toBe(MATCH)
  })
})
