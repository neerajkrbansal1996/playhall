import { describe, expect, it } from 'vitest'
import {
  isValidRoomCode,
  normalizeRoomCode,
  redactRoomCode,
  REDACTED,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '../src/index'

/**
 * `room-code` shipped with the M0.1 skeleton and had no runner to cover it.
 * Adding the runner in this package without covering it would put a false 80%
 * badge on the package, so it is covered here. `brand` is covered by
 * `brand.test.ts` against the ADR-0001 §10 rev 3 semantics — this file no
 * longer asserts on `BRAND`, whose old assertion predated that revision.
 */

describe('normalizeRoomCode', () => {
  it('upper-cases and keeps only alphabet characters', () => {
    expect(normalizeRoomCode('tcq4mn')).toBe('TCQ4MN')
    expect(normalizeRoomCode('TCQ-4MN ')).toBe('TCQ4MN')
    expect(normalizeRoomCode('!!!')).toBe('')
  })

  it('drops a confusable whose canonical form is also excluded', () => {
    // I and L fold to '1', O folds to '0' — and none of '0', '1' is in the
    // alphabet either, so all three are dropped rather than mis-folded.
    expect(normalizeRoomCode('I')).toBe('')
    expect(normalizeRoomCode('L')).toBe('')
    expect(normalizeRoomCode('TCQ4MO')).toBe('TCQ4M')
  })

  it('does not enforce length - a partial code is the caller decision', () => {
    expect(normalizeRoomCode('TC')).toBe('TC')
  })
})

describe('isValidRoomCode', () => {
  it('accepts exactly 6 alphabet characters', () => {
    expect(isValidRoomCode('TCQ4MN')).toBe(true)
    expect(isValidRoomCode('TCQ4M')).toBe(false)
    expect(isValidRoomCode('TCQ4MNP')).toBe(false)
  })

  it('rejects the ambiguous characters the alphabet excludes', () => {
    for (const ch of ['0', 'O', '1', 'I', 'L']) {
      expect(ROOM_CODE_ALPHABET.includes(ch), ch).toBe(false)
      expect(isValidRoomCode(`TCQ4M${ch}`), ch).toBe(false)
    }
    expect(ROOM_CODE_LENGTH).toBe(6)
  })
})

describe('redactRoomCode', () => {
  it('redacts a code a call site holds, and leaves an empty string alone', () => {
    expect(redactRoomCode('TCQ4MN')).toBe(REDACTED)
    expect(redactRoomCode('')).toBe('')
  })
})
