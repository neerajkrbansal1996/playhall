/**
 * Every millisecond quantity a game hands the timer service is rejected at the
 * boundary unless it is an integer, and a duration unless it is also
 * non-negative.
 *
 * The invariant is "no unrepresentable number ever reaches a deadline", and it
 * is not a tidiness rule. A single `NaN` from a game module used to take the
 * whole room down four different ways — an unfireable timer, a scheduler
 * spinning at ~1 ms forever, an unrestorable snapshot, and a `timer:sync`
 * frame the *client's* own schema rejects so every clock in the room freezes.
 * All four are silent and none is recoverable after the fact, which is why
 * these throw rather than clamp. See `src/timers/quantities.ts`.
 */
import {
  type TimerSpec,
  asMatchId,
  asSeatId,
  asTimerId,
  clearTimer,
  setTimer,
} from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { fixedClock } from '../src/runtime.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { TimerService } from '../src/timers/service.js'

const MATCH = asMatchId('m1')
const WHITE = asSeatId('white')
const TURN = asTimerId('turn')
const WCLOCK = asTimerId('clock:white')

const SPECS: readonly TimerSpec[] = [
  { id: 'turn', kind: 'turn', description: 'move deadline', pausesOnDisconnect: true },
  { id: 'clock:white', kind: 'chess-clock', description: 'white', pausesOnDisconnect: true },
]

function newService() {
  const clock = fixedClock(1_000_000)
  const service = new TimerService({
    matchId: MATCH,
    clock,
    scheduler: createManualScheduler(),
    specs: SPECS,
  })
  return { service, clock }
}

/** The values a game can realistically produce from bad arithmetic. */
const NOT_A_DURATION: readonly [string, number][] = [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['a fraction', 30_000.5],
  ['a negative', -1],
  ['beyond Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2],
]

describe('set() rejects a delayMs it cannot build a deadline from', () => {
  for (const [label, value] of NOT_A_DURATION) {
    it(`rejects ${label}`, () => {
      const { service } = newService()
      expect(() => service.set(TURN, { delayMs: value })).toThrow(RangeError)
      // And rejects it *before* it mutates anything: a throw that leaves a
      // half-built record behind is no better than the original bug.
      expect(service.get(TURN)).toBeUndefined()
      expect(service.nextDeadlineMs()).toBeNull()
    })
  }

  it('still accepts zero, which is the honest way to ask for an immediate expiry', () => {
    const { service } = newService()
    const fired: string[] = []
    const immediate = new TimerService({
      matchId: MATCH,
      clock: fixedClock(1_000_000),
      scheduler: createManualScheduler(),
      specs: SPECS,
      onExpire: (expiry) => fired.push(expiry.timerId),
    })
    expect(() => service.set(TURN, { delayMs: 0 })).not.toThrow()
    immediate.set(TURN, { delayMs: 0 })
    expect(fired).toEqual([TURN])
  })

  it('rejects an issuedAtMs that is not an instant', () => {
    const { service } = newService()
    expect(() => service.set(TURN, { delayMs: 1_000, issuedAtMs: Number.NaN })).toThrow(RangeError)
    expect(() => service.set(TURN, { delayMs: 1_000, issuedAtMs: 1_000_000.25 })).toThrow(
      RangeError,
    )
    expect(service.get(TURN)).toBeUndefined()
  })

  it('names the offending shape in the message, so a game author can act on it', () => {
    const { service } = newService()
    expect(() => service.set(TURN, { delayMs: Number.NaN })).toThrow(/delayMs.*NaN/)
    expect(() => service.set(TURN, { delayMs: 1.5 })).toThrow(/fractional value 1\.5/)
  })
})

describe('apply() validates the whole batch before executing any of it', () => {
  it('rejects a bad command without applying the good ones in front of it', () => {
    const { service } = newService()
    service.set(TURN, { delayMs: 30_000 })
    const before = service.get(TURN)

    expect(() =>
      service.apply([clearTimer(TURN), setTimer(WCLOCK, Number.NaN, WHITE)], 1_000_000),
    ).toThrow(RangeError)

    // The `clear` in front of the bad `set` must not have run. A reducer
    // returns its commands as one unit, and half of a batch is a state the
    // game never asked for — on the match log, where it is permanent.
    expect(service.get(TURN)).toBe(before)
    expect(service.get(WCLOCK)).toBeUndefined()
  })

  it('rejects an issuedAtMs that is not an instant', () => {
    const { service } = newService()
    expect(() => service.apply([setTimer(TURN, 1_000)], Number.NaN)).toThrow(RangeError)
    expect(service.get(TURN)).toBeUndefined()
  })

  it('names the timer the bad command was for', () => {
    const { service } = newService()
    expect(() => service.apply([setTimer(TURN, Number.POSITIVE_INFINITY)], 1_000_000)).toThrow(
      /turn\.delayMs/,
    )
  })
})

describe('declarePlayerClock rejects an unbuildable clock configuration', () => {
  it.each([
    ['initialMs', { initialMs: Number.NaN }],
    ['incrementMs', { incrementMs: Number.POSITIVE_INFINITY }],
    ['delayMs', { delayMs: -5 }],
    ['maxMs', { maxMs: 600_000.5 }],
  ])('rejects a bad %s', (_label, config) => {
    const { service } = newService()
    expect(() => service.declarePlayerClock(WCLOCK, WHITE, config)).toThrow(RangeError)
    expect(service.get(WCLOCK)).toBeUndefined()
  })

  it('accepts a null maxMs, which means uncapped', () => {
    const { service } = newService()
    expect(() => service.declarePlayerClock(WCLOCK, WHITE, { maxMs: null })).not.toThrow()
  })
})

describe('every entry point that takes an instant checks it', () => {
  it('rejects a NaN atMs on each mutator and query', () => {
    const { service } = newService()
    service.declarePlayerClock(WCLOCK, WHITE, { initialMs: 60_000 })
    const bad = Number.NaN
    expect(() => service.clear(TURN, bad)).toThrow(RangeError)
    expect(() => service.pause(WCLOCK, bad)).toThrow(RangeError)
    expect(() => service.resume(WCLOCK, bad)).toThrow(RangeError)
    expect(() => service.switchTurnTo(WHITE, bad)).toThrow(RangeError)
    expect(() => service.pauseForSeat(WHITE, bad)).toThrow(RangeError)
    expect(() => service.resumeForSeat(WHITE, bad)).toThrow(RangeError)
    expect(() => service.pauseAll(bad)).toThrow(RangeError)
    expect(() => service.resumeAll(bad)).toThrow(RangeError)
    expect(() => service.poll(bad)).toThrow(RangeError)
    expect(() => service.views(bad)).toThrow(RangeError)
    expect(() => service.snapshot(bad)).toThrow(RangeError)
    expect(() => service.sync({ atMs: bad })).toThrow(RangeError)
    expect(() => service.declarePlayerClock(WCLOCK, WHITE, {}, bad)).toThrow(RangeError)
  })

  it('leaves the omitted form alone — the service clock needs no checking', () => {
    const { service } = newService()
    service.declarePlayerClock(WCLOCK, WHITE, { initialMs: 60_000 })
    expect(() => service.pauseAll()).not.toThrow()
    expect(() => service.resumeAll()).not.toThrow()
    expect(() => service.poll()).not.toThrow()
    expect(() => service.snapshot()).not.toThrow()
  })
})

describe('what the rejection protects, stated as behaviour', () => {
  it('keeps the snapshot restorable, so the room can still come back', () => {
    const { service } = newService()
    expect(() => service.set(TURN, { delayMs: Number.NaN })).toThrow()
    // The schema requires finite integers. A poisoned record would make this
    // throw on the way *out*, which means crash recovery can never run again.
    expect(() => service.snapshot()).not.toThrow()
  })

  it('keeps the sync frame parseable, so no client freezes', () => {
    const { service } = newService()
    service.declarePlayerClock(WCLOCK, WHITE, { initialMs: 60_000 })
    service.switchTurnTo(WHITE)
    expect(() => service.set(TURN, { delayMs: Number.NaN })).toThrow()

    // One bad record used to make the *whole* frame fail the client's schema,
    // so the player's own clock stopped updating too.
    const frame = service.sync()
    expect(frame.timers.every((entry) => Number.isInteger(entry.remainingMs))).toBe(true)
    expect(frame.timers.find((entry) => entry.timerId === WCLOCK)?.remainingMs).toBe(60_000)
  })

  it('leaves no armed deadline for the real scheduler to spin on', () => {
    const armedAt: number[] = []
    const service = new TimerService({
      matchId: MATCH,
      clock: fixedClock(1_000_000),
      specs: SPECS,
      scheduler: { arm: (atMs) => armedAt.push(atMs), disarm: () => {} },
    })

    expect(() => service.set(TURN, { delayMs: Number.NaN })).toThrow()
    // `setTimeout` coerces a `NaN` delay to 0, so an armed `NaN` deadline makes
    // the room burn one timer callback per tick for the rest of its life — on
    // the 2,000-rooms-per-instance path. Nothing was armed at all, which is the
    // point, and `nextDeadlineMs` has nothing to offer the next re-arm either.
    expect(armedAt).toEqual([])
    expect(service.nextDeadlineMs()).toBeNull()
  })
})
