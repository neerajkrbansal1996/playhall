/**
 * PER-242 — `extractRoomCode`, the rule by which a paste that carries more than
 * a code yields the code.
 *
 * The rule is "exactly one run of exactly six alphabet characters". These cases
 * pin the rule itself; `apps/web/test/room/join-code-prose-paste.test.tsx` pins
 * what `JoinByCodeForm` does with each answer, which is the half a helper-level
 * test cannot reach.
 */

import { describe, expect, it } from 'vitest'

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, extractRoomCode } from '../src/room-code'

const CODE = 'ABC234'

describe('extractRoomCode', () => {
  it('is pinned to an alphabet that excludes 0 1 I L O', () => {
    // The whole rule rests on this: if any of these were admitted, `JOIN`,
    // `HTTPS://` and most English words would stop shattering into short runs
    // and would start producing six-runs of their own. The exclusion is the
    // mechanism, not an incidental property, so it is asserted here rather than
    // left as a comment.
    for (const excluded of '01ILO') expect(ROOM_CODE_ALPHABET).not.toContain(excluded)
    expect(ROOM_CODE_LENGTH).toBe(6)
  })

  it('returns a bare code unchanged, and lower-cases up', () => {
    expect(extractRoomCode(CODE)).toBe(CODE)
    expect(extractRoomCode('abc234')).toBe(CODE)
  })

  describe('finds the code with prose or URL chrome in front of it', () => {
    // `example.test` throughout: the product domain is an open board decision,
    // and the rule parses no URLs, so no case here depends on the host.
    const CARRIERS = [
      'https://example.test/join/ABC234',
      'example.test/join/ABC234',
      'https://example.test/r/ABC234',
      'Code: ABC234',
      'join with ABC234',
      'ABC234 join me',
      'Join my game: ABC234 - see you there',
    ] as const

    for (const raw of CARRIERS) {
      it(JSON.stringify(raw), () => {
        expect(extractRoomCode(raw)).toBe(CODE)
      })
    }
  })

  describe('declines rather than guessing', () => {
    it('declines a seven-run, so the caller still drops and announces the 7th', () => {
      // The load-bearing refusal. A substring search returns `ABC234` here and
      // turns a reported typo into a silent wrong room — see PER-214.
      expect(extractRoomCode('ABC2345')).toBeUndefined()
      expect(extractRoomCode('Code: ABC2345')).toBeUndefined()
    })

    it('declines when two six-runs are present', () => {
      // `SECRET` is six alphabet characters. Nothing distinguishes it from the
      // code, so returning either would be a coin flip presented as certainty.
      expect(extractRoomCode('Secret code ABC234')).toBeUndefined()
      expect(extractRoomCode('ABCDEF GHJKMN')).toBeUndefined()
    })

    it('declines a short run, an empty input, and input with no code in it', () => {
      expect(extractRoomCode('ABC23')).toBeUndefined()
      expect(extractRoomCode('ABC-234')).toBeUndefined()
      expect(extractRoomCode('')).toBeUndefined()
      expect(extractRoomCode('lol')).toBeUndefined()
    })
  })

  it('treats every non-alphabet character as a boundary, not only whitespace', () => {
    // `ABC-234` is the PER-197 shape: two short runs, so extraction declines and
    // the caller's `normalizeRoomCode` + cap resolves it to `ABC234` as before.
    // Extraction must not join runs across a separator, or `ABC-2345` — eight
    // raw characters carrying a seven-character typo — would come back as a code.
    expect(extractRoomCode('ABC-2345')).toBeUndefined()
    expect(extractRoomCode('ABC-234-5')).toBeUndefined()
  })

  it('ignores excluded letters without letting them join two runs', () => {
    // `O` is not in the alphabet, so `ABCO234` is `ABC` + `234`: two runs of
    // three, not one run of six. Folding it away first would produce `ABC234`
    // and accept a code with a character that cannot be in one.
    expect(extractRoomCode('ABCO234')).toBeUndefined()
  })
})
