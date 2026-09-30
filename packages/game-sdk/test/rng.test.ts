import { describe, expect, it } from 'vitest'
import { asMatchSeed } from '../src/ids.js'
import { createContextRng, createMatchSeed, createRng, deriveSeed } from '../src/rng.js'

describe('createRng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = Array.from({ length: 20 }, () => createRng('seed-1').next())
    const b = Array.from({ length: 20 }, () => createRng('seed-1').next())
    expect(a).toEqual(b)

    const stream = createRng('seed-1')
    const c = Array.from({ length: 20 }, () => stream.next())
    expect(c[0]).toBe(a[0])
    // A single stream must keep advancing, not repeat its first value.
    expect(new Set(c).size).toBeGreaterThan(1)
  })

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 10 }, () => createRng('seed-a').next())
    const b = Array.from({ length: 10 }, () => createRng('seed-b').next())
    expect(a).not.toEqual(b)
  })

  it('stays within [0, 1)', () => {
    const rng = createRng('range')
    for (let i = 0; i < 5_000; i += 1) {
      const value = rng.next()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('int respects its bounds and covers them', () => {
    const rng = createRng('ints')
    const seen = new Set<number>()
    for (let i = 0; i < 2_000; i += 1) {
      const value = rng.int(3, 7)
      expect(value).toBeGreaterThanOrEqual(3)
      expect(value).toBeLessThan(7)
      seen.add(value)
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6])
  })

  it('int rejects empty and non-integer ranges', () => {
    const rng = createRng('bad')
    expect(() => rng.int(5, 5)).toThrow(RangeError)
    expect(() => rng.int(5, 1)).toThrow(RangeError)
    expect(() => rng.int(0.5, 3)).toThrow(RangeError)
  })

  it('bool honours its probability', () => {
    const rng = createRng('bools')
    let trues = 0
    for (let i = 0; i < 10_000; i += 1) if (rng.bool(0.25)) trues += 1
    expect(trues / 10_000).toBeGreaterThan(0.2)
    expect(trues / 10_000).toBeLessThan(0.3)

    expect(createRng('always').bool(1)).toBe(true)
    expect(createRng('never').bool(0)).toBe(false)
  })

  it('pick chooses from the array and rejects an empty one', () => {
    const rng = createRng('pick')
    const items = ['a', 'b', 'c'] as const
    for (let i = 0; i < 100; i += 1) expect(items).toContain(rng.pick(items))
    expect(() => rng.pick([])).toThrow(RangeError)
  })

  it('shuffle is a deterministic permutation that does not mutate its input', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8]
    const first = createRng('shuffle').shuffle(input)
    const second = createRng('shuffle').shuffle(input)

    expect(first).toEqual(second)
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...first].sort((a, b) => a - b)).toEqual(input)
    expect(first).not.toEqual(input)
  })

  it('fork yields independent, reproducible sub-streams', () => {
    const deck = createRng('match').fork('deck')
    const spawn = createRng('match').fork('spawn')
    expect(deck.next()).not.toBe(spawn.next())

    expect(createRng('match').fork('deck').next()).toBe(createRng('match').fork('deck').next())
  })

  it('exposes the seed it was built from', () => {
    expect(createRng('visible').seed).toBe('visible')
  })
})

describe('deriveSeed', () => {
  it('is length-prefixed, so different part splits do not collide', () => {
    expect(deriveSeed('ab', 'c')).not.toBe(deriveSeed('a', 'bc'))
  })

  it('is stable for the same parts', () => {
    expect(deriveSeed('match', 7)).toBe(deriveSeed('match', 7))
  })
})

describe('createContextRng', () => {
  const seed = asMatchSeed('match-seed')

  it('derives the stream from (seed, sequence) only', () => {
    expect(createContextRng(seed, 4).next()).toBe(createContextRng(seed, 4).next())
    expect(createContextRng(seed, 4).next()).not.toBe(createContextRng(seed, 5).next())
  })

  it('does not depend on how much a previous sequence consumed', () => {
    // Replaying sequence 9 after draining sequence 8 must land on the same
    // numbers as replaying sequence 9 on a cold server.
    const drained = createContextRng(seed, 8)
    for (let i = 0; i < 1_000; i += 1) drained.next()
    expect(createContextRng(seed, 9).next()).toBe(createContextRng(seed, 9).next())
  })

  it('differs across matches', () => {
    expect(createContextRng(seed, 1).next()).not.toBe(
      createContextRng(asMatchSeed('other-match'), 1).next(),
    )
  })
})

describe('createMatchSeed', () => {
  it('brands platform entropy as a match seed', () => {
    expect(createMatchSeed('abc123')).toBe('abc123')
  })
})
