/**
 * The nesting matrix for hold scopes.
 *
 * `holds.test.ts` covers one scope at a time. This file covers the overlaps,
 * because that is where the second review found the defect: a hold stamped onto
 * a record at the instant a pause ran cannot cover a timer that was not running
 * then, nor one created afterwards. So for room-hold and seat-hold, in both
 * orders, we take a turn switch and a `set` *inside* the hold and check that
 * neither escapes it — and that lifting the scopes in either order lands on the
 * state the game state alone dictates.
 *
 * Plus the deploy path: a `version: 1` snapshot, written before the scopes
 * existed, has to come back as the right scopes.
 */
import { type TimerSpec, asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { type MutableClock, fixedClock } from '../src/runtime.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { TimerService, restoreTimerService } from '../src/timers/service.js'

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

/** Whatever Redis gives back is JSON, not our objects. */
const throughRedis = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown

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

describe('room hold then seat hold', () => {
  it('keeps the seat stopped after the room lifts, in either lift order', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(3_000)

    h.service.pauseAll()
    h.service.pauseForSeat(WHITE)
    expect(h.service.get(WHITE_CLOCK)?.holds).toEqual(['room', 'seat-disconnect'])

    h.clock.advance(60_000)
    h.service.resumeAll()
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(false)
    expect(h.service.get(WHITE_CLOCK)?.holds).toEqual(['seat-disconnect'])

    h.service.resumeForSeat(WHITE)
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(true)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(297_000)
  })

  it('does not start the incoming seat when the turn switches inside both holds', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(3_000)

    h.service.pauseAll()
    h.service.pauseForSeat(BLACK) // Black drops during the host pause
    h.service.switchTurnTo(BLACK)

    expect(h.service.isRunning(BLACK_CLOCK)).toBe(false)
    // White still gets the increment for the move it completed.
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(299_000)

    h.service.resumeAll()
    expect(h.service.isRunning(BLACK_CLOCK)).toBe(false) // Black is still away
    h.service.resumeForSeat(BLACK)
    expect(h.service.isRunning(BLACK_CLOCK)).toBe(true)
    expect(h.service.remainingMs(BLACK_CLOCK)).toBe(300_000)
  })

  it('arms a `set` inside both holds stopped, and starts it only when both lift', () => {
    const h = chess()
    h.service.pauseAll()
    h.service.pauseForSeat(WHITE)
    h.service.set(TURN, { seatId: WHITE, delayMs: 30_000 })

    expect(h.service.isRunning(TURN)).toBe(false)
    expect(h.service.get(TURN)?.holds).toEqual(['room', 'seat-disconnect'])

    h.clock.advance(120_000)
    h.service.resumeForSeat(WHITE)
    expect(h.service.isRunning(TURN)).toBe(false)

    h.service.resumeAll()
    expect(h.service.isRunning(TURN)).toBe(true)
    // The full budget: none of the pause was ever charged.
    expect(h.service.remainingMs(TURN)).toBe(30_000)
  })
})

describe('seat hold then room hold', () => {
  it('reaches the same state as the other order', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(3_000)

    h.service.pauseForSeat(WHITE)
    h.service.pauseAll()
    expect(h.service.get(WHITE_CLOCK)?.holds).toEqual(['room', 'seat-disconnect'])

    h.clock.advance(60_000)
    h.service.resumeForSeat(WHITE)
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(false)

    h.service.resumeAll()
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(true)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(297_000)
  })

  it('covers a reducer’s own pause as a third, independent scope', () => {
    const h = chess()
    h.service.set(TURN, { delayMs: 30_000 })
    h.service.pause(TURN)
    h.service.pauseAll()
    expect(h.service.get(TURN)?.holds).toEqual(['room', 'timer'])

    h.clock.advance(10_000)
    h.service.resumeAll()
    expect(h.service.isRunning(TURN)).toBe(false)

    h.service.resume(TURN)
    expect(h.service.isRunning(TURN)).toBe(true)
    expect(h.service.remainingMs(TURN)).toBe(30_000)
  })

  it('ignores a reducer pause for a timer the match has never seen', () => {
    const h = chess()
    h.service.pause(TURN)
    h.service.resume(TURN)
    h.service.set(TURN, { delayMs: 30_000 })
    // The stale pause did not lie in wait for the timer to appear.
    expect(h.service.isRunning(TURN)).toBe(true)
  })

  it('leaves a `pausesOnDisconnect: false` timer outside the seat scope', () => {
    const specs: readonly TimerSpec[] = [
      { id: 'turn', kind: 'turn', description: 'move deadline', pausesOnDisconnect: false },
    ]
    const clock = fixedClock(1_000_000)
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs,
    })
    service.pauseForSeat(WHITE)
    service.set(TURN, { seatId: WHITE, delayMs: 30_000 })

    // Armed inside the disconnect, and the manifest says it does not care.
    expect(service.isRunning(TURN)).toBe(true)
    clock.advance(10_000)
    expect(service.remainingMs(TURN)).toBe(20_000)
  })
})

describe('the game state outranks every scope', () => {
  it('never runs a clock for a seat that is not to move, however the holds move', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.service.pauseAll()
    h.service.pauseForSeat(BLACK)
    h.service.resumeForSeat(BLACK)
    h.service.resumeAll()
    h.service.resume(BLACK_CLOCK)

    expect(h.service.isRunning(BLACK_CLOCK)).toBe(false)
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(true)
    expect(h.service.onMoveSeatId).toBe(WHITE)
  })

  it('never holds an expired clock, so no later resume can revive it', () => {
    const clock = fixedClock(1_000_000)
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: SPECS,
    })
    service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 10_000 })
    service.switchTurnTo(WHITE)
    clock.advance(11_000)
    service.poll()

    service.pauseAll()
    expect(service.isHeld(WHITE_CLOCK)).toBe(false)
    service.resumeAll()
    expect(service.isRunning(WHITE_CLOCK)).toBe(false)
    expect(service.remainingMs(WHITE_CLOCK)).toBe(0)
  })
})

describe('the scopes survive Redis', () => {
  it('round-trips a room hold, a seat hold and the seat to move', () => {
    const h = chess()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(4_000)
    h.service.pauseAll()
    h.service.pauseForSeat(BLACK)
    h.service.set(TURN, { delayMs: 30_000 })
    h.service.pause(TURN)

    const snapshot = h.service.snapshot() as { version: number }
    expect(snapshot.version).toBe(2)

    const restored = restoreTimerService(throughRedis(snapshot), {
      clock: fixedClock(h.clock.now() + 90_000),
      scheduler: createManualScheduler(),
      specs: SPECS,
    })

    expect(restored.onMoveSeatId).toBe(WHITE)
    expect(restored.get(WHITE_CLOCK)?.holds).toEqual(['room'])
    expect(restored.get(BLACK_CLOCK)?.holds).toEqual(['room', 'seat-disconnect'])
    expect(restored.get(TURN)?.holds).toEqual(['room', 'timer'])

    restored.resumeAll()
    restored.resume(TURN)
    expect(restored.isRunning(WHITE_CLOCK)).toBe(true)
    expect(restored.isRunning(TURN)).toBe(true)
    expect(restored.isRunning(BLACK_CLOCK)).toBe(false)
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(296_000)
  })

  it('recovers the scopes from a version 1 snapshot of a host-paused room', () => {
    // What the previous build wrote: holds stamped on the records, no scopes.
    const restored = restoreTimerService(
      {
        version: 1,
        matchId: 'm1',
        savedAtMs: 1_000_000,
        timers: [
          v1Record({
            timerId: 'clock:white',
            seatId: 'white',
            kind: 'chess-clock',
            remainingMs: 295_000,
            holds: ['room'],
          }),
          v1Record({ timerId: 'clock:black', seatId: 'black', kind: 'chess-clock' }),
        ],
      },
      {
        clock: fixedClock(1_060_000),
        scheduler: createManualScheduler(),
        specs: SPECS,
      },
    )

    // The frozen-and-held chess clock is the only thing a v1 snapshot can say
    // about who was on move under a room pause, and it says it correctly.
    expect(restored.onMoveSeatId).toBe(WHITE)
    expect(restored.isRunning(WHITE_CLOCK)).toBe(false)
    expect(restored.get(WHITE_CLOCK)?.holds).toEqual(['room'])

    restored.resumeAll()
    expect(restored.isRunning(WHITE_CLOCK)).toBe(true)
    expect(restored.isRunning(BLACK_CLOCK)).toBe(false)
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(295_000)
  })

  it('recovers a seat hold and a reducer hold from a version 1 snapshot', () => {
    const restored = restoreTimerService(
      {
        version: 1,
        matchId: 'm1',
        savedAtMs: 1_000_000,
        timers: [
          v1Record({
            timerId: 'clock:white',
            seatId: 'white',
            kind: 'chess-clock',
            remainingMs: 290_000,
            startedAtMs: 1_000_000,
          }),
          v1Record({
            timerId: 'clock:black',
            seatId: 'black',
            kind: 'chess-clock',
            holds: ['seat-disconnect'],
          }),
          v1Record({ timerId: 'turn', seatId: null, kind: 'turn', holds: ['timer'] }),
        ],
      },
      { clock: fixedClock(1_010_000), scheduler: createManualScheduler(), specs: SPECS },
    )

    expect(restored.onMoveSeatId).toBe(WHITE)
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(280_000)

    // Black's disconnect survives the deploy: the opponent's move must not
    // start their clock on the far side of it either.
    restored.switchTurnTo(BLACK)
    expect(restored.isRunning(BLACK_CLOCK)).toBe(false)
    restored.resumeForSeat(BLACK)
    expect(restored.isRunning(BLACK_CLOCK)).toBe(true)

    expect(restored.isHeld(TURN)).toBe(true)
    restored.resume(TURN)
    expect(restored.isRunning(TURN)).toBe(true)
  })

  // The v1 read path must fail closed rather than guess. Pass 3 found the
  // guess: v1 stamped a hold on any record that was running *or already held*,
  // so more than one clock could carry one, and "first held clock wins" resolved
  // to declaration order. Each case below is a shape v1 could actually emit
  // where the mover is not recoverable; `null` is the only safe answer, and the
  // runner re-asserts `switchTurnTo` from game state after `restore` anyway.
  it('reads no seat to move when two version 1 clocks are held by room alone', () => {
    const restored = restoreTimerService(
      {
        version: 1,
        matchId: 'm1',
        savedAtMs: 1_000_000,
        timers: [
          v1Record({
            timerId: 'clock:white',
            seatId: 'white',
            kind: 'chess-clock',
            holds: ['room'],
          }),
          v1Record({
            timerId: 'clock:black',
            seatId: 'black',
            kind: 'chess-clock',
            holds: ['room'],
          }),
        ],
      },
      { clock: fixedClock(1_010_000), scheduler: createManualScheduler(), specs: SPECS },
    )

    expect(restored.onMoveSeatId).toBeNull()
    // And no clock burns on the strength of a guess, before or after the unpause.
    restored.resumeAll()
    expect(restored.isRunning(WHITE_CLOCK)).toBe(false)
    expect(restored.isRunning(BLACK_CLOCK)).toBe(false)
  })

  it('reads no seat to move when a version 1 snapshot had two clocks running', () => {
    // v1's `resumeForSeat` started the clock of the seat that was not to move
    // (pass-1 BLOCKING 1), so a v1 snapshot can genuinely show two running
    // clocks. The state is already corrupt; picking one of them charges a victim.
    const restored = restoreTimerService(
      {
        version: 1,
        matchId: 'm1',
        savedAtMs: 1_000_000,
        timers: [
          v1Record({
            timerId: 'clock:white',
            seatId: 'white',
            kind: 'chess-clock',
            startedAtMs: 1_000_000,
          }),
          v1Record({
            timerId: 'clock:black',
            seatId: 'black',
            kind: 'chess-clock',
            startedAtMs: 1_000_000,
          }),
        ],
      },
      { clock: fixedClock(1_010_000), scheduler: createManualScheduler(), specs: SPECS },
    )

    expect(restored.onMoveSeatId).toBeNull()
    expect(restored.isRunning(WHITE_CLOCK)).toBe(false)
    expect(restored.isRunning(BLACK_CLOCK)).toBe(false)
  })

  it('recovers fully once the runner re-asserts the seat to move', () => {
    // The contract `restore`'s docstring states, on the worst v1 shape: an
    // ambiguous snapshot costs nothing, because the game module is the authority
    // for whose turn it is and the runner replays it.
    const restored = restoreTimerService(
      {
        version: 1,
        matchId: 'm1',
        savedAtMs: 1_000_000,
        timers: [
          v1Record({
            timerId: 'clock:white',
            seatId: 'white',
            kind: 'chess-clock',
            remainingMs: 290_000,
            holds: ['room'],
          }),
          v1Record({
            timerId: 'clock:black',
            seatId: 'black',
            kind: 'chess-clock',
            remainingMs: 295_000,
            holds: ['seat-disconnect', 'room'],
          }),
        ],
      },
      { clock: fixedClock(1_010_000), scheduler: createManualScheduler(), specs: SPECS },
    )

    // White alone carries `['room']`, so this one *is* recoverable.
    expect(restored.onMoveSeatId).toBe(WHITE)
    // Re-asserting the same seat is idempotent: no increment, no clock movement.
    restored.switchTurnTo(WHITE)
    expect(restored.remainingMs(WHITE_CLOCK)).toBe(290_000)

    restored.resumeAll()
    expect(restored.isRunning(WHITE_CLOCK)).toBe(true)
    // Black stays stopped on both counts: not to move, and still disconnected.
    expect(restored.isRunning(BLACK_CLOCK)).toBe(false)
    restored.resumeForSeat(BLACK)
    expect(restored.isRunning(BLACK_CLOCK)).toBe(false)
  })

  it('reads no seat to move from a version 1 snapshot that had none', () => {
    const restored = restoreTimerService(
      {
        version: 1,
        matchId: 'm1',
        savedAtMs: 1_000_000,
        timers: [
          v1Record({ timerId: 'clock:white', seatId: 'white', kind: 'chess-clock' }),
          v1Record({
            timerId: 'clock:black',
            seatId: 'black',
            kind: 'chess-clock',
            expired: true,
            remainingMs: 0,
          }),
        ],
      },
      { clock: fixedClock(1_010_000), scheduler: createManualScheduler(), specs: SPECS },
    )

    expect(restored.onMoveSeatId).toBeNull()
    expect(restored.isRunning(WHITE_CLOCK)).toBe(false)
  })
})

function v1Record(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    timerId: 'turn',
    seatId: null,
    kind: 'turn',
    remainingMs: 300_000,
    startedAtMs: null,
    delayRemainingMs: 0,
    turnElapsedMs: 0,
    clock: null,
    expired: false,
    version: 3,
    ...overrides,
  }
}
