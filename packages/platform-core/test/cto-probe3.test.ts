/**
 * CTO review-pass-3 probe for PR #17 at c8ca7ef (PER-96).
 *
 * Every test here asserts the behaviour I believe is CORRECT, so a failure is a
 * defect in the timer service, not in the probe. All five fail against c8ca7ef.
 */
import { type TimerSpec, asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { createManualClock } from '../src/timers/clock.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { type TimerExpiry, TimerService, restoreTimerService } from '../src/timers/service.js'

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

const CLOCK_CONFIG = {
  initialMs: 300_000,
  incrementMs: 0,
  delayMs: 0,
  delayMode: 'none' as const,
  maxMs: null,
}

/**
 * Not hand-authored. This is the literal output of `snapshot()` on the v1 build
 * (1c65083) driven through a sequence of v1 public calls:
 *
 *   declarePlayerClock(black); declarePlayerClock(white);
 *   switchTurnTo(black); +4s; pauseForSeat(black); +1s;
 *   switchTurnTo(white);  +3s; pauseAll();
 *
 * WHITE is the seat to move: v1's `switchTurnTo(white)` started white's clock,
 * and `pauseAll()` then froze it. Black's clock carries a hold only because it
 * was still held from its own disconnect when the room froze.
 *
 * Hand-authoring v1 blobs from a model of what v1 wrote is what let this
 * through: the three migration tests in `hold-scopes.test.ts` each have at most
 * one held chess clock, and v1 could produce two.
 */
const V1_TWO_HELD_CLOCKS = {
  version: 1,
  matchId: 'm1',
  savedAtMs: 1_008_000,
  timers: [
    {
      timerId: 'clock:black',
      seatId: 'black',
      kind: 'chess-clock',
      remainingMs: 296_000,
      startedAtMs: null,
      delayRemainingMs: 0,
      turnElapsedMs: 4_000,
      clock: CLOCK_CONFIG,
      expired: false,
      holds: ['seat-disconnect', 'room'],
      version: 5,
    },
    {
      timerId: 'clock:white',
      seatId: 'white',
      kind: 'chess-clock',
      remainingMs: 297_000,
      startedAtMs: null,
      delayRemainingMs: 0,
      turnElapsedMs: 3_000,
      clock: CLOCK_CONFIG,
      expired: false,
      holds: ['room'],
      version: 4,
    },
  ],
}

describe('the version:1 read path must not guess the seat to move', () => {
  it('reads the seat to move as the seat v1 actually had on move', () => {
    const restored = restoreTimerService(V1_TWO_HELD_CLOCKS, {
      clock: createManualClock(2_000_000),
      scheduler: createManualScheduler(),
      specs: SPECS,
    })
    // `null` is also acceptable here — failing closed is fine, guessing is not.
    expect(restored.onMoveSeatId).not.toBe(BLACK)
  })

  it('never starts the returning seat’s clock on the mover’s turn', () => {
    const restored = restoreTimerService(V1_TWO_HELD_CLOCKS, {
      clock: createManualClock(2_000_000),
      scheduler: createManualScheduler(),
      specs: SPECS,
    })
    restored.resumeAll() // host unpauses
    restored.resumeForSeat(BLACK) // black reconnects

    // Black is not to move. Black's clock must not burn, whatever the snapshot
    // could or could not say about white.
    expect(restored.isRunning(BLACK_CLOCK)).toBe(false)
  })
})

describe('the drain invariant must hold for every mutator, not most of them', () => {
  it('delivers an expiry that was already due when clear() is called', () => {
    const fired: TimerExpiry[] = []
    const clock = createManualClock(1_000_000)
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: SPECS,
      onExpire: (expiry) => fired.push(expiry),
    })
    service.set(TURN, { delayMs: 30_000, issuedAtMs: 1_000_000 })
    clock.advance(31_000)

    // Live, the scheduler already fired this at +30s. In replay nothing polls,
    // so `clear` swallows the timeout and the game never learns of it.
    service.clear(TURN)
    expect(fired.map((expiry) => expiry.timerId)).toEqual(['turn'])
  })

  it('delivers an expiry that was already due when declarePlayerClock is called', () => {
    const fired: TimerExpiry[] = []
    const clock = createManualClock(1_000_000)
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: SPECS,
      onExpire: (expiry) => fired.push(expiry),
    })
    service.set(TURN, { delayMs: 30_000, issuedAtMs: 1_000_000 })
    clock.advance(31_000)

    service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 300_000 })
    expect(fired.map((expiry) => expiry.timerId)).toEqual(['turn'])
  })
})

describe('onDrainExhausted must not be able to re-enter the drain', () => {
  it('survives a handler that mutates from the exhaustion callback', () => {
    const clock = createManualClock(1_000_000)
    let exhausted = 0
    // A buggy game: re-arms an already-due timer on every expiry, and reacts to
    // the exhaustion report by re-arming again. `#firing` guards `onExpire`
    // against exactly this; `onDrainExhausted` is called outside that guard.
    const service: TimerService = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: SPECS,
      onExpire: () => {
        service.set(TURN, { delayMs: 0, issuedAtMs: clock.now() })
      },
      onDrainExhausted: () => {
        exhausted += 1
        service.set(TURN, { delayMs: 0, issuedAtMs: clock.now() })
      },
    })

    expect(() => service.set(TURN, { delayMs: 0, issuedAtMs: 1_000_000 })).not.toThrow()
    expect(exhausted).toBeLessThan(50)
  })
})
