import { describe, expect, it } from 'vitest'

import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  isValidRoomCode,
  normalizeRoomCode,
} from '../src/room-code.js'

/**
 * The characters the alphabet exists to exclude. A player reads a code aloud over a
 * phone call or squints at it on a share card: `0`/`O` and `1`/`I`/`L` are the pairs
 * that send them to the wrong room. Every case below drives this set through the real
 * functions rather than re-stating the constant, so widening the alphabet fails the
 * suite behaviourally and not just at a string comparison.
 */
const CONFUSABLES = ['0', 'O', '1', 'I', 'L'] as const

/** A code built only from alphabet characters, used as the valid baseline. */
const VALID_CODE = 'ABC234'

describe('ROOM_CODE_ALPHABET', () => {
  it('excludes every confusable character in both cases', () => {
    for (const character of CONFUSABLES) {
      expect(ROOM_CODE_ALPHABET).not.toContain(character)
      expect(ROOM_CODE_ALPHABET).not.toContain(character.toLowerCase())
    }
  })

  it('is upper-case alphanumerics with no repeats', () => {
    expect(ROOM_CODE_ALPHABET).toMatch(/^[A-Z2-9]+$/)
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(ROOM_CODE_ALPHABET.length)
  })

  // 36 alphanumerics minus the five confusables. Pins the size so that dropping a
  // character silently (which shrinks the code space) is as loud as adding one back.
  it('has 31 characters', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(31)
  })

  it('uses a 6-character code', () => {
    expect(ROOM_CODE_LENGTH).toBe(6)
    expect(VALID_CODE).toHaveLength(ROOM_CODE_LENGTH)
  })
})

describe('normalizeRoomCode', () => {
  it('upper-cases a code typed in lower case', () => {
    expect(normalizeRoomCode('abc234')).toBe('ABC234')
  })

  it('keeps every alphabet character, in order', () => {
    expect(normalizeRoomCode(ROOM_CODE_ALPHABET)).toBe(ROOM_CODE_ALPHABET)
    expect(normalizeRoomCode(ROOM_CODE_ALPHABET.toLowerCase())).toBe(ROOM_CODE_ALPHABET)
  })

  it('strips the separators a shared code picks up', () => {
    for (const input of ['ABC-234', 'abc 234', 'ABC234.', ' abc/234 ', 'ABC_234', 'ABC\t234']) {
      expect(normalizeRoomCode(input)).toBe(VALID_CODE)
    }
  })

  it('drops every confusable character instead of accepting it', () => {
    for (const character of CONFUSABLES) {
      expect(normalizeRoomCode(character)).toBe('')
      expect(normalizeRoomCode(character.toLowerCase())).toBe('')
    }
  })

  /**
   * The documented decision in `room-code.ts`: there is no fold table, because both
   * halves of every confusable pair are excluded, so there is nothing in-alphabet to
   * fold *to*. A regression that added `O -> 0` would turn this red.
   */
  it('does not fold a confusable onto its partner', () => {
    expect(normalizeRoomCode('O')).not.toBe('0')
    expect(normalizeRoomCode('0')).not.toBe('O')
    expect(normalizeRoomCode('I')).not.toBe('1')
    expect(normalizeRoomCode('l')).not.toBe('1')
  })

  /**
   * The payoff of dropping rather than substituting: a misread character leaves five
   * usable characters, which fails the length check and lands the player on the
   * friendly not-found path instead of silently in a stranger's room.
   */
  it('leaves a short code when a character is misread', () => {
    const misread = normalizeRoomCode('ABCO34')

    expect(misread).toBe('ABC34')
    expect(misread.length).toBeLessThan(ROOM_CODE_LENGTH)
    expect(isValidRoomCode(misread)).toBe(false)
  })

  it('returns an empty string for input with nothing in the alphabet', () => {
    expect(normalizeRoomCode('')).toBe('')
    expect(normalizeRoomCode('---')).toBe('')
    expect(normalizeRoomCode('oil')).toBe('')
  })

  it('does not validate length, so a partial code survives normalisation', () => {
    expect(normalizeRoomCode('ab')).toBe('AB')
    expect(normalizeRoomCode('ABC2345678')).toBe('ABC2345678')
  })
})

describe('isValidRoomCode', () => {
  it('accepts a 6-character code drawn from the alphabet', () => {
    expect(isValidRoomCode(VALID_CODE)).toBe(true)
  })

  it('accepts every alphabet character in every position', () => {
    for (const character of ROOM_CODE_ALPHABET) {
      for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
        const code = VALID_CODE.slice(0, index) + character + VALID_CODE.slice(index + 1)
        expect(isValidRoomCode(code)).toBe(true)
      }
    }
  })

  it('rejects a code containing a confusable character', () => {
    for (const character of CONFUSABLES) {
      expect(isValidRoomCode(`ABC23${character}`)).toBe(false)
      expect(isValidRoomCode(`${character}BC234`)).toBe(false)
    }
  })

  it('rejects the wrong length', () => {
    expect(isValidRoomCode('')).toBe(false)
    expect(isValidRoomCode('ABC23')).toBe(false)
    expect(isValidRoomCode('ABC2345')).toBe(false)
  })

  it('rejects lower case, because it validates an already-normalised code', () => {
    expect(isValidRoomCode('abc234')).toBe(false)
    expect(isValidRoomCode(normalizeRoomCode('abc234'))).toBe(true)
  })

  it('rejects separators that normalisation would have removed', () => {
    expect(isValidRoomCode('ABC-234')).toBe(false)
    expect(isValidRoomCode('ABC 23')).toBe(false)
  })
})
