/**
 * The paused/running state machine.
 *
 * Every disconnect and restart test in `service.test.ts` and `restart.test.ts`
 * exercises the seat that *was* on move. The far more common case is the seat
 * that was **not**, and getting it wrong runs both chess clocks at once and
 * silently decides games, so this file covers that side and the overlaps around
 * it: two holds at once, a hold that outlives a resume, a hold that survives a
 * restart, and the drain that stops a flag-fall from being swallowed.
 *
 * The rule under test throughout: a pause takes a hold only on a timer it
 * actually froze (or that is already held), and a resume lifts only its own
 * hold. A timer stopped because the *game state* says so is never held, so
 * nothing can resume it except the game state changing back.
 */
import { type TimerSpec, asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { type ManualClock, createManualClock } from '../src/timers/clock.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { type TimerExpiry, TimerService, restoreTimerService } from '../src/timers/service.js'

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

/** Whatever Redis gives back is JSON, not our objects. */
const throughRedis = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown

interface Harness {
  clock: ManualClock
  service: TimerService
  expiries: TimerExpiry[]
}

function chess(options: { initialMs?: number; startMs?: number } = {}): Harness {
  const clock = createManualClock(options.startMs ?? 1_000_000)
  const expiries: TimerExpiry[] = []
  const service = new TimerService({
    matchId: MATCH,
    clock,
    scheduler: createManualScheduler(),
    specs: SPECS,
    onExpire: (expiry) => expiries.push(expiry),
  })
  const initialMs = options.initialMs ?? 300_000
  service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs, incrementMs: 2_000 })
  service.declarePlayerClock(BLACK_CLOCK, BLACK, { initialMs, incrementMs: 2_000 })
  return { clock, service, expiries }
}

describe('a pause holds only what it froze', () => {
  it('does not hold the non-mover, so their reconnect cannot start their clock', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)

    h.service.pauseForSeat(BLACK)
    expect(h.service.isHeld(BLACK_CLOCK)).toBe(false)

    h.clock.advance(10_000)
    h.service.resumeForSeat(BLACK)
    expect(h.service.isRunning(BLACK_CLOCK)).toBe(false)
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(true)
  })

  it('holds the mover, and their reconnect gives the time back', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(5_000)

    h.service.pauseForSeat(WHITE)
    expect(h.service.isHeld(WHITE_CLOCK)).toBe(true)
    h.clock.advance(120_000) // a two-minute tunnel

    h.service.resumeForSeat(WHITE)
    expect(h.service.isHeld(WHITE_CLOCK)).toBe(false)
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(true)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(295_000)
  })

  it('does not credit an increment for a turn the reconnecting seat never took', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)

    h.service.pauseForSeat(BLACK)
    h.clock.advance(10_000)
    h.service.resumeForSeat(BLACK)

    // If Black's clock had been started by the reconnect, this switch would call
    // endTurn on it and hand Black +2 s for a move they did not make.
    h.clock.advance(30_000)
    h.service.switchTurnTo(BLACK)
    expect(h.service.remainingMs(BLACK_CLOCK)).toBe(300_000)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(300_000 - 40_000 + 2_000)
  })

  it('leaves the whole room where it was after a host pause and unpause', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(4_000)

    h.service.pauseAll()
    expect(h.service.nextDeadlineMs()).toBeNull()
    h.clock.advance(600_000)
    h.service.resumeAll()

    expect(h.service.isRunning(WHITE_CLOCK)).toBe(true)
    expect(h.service.isRunning(BLACK_CLOCK)).toBe(false)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(296_000)
    expect(h.service.remainingMs(BLACK_CLOCK)).toBe(300_000)
  })
})

describe('overlapping holds nest', () => {
  it('keeps a disconnected seat stopped when the host unpauses the room', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(3_000)

    h.service.pauseAll() // host pauses; White's clock is frozen with a `room` hold
    h.service.pauseForSeat(WHITE) // White also drops while the room is paused
    h.clock.advance(60_000)

    h.service.resumeAll() // host unpauses, but White is still not there
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(false)
    expect(h.service.isHeld(WHITE_CLOCK)).toBe(true)

    h.clock.advance(60_000)
    h.service.resumeForSeat(WHITE) // White comes back
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(true)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(297_000)
  })

  it('does not let a game’s resume command override a disconnect hold', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(1_000)

    h.service.pauseForSeat(WHITE)
    h.service.resume(WHITE_CLOCK) // a reducer asking for the clock back
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(false)

    h.service.resumeForSeat(WHITE)
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(true)
  })

  it('treats a repeated pause as the first one', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(2_000)

    h.service.pauseForSeat(WHITE)
    h.clock.advance(5_000)
    h.service.pauseForSeat(WHITE) // a duplicate disconnect event
    h.clock.advance(5_000)

    h.service.resumeForSeat(WHITE)
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(true)
    // Only the 2 s before the first pause was ever charged.
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(298_000)
  })

  it('ignores a resume for a hold that was never taken', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.service.resumeForSeat(BLACK)
    h.service.resumeAll()
    h.service.resume(BLACK_CLOCK)
    expect(h.service.isRunning(BLACK_CLOCK)).toBe(false)
  })

  it('drops holds when the game re-arms the timer, so a stale pause cannot strand it', () => {
    const clock = createManualClock(1_000_000)
    const service = new TimerService({ matchId: MATCH, clock, scheduler: createManualScheduler() })
    service.set(TURN, { delayMs: 30_000 })
    service.pause(TURN)
    expect(service.isHeld(TURN)).toBe(true)

    service.set(TURN, { delayMs: 30_000 })
    expect(service.isHeld(TURN)).toBe(false)
    expect(service.isRunning(TURN)).toBe(true)
  })
})

describe('a restart lands on the state the room was actually in', () => {
  it('does not start the non-mover’s clock on a drained restart', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(20_000)
    const snapshot = throughRedis(h.service.snapshot())

    const restored = restoreTimerService(snapshot, {
      clock: createManualClock(h.clock.now() + 45_000),
      scheduler: createManualScheduler(),
      specs: SPECS,
      chargeDowntime: false,
    })

    expect(restored.isRunning(WHITE_CLOCK)).toBe(true)
    expect(restored.isRunning(BLACK_CLOCK)).toBe(false)
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(280_000)
    expect(restored.remainingMs(BLACK_CLOCK)).toBe(300_000)
  })

  it('carries a host pause through a drained restart', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(5_000)
    h.service.pauseAll()
    const snapshot = throughRedis(h.service.snapshot())

    const restored = restoreTimerService(snapshot, {
      clock: createManualClock(h.clock.now() + 60_000),
      scheduler: createManualScheduler(),
      specs: SPECS,
      chargeDowntime: false,
    })

    expect(restored.isRunning(WHITE_CLOCK)).toBe(false)
    expect(restored.isHeld(WHITE_CLOCK)).toBe(true)

    // And the hold still lifts on the other side of the restart.
    restored.resumeAll()
    expect(restored.isRunning(WHITE_CLOCK)).toBe(true)
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(295_000)
  })

  it('carries a disconnect hold through a crash restart', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(5_000)
    h.service.pauseForSeat(WHITE)
    const snapshot = throughRedis(h.service.snapshot())

    const restored = restoreTimerService(snapshot, {
      clock: createManualClock(h.clock.now() + 600_000),
      scheduler: createManualScheduler(),
      specs: SPECS,
    })

    expect(restored.isHeld(WHITE_CLOCK)).toBe(true)
    restored.resumeForSeat(WHITE)
    expect(restored.isRunning(WHITE_CLOCK)).toBe(true)
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(295_000)
  })

  it('restores a snapshot written before holds existed', () => {
    // The deploy that introduces `holds` must not break a live match, so the
    // field is optional on the way in and an absent one means unheld.
    const restored = restoreTimerService(
      {
        version: 1,
        matchId: 'm1',
        savedAtMs: 1_000_000,
        timers: [
          {
            timerId: 'turn',
            seatId: null,
            kind: 'turn',
            remainingMs: 30_000,
            startedAtMs: 1_000_000,
            delayRemainingMs: 0,
            turnElapsedMs: 0,
            clock: null,
            expired: false,
            version: 3,
          },
        ],
      },
      { clock: createManualClock(1_005_000), scheduler: createManualScheduler() },
    )

    expect(restored.get(TURN)?.holds).toEqual([])
    expect(restored.isRunning(TURN)).toBe(true)
    expect(restored.remainingMs(TURN)).toBe(25_000)
  })
})

describe('a flag-fall is never swallowed by the mutation that stepped over it', () => {
  it('delivers the expiry when the turn switches away after the flag fell', () => {
    const h = chess({ initialMs: 10_000 })
    h.service.switchTurnTo(WHITE)

    // Replay: the log says White moved at +12 s, and nothing polled in between.
    h.clock.advance(12_000)
    h.service.switchTurnTo(BLACK)

    expect(h.service.get(WHITE_CLOCK)?.expired).toBe(true)
    expect(h.expiries.map((expiry) => expiry.timerId)).toEqual([WHITE_CLOCK])
    // Charged against the instant it was due, not the instant we noticed.
    expect(h.expiries[0]?.dueAtMs).toBe(1_010_000)
    // No increment for the move that flagged.
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(0)
  })

  it('replays to the same clocks as the live run did', () => {
    // Live: the scheduler polls at the deadline, then the move arrives late.
    const live = chess({ initialMs: 10_000 })
    live.service.switchTurnTo(WHITE)
    live.clock.advance(10_000)
    live.service.poll()
    live.clock.advance(2_000)
    live.service.switchTurnTo(BLACK)

    // Replay: the same inputs off the match log, with no poll at all.
    const replay = chess({ initialMs: 10_000 })
    replay.service.switchTurnTo(WHITE)
    replay.clock.advance(12_000)
    replay.service.switchTurnTo(BLACK)

    expect(replay.expiries.map((e) => e.timerId)).toEqual(live.expiries.map((e) => e.timerId))
    expect(replay.service.get(WHITE_CLOCK)?.expired).toBe(live.service.get(WHITE_CLOCK)?.expired)
    expect(replay.service.remainingMs(BLACK_CLOCK)).toBe(live.service.remainingMs(BLACK_CLOCK))
    expect(replay.service.isRunning(BLACK_CLOCK)).toBe(live.service.isRunning(BLACK_CLOCK))
  })

  it('delivers the expiry when a disconnect steps over the deadline', () => {
    const h = chess({ initialMs: 10_000 })
    h.service.switchTurnTo(WHITE)
    h.clock.advance(15_000)

    h.service.pauseForSeat(WHITE)
    expect(h.expiries.map((expiry) => expiry.timerId)).toEqual([WHITE_CLOCK])
    // An expired clock is terminal, so the disconnect took no hold on it.
    expect(h.service.isHeld(WHITE_CLOCK)).toBe(false)
  })

  it('delivers the expiry when a game command steps over the deadline', () => {
    const clock = createManualClock(1_000_000)
    const expiries: TimerExpiry[] = []
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      onExpire: (expiry) => expiries.push(expiry),
    })
    service.set(TURN, { delayMs: 30_000 })
    clock.advance(40_000)

    service.apply([], clock.now())
    expect(expiries.map((expiry) => expiry.timerId)).toEqual([TURN])
  })

  it('never leaves a chess clock at zero without having reported it', () => {
    // The invariant, walked over a whole game's worth of switches with no poll
    // anywhere and a step that does not divide the budget — so the flag falls
    // *between* two switches rather than on one.
    const clock = createManualClock(1_000_000)
    const expiries: TimerExpiry[] = []
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: SPECS,
      onExpire: (expiry) => expiries.push(expiry),
    })
    for (const [timerId, seatId] of [
      [WHITE_CLOCK, WHITE],
      [BLACK_CLOCK, BLACK],
    ] as const) {
      service.declarePlayerClock(timerId, seatId, { initialMs: 10_000 })
    }

    const seats = [WHITE, BLACK] as const
    service.switchTurnTo(WHITE)
    for (let move = 0; move < 20; move += 1) {
      clock.advance(1_700)
      service.switchTurnTo(seats[(move + 1) % 2] as typeof WHITE)
      for (const timerId of [WHITE_CLOCK, BLACK_CLOCK]) {
        const record = service.get(timerId)
        if (record !== undefined && record.remainingMs === 0) {
          expect(record.expired).toBe(true)
          expect(expiries.map((expiry) => expiry.timerId)).toContain(timerId)
        }
      }
    }

    // Both players had 10 s and 20 moves of 1.7 s were played, so somebody
    // flagged — otherwise this asserts nothing.
    expect(expiries.length).toBeGreaterThan(0)
  })
})
