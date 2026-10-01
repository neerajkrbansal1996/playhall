import { describe, expect, it } from 'vitest'
import { createSystemClock } from '../src/clock'

describe('createSystemClock', () => {
  it('is anchored near the wall clock', () => {
    const clock = createSystemClock()
    // Generous: the assertion is "this is an epoch timestamp", not "this is
    // fast". A minute of slack still fails if the anchor is a monotonic
    // counter (~ms since process start) rather than an epoch instant.
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(60_000)
  })

  it('is monotonically non-decreasing under a tight read loop', () => {
    const clock = createSystemClock()
    let previous = clock.now()
    for (let index = 0; index < 20_000; index += 1) {
      const reading = clock.now()
      expect(reading).toBeGreaterThanOrEqual(previous)
      previous = reading
    }
  })

  it('returns integers, so nothing downstream has to decide how to round', () => {
    const clock = createSystemClock()
    for (let index = 0; index < 50; index += 1) {
      expect(Number.isInteger(clock.now())).toBe(true)
    }
  })

  it('satisfies the platform-core Clock port, which is the whole point of living here', () => {
    // A compile-time claim made at runtime: the service in platform-core takes
    // this shape and nothing else. If the port changes, this fails to compile.
    const clock = createSystemClock()
    expect(typeof clock.now).toBe('function')
    expect(Object.keys(clock)).toEqual(['now'])
  })
})
