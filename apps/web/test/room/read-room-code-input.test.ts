/**
 * PER-235 — the three readings of a join-code input, as a case table.
 *
 * The fix is a classification, so the cases that matter are the ones either
 * side of the boundary. Two of the three classes are easy to get right and the
 * third is where the bug would come back:
 *
 * - A URL with a code in it → the code. This is the bug being fixed: before
 *   PER-235, `https://host/r/ABC234` was read as code characters and, because
 *   `ROOM_CODE_ALPHABET` excludes `0 O 1 I L`, `https://` normalised to the
 *   five ordinary code characters `HTTPS`. The field showed `HTTPSP` and sent
 *   it.
 * - A URL with no code in it → nothing, and the field says so.
 * - **Everything else → unchanged.** `ABC234 and/or` and `ABC234 join me`
 *   contain a slash and a space respectively and must still be read as
 *   characters; `apps/web/test/room/join-code-prose-paste.test.tsx` pins that
 *   the second joins the right room today. A URL test that only feeds it URLs
 *   would pass with a detector loose enough to break both.
 *
 * Run as a pure case table rather than through the component: each row is a
 * render and a paste otherwise, and the near-misses are half the rows.
 */

import { describe, expect, it } from 'vitest'

import { readRoomCodeInput } from '@/components/room/read-room-code-input'

describe('an invite link', () => {
  // Host and path are both illustrative in every row: the brand and the domain
  // are a board decision, and `/r/[code]` is not built yet. The reader is keyed
  // on the shape of a URL, never on which URL, so these rows are allowed to be
  // wrong about the eventual link and still measure the behaviour.
  const LIFTED = [
    'https://playhall.app/r/ABC234',
    'https://playhall.app/join/ABC234',
    'http://playhall.app/r/ABC234',
    'https://playhall.app/r/abc234',
    'playhall.app/r/ABC234',
    'www.playhall.app/r/ABC234',
    'https://staging.playhall.app/r/ABC234',
    'https://playhall.app/r/ABC234?utm_source=whatsapp',
    'https://playhall.app/r/ABC234#seat=w',
    'https://playhall.app/r/ABC234/',
    // The shapes a chat app actually delivers: a sentence around the link, and
    // the full stop that ends it glued to the last path segment.
    'Join: https://playhall.app/r/ABC234',
    'come play https://playhall.app/r/ABC234 now',
    'Priya invited you — https://playhall.app/r/ABC234.',
    '(https://playhall.app/r/ABC234)',
    '  https://playhall.app/r/ABC234  ',
  ] as const

  for (const raw of LIFTED) {
    it(`gives up its code for ${JSON.stringify(raw)}`, () => {
      expect(readRoomCodeInput(raw)).toEqual({
        code: 'ABC234',
        source: 'link',
        overflowed: false,
      })
    })
  }

  it('reads the path before the query, so a referrer is not mistaken for the room', () => {
    expect(readRoomCodeInput('https://playhall.app/r/ABC234?ref=XYZ789').code).toBe('ABC234')
  })

  it('falls back to a query value when the path has no code', () => {
    expect(readRoomCodeInput('https://playhall.app/join?code=ABC234')).toEqual({
      code: 'ABC234',
      source: 'link',
      overflowed: false,
    })
  })

  it('never reads the host as the code', () => {
    // `CDE234` is a well-formed code sitting where the host goes. Scanning
    // `pathPart.split('/')` without dropping element 0 would join it.
    const reading = readRoomCodeInput('https://cde234.example/play/chess')
    expect(reading.source).toBe('link-without-code')
    expect(reading.code).toBe('')
  })
})

describe('a link with no room code in it', () => {
  const NO_CODE = [
    'https://playhall.app',
    'https://playhall.app/',
    'https://playhall.app/play/chess',
    'https://playhall.app/r/ABC23',
    'https://playhall.app/r/ABC2345',
    'www.playhall.app',
    'https://example.com/some/article',
  ] as const

  for (const raw of NO_CODE) {
    it(`reports itself unreadable for ${JSON.stringify(raw)}`, () => {
      expect(readRoomCodeInput(raw)).toEqual({
        code: '',
        source: 'link-without-code',
        overflowed: false,
      })
    })
  }

  it('clears the field rather than leaving a plausible six characters in it', () => {
    // The whole point of the ticket: `HTTPSP` is what the old reading produced,
    // and `isValidRoomCode` accepts it, so nothing downstream could tell it was
    // not a code. An empty field cannot be submitted by accident.
    expect(readRoomCodeInput('https://playhall.app/play/chess').code).not.toBe('HTTPSP')
    expect(readRoomCodeInput('https://playhall.app/play/chess').code).toBe('')
  })
})

/**
 * The guard. Every row here contains a character that a loose URL detector
 * would fire on — a slash, a dot, a colon — and none of them is a link.
 */
describe('input that is not a link', () => {
  const CHARACTERS = [
    { raw: 'ABC234', code: 'ABC234', overflowed: false },
    { raw: 'abc 234', code: 'ABC234', overflowed: false },
    { raw: 'ABC-234', code: 'ABC234', overflowed: false },
    { raw: '  abc-234  ', code: 'ABC234', overflowed: false },
    // Prose, PER-234's two classes. Still read as characters, still capped,
    // still flagged — the overflow message is what tells the player something
    // was dropped.
    { raw: 'Code: ABC234', code: 'CDEABC', overflowed: true },
    { raw: 'ABC234 join me', code: 'ABC234', overflowed: true },
    { raw: 'join with ABC234', code: 'JNWTHA', overflowed: true },
    // A slash with no host in front of it is prose, not a URL.
    { raw: 'ABC234 and/or XYZ789', code: 'ABC234', overflowed: true },
    { raw: 'seat w/b ABC234', code: 'SEATWB', overflowed: true },
    // A sentence-ending dot is not a host label.
    { raw: 'the code is ABC234.', code: 'THECDE', overflowed: true },
    { raw: 'ABC234', code: 'ABC234', overflowed: false },
    { raw: '', code: '', overflowed: false },
  ] as const

  for (const { raw, code, overflowed } of CHARACTERS) {
    it(`reads ${JSON.stringify(raw)} as code characters`, () => {
      expect(readRoomCodeInput(raw)).toEqual({ code, source: 'characters', overflowed })
    })
  }

  it('keeps capping at the code length', () => {
    expect(readRoomCodeInput('ABC2345')).toEqual({
      code: 'ABC234',
      source: 'characters',
      overflowed: true,
    })
  })
})
