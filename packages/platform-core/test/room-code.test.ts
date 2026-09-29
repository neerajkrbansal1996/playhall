import { describe, expect, it } from 'vitest'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@playhall/shared'
import {
  ROOM_CODE_SPACE,
  RoomCodeExhaustionError,
  allocateRoomCode,
  generateRoomCode,
  isValidRoomCode,
} from '../src/rooms/code.js'
import { sequenceRandomSource, webCryptoRandomSource } from '../src/runtime.js'

const AMBIGUOUS = ['0', 'O', '1', 'I', 'L']

describe('alphabet safety', () => {
  it('excludes every ambiguous character', () => {
    for (const character of AMBIGUOUS) {
      expect(ROOM_CODE_ALPHABET).not.toContain(character)
    }
    expect(ROOM_CODE_ALPHABET).toHaveLength(31)
  })

  it('never emits an ambiguous character across 5k generated codes', () => {
    const random = webCryptoRandomSource()
    const seen = new Set<string>()
    for (let index = 0; index < 5_000; index += 1) {
      const code = generateRoomCode(random)
      expect(code).toHaveLength(ROOM_CODE_LENGTH)
      for (const character of code) seen.add(character)
    }
    // Every emitted character is in the alphabet...
    for (const character of seen) expect(ROOM_CODE_ALPHABET).toContain(character)
    // ...and 5k codes (30k characters) is enough to have exercised all 31,
    // which is what proves the rejection sampling is not silently truncating
    // the tail of the alphabet.
    expect(seen.size).toBe(ROOM_CODE_ALPHABET.length)
  })

  it('reports the full code space', () => {
    expect(ROOM_CODE_SPACE).toBe(31 ** 6)
    expect(ROOM_CODE_SPACE).toBe(887_503_681)
  })

  it('rejects codes containing an excluded character', () => {
    expect(isValidRoomCode('ABC234')).toBe(true)
    expect(isValidRoomCode('ABC23O')).toBe(false)
    expect(isValidRoomCode('ABC23I')).toBe(false)
    expect(isValidRoomCode('ABC23')).toBe(false)
    expect(isValidRoomCode('ABC2345')).toBe(false)
    expect(isValidRoomCode('abc234')).toBe(false)
  })

  it('rejects a non-positive length', () => {
    const random = sequenceRandomSource([0])
    expect(() => generateRoomCode(random, 0)).toThrow(RangeError)
    expect(() => generateRoomCode(random, 1.5)).toThrow(RangeError)
  })
})

describe('uniformity', () => {
  it('discards out-of-range bytes instead of folding them', () => {
    // 248..255 are >= 31 * 8 and must be rejected. If they were folded with
    // `% 31` the first eight characters would be over-represented.
    const random = sequenceRandomSource([248, 249, 250, 251, 252, 253, 254, 255, 0, 1, 2, 3, 4, 5])
    expect(generateRoomCode(random)).toBe('234567')
  })

  it('maps a perfectly uniform byte stream to a perfectly uniform alphabet', () => {
    // Deterministic rather than statistical: feed every byte value 0..255 in
    // a cycle, so any deviation from an exactly flat histogram is the
    // generator's bias and not sampling noise. 248 codes consume 1,488
    // accepted bytes — exactly six passes over the 248 in-range values — so
    // each of the 31 characters must appear exactly 48 times. Under `% 31`
    // folding the first eight would appear 54 times and the rest 48.
    const random = sequenceRandomSource(Array.from({ length: 256 }, (_, byte) => byte))
    const counts = new Map<string, number>()
    for (let index = 0; index < 248; index += 1) {
      for (const character of generateRoomCode(random)) {
        counts.set(character, (counts.get(character) ?? 0) + 1)
      }
    }
    expect(counts.size).toBe(ROOM_CODE_ALPHABET.length)
    for (const character of ROOM_CODE_ALPHABET) expect(counts.get(character)).toBe(48)
  })
})

describe('collision handling', () => {
  it('returns the first free code with a zero collision count', async () => {
    const taken = new Set<string>()
    const allocation = await allocateRoomCode(webCryptoRandomSource(), (code) => {
      if (taken.has(code)) return false
      taken.add(code)
      return true
    })
    expect(allocation.collisions).toBe(0)
    expect(isValidRoomCode(allocation.code)).toBe(true)
  })

  it('retries until the reservation succeeds and reports the collisions', async () => {
    let calls = 0
    const allocation = await allocateRoomCode(webCryptoRandomSource(), () => {
      calls += 1
      return calls > 3
    })
    expect(allocation.collisions).toBe(3)
    expect(calls).toBe(4)
  })

  it('awaits an async reservation', async () => {
    let calls = 0
    const allocation = await allocateRoomCode(webCryptoRandomSource(), async () => {
      calls += 1
      return Promise.resolve(calls > 1)
    })
    expect(allocation.collisions).toBe(1)
  })

  it('throws once the attempt budget is spent rather than looping forever', async () => {
    await expect(allocateRoomCode(webCryptoRandomSource(), () => false, 5)).rejects.toBeInstanceOf(
      RoomCodeExhaustionError,
    )
    await expect(allocateRoomCode(webCryptoRandomSource(), () => false, 5)).rejects.toThrow(
      /5 attempts/,
    )
  })

  it('never hands the same code to two concurrent allocations', async () => {
    // The reservation is the only thing standing between two creations and a
    // shared code, so it is what the test drives: a single Set, checked and
    // written in one synchronous step.
    const taken = new Set<string>()
    const reserve = (code: string): boolean => (taken.has(code) ? false : (taken.add(code), true))
    const allocations = await Promise.all(
      Array.from({ length: 500 }, () => allocateRoomCode(webCryptoRandomSource(), reserve)),
    )
    expect(new Set(allocations.map((a) => a.code)).size).toBe(500)
  })
})
