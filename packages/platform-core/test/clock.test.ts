import { describe, expect, it } from 'vitest'
import { createFixedClock, createManualClock, createSystemClock } from '../src/timers/clock.js'

describe('createManualClock', () => {
  it('starts where it is told and only moves when moved', () => {
    const clock = createManualClock(1_000)
    expect(clock.now()).toBe(1_000)
    expect(clock.now()).toBe(1_000)
    clock.advance(250)
    expect(clock.now()).toBe(1_250)
    clock.set(5_000)
    expect(clock.now()).toBe(5_000)
  })

  it('refuses to go backwards, because a clock that can is not a clock', () => {
    const clock = createManualClock(1_000)
    expect(() => clock.advance(-1)).toThrow(RangeError)
    expect(() => clock.set(999)).toThrow(RangeError)
    expect(clock.now()).toBe(1_000)
  })
})

describe('createFixedClock', () => {
  it('never moves', () => {
    const clock = createFixedClock(42)
    expect(clock.now()).toBe(42)
    expect(clock.now()).toBe(42)
  })
})

describe('createSystemClock', () => {
  it('is anchored near the wall clock', () => {
    const clock = createSystemClock()
    // Not `Date.now()` under test either; the anchor is taken at construction,
    // so the two can only differ by the time this assertion took to reach.
    expect(Math.abs(clock.now() - new Date().getTime())).toBeLessThan(50)
  })

  it('is monotonically non-decreasing under a tight read loop', () => {
    const clock = createSystemClock()
    let previous = clock.now()
    for (let i = 0; i < 50_000; i += 1) {
      const current = clock.now()
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
  })

  it('returns integers, so nothing downstream has to decide how to round', () => {
    const clock = createSystemClock()
    expect(Number.isInteger(clock.now())).toBe(true)
  })
})
