import { describe, expect, it } from 'vitest'

import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  isValidRoomCode,
  normalizeRoomCode,
} from '../src/room-code.js'

/**
 * The room-code alphabet is a product constraint, not an implementation detail: a
 * code gets read aloud over a phone call and typed on a phone keyboard, so the
 * five mutually-confusable glyphs are excluded outright. These cases pin that
 * exclusion, because widening the alphabet later would silently make existing
 * codes ambiguous rather than fail anything.
 */
describe('ROOM_CODE_ALPHABET', () => {
  it('excludes every confusable glyph', () => {
    for (const excluded of ['0', 'O', '1', 'I', 'L']) {
      expect(ROOM_CODE_ALPHABET).not.toContain(excluded)
    }
  })

  it('is upper-case alphanumeric with no duplicates', () => {
    expect(ROOM_CODE_ALPHABET).toMatch(/^[2-9A-Z]+$/)
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(ROOM_CODE_ALPHABET.length)
  })

  it('leaves 31 usable characters, so a 6-character code has ~29.5 bits of entropy', () => {
    expect(ROOM_CODE_ALPHABET.length).toBe(31)
    expect(ROOM_CODE_LENGTH).toBe(6)
    expect(Math.log2(ROOM_CODE_ALPHABET.length ** ROOM_CODE_LENGTH)).toBeGreaterThan(29)
  })
})

describe('normalizeRoomCode', () => {
  it('upper-cases input', () => {
    expect(normalizeRoomCode('abcdef')).toBe('ABCDEF')
  })

  it('passes an already-canonical code through unchanged', () => {
    expect(normalizeRoomCode('23456789')).toBe('23456789')
  })

  it('strips separators and whitespace a human would type', () => {
    expect(normalizeRoomCode(' ab2-3 c4 ')).toBe('AB23C4')
  })

  it('strips characters outside the alphabet rather than guessing at them', () => {
    expect(normalizeRoomCode('A@B#C$2')).toBe('ABC2')
  })

  /**
   * Every excluded glyph is dropped, not folded. `room-code.ts` carries a
   * confusable map, but each of its targets (`0`, `O`, `1`) is itself outside the
   * alphabet, so no fold can ever land inside it — the guard in `normalizeRoomCode`
   * rejects all of them. Dropping is the only correct answer here: because both
   * sides of each confusable pair are excluded, there is no canonical character to
   * fold *to*. This case exists so that the day someone re-admits a glyph to the
   * alphabet, the fold turns on deliberately and visibly instead of by accident.
   */
  it('drops confusable glyphs instead of folding them to an excluded character', () => {
    expect(normalizeRoomCode('O0IL1')).toBe('')
    expect(normalizeRoomCode('2O3I4L5')).toBe('2345')
  })

  it('returns an empty string when nothing survives', () => {
    expect(normalizeRoomCode('')).toBe('')
    expect(normalizeRoomCode('---')).toBe('')
  })

  it('does not enforce length, so a partial code can be normalised as it is typed', () => {
    expect(normalizeRoomCode('ab')).toBe('AB')
    expect(normalizeRoomCode('abcdefgh')).toBe('ABCDEFGH')
  })

  it('is idempotent', () => {
    const once = normalizeRoomCode(' o0-Ab2c ')
    expect(normalizeRoomCode(once)).toBe(once)
  })
})

describe('isValidRoomCode', () => {
  it('accepts a code of the exact length drawn from the alphabet', () => {
    expect(isValidRoomCode('23456789'.slice(0, ROOM_CODE_LENGTH))).toBe(true)
    expect(isValidRoomCode(ROOM_CODE_ALPHABET.slice(0, ROOM_CODE_LENGTH))).toBe(true)
  })

  it('rejects a code that is too short or too long', () => {
    expect(isValidRoomCode('')).toBe(false)
    expect(isValidRoomCode('ABCDE')).toBe(false)
    expect(isValidRoomCode('ABCDEFG')).toBe(false)
  })

  it('rejects a correct-length code containing an excluded glyph', () => {
    for (const excluded of ['0', 'O', '1', 'I', 'L']) {
      expect(isValidRoomCode(`ABCDE${excluded}`)).toBe(false)
    }
  })

  it('rejects lower case, because a code is stored canonical', () => {
    expect(isValidRoomCode('abcdef')).toBe(false)
  })

  it('accepts every character in the alphabet in the first position', () => {
    for (const ch of ROOM_CODE_ALPHABET) {
      expect(isValidRoomCode(`${ch}23456`)).toBe(true)
    }
  })
})

describe('normalizeRoomCode + isValidRoomCode', () => {
  it('normalising a decorated valid code yields a valid code', () => {
    expect(isValidRoomCode(normalizeRoomCode('ab2-3c4'))).toBe(true)
  })

  it('normalising cannot rescue a code that is short once stripped', () => {
    expect(isValidRoomCode(normalizeRoomCode('ab2-3c'))).toBe(false)
  })
})
