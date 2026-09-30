/**
 * Display-name sanitisation and validation.
 *
 * A guest name is the only free text a player supplies before they are in a
 * room, and it is rendered in the lobby, the seat list, the chat transcript and
 * the link preview. So it gets cleaned once, here, at the edge — never at a
 * render site.
 *
 * Two decisions worth stating, because they look like omissions otherwise:
 *
 * 1. **Sanitised names are stored as plain text, not as HTML entities.**
 *    Escaping at write time double-escapes the moment a second layer escapes
 *    again ("Ben &amp;amp; Jerry"), and it makes length limits lie — `&amp;`
 *    is one character to a player and five to a database. Instead the
 *    sanitiser *rejects* the characters that can open markup (`<`, `>`), and
 *    `escapeHtml` is exported for the one place that needs it: server-rendered
 *    HTML and link-preview meta tags, which are not React and do not escape
 *    for us. React, and every JSON path, escape on their own.
 * 2. **Length is counted in code points, not UTF-16 units.** "😀😀" is two
 *    characters to a player; `String.length` says four.
 */

import { type Result, err, ok } from '@playhall/game-sdk'
import { type ProfanityOptions, findProfanity } from './profanity.js'

export const DISPLAY_NAME_MIN_LENGTH = 2
export const DISPLAY_NAME_MAX_LENGTH = 20

/**
 * Hard cap on the raw input before any work is done. Sanitising is O(n) but
 * unicode normalisation on a megabyte of combining marks is not free, and
 * nothing legitimate arrives near this.
 */
export const DISPLAY_NAME_MAX_RAW_LENGTH = 200

export const DISPLAY_NAME_REJECTION_REASONS = [
  /** Nothing survived sanitisation. */
  'empty',
  /** Raw input exceeded `DISPLAY_NAME_MAX_RAW_LENGTH`; not even sanitised. */
  'too_long_raw',
  'too_short',
  'too_long',
  /** Contained `<`, `>` or another character we refuse to carry. */
  'invalid_characters',
  /**
   * Nothing but punctuation and symbols — "..." or "-=-". Emoji count as
   * content, so "🙂🙂" is a valid name; a mobile-first product that rejected
   * it would be rejecting how a lot of players actually name themselves.
   */
  'no_letters_or_emoji',
  'profanity',
] as const

export type DisplayNameRejectionReason = (typeof DISPLAY_NAME_REJECTION_REASONS)[number]

export interface DisplayNameRejection {
  readonly reason: DisplayNameRejectionReason
  /** The sanitised value we judged, for logs. Absent when nothing survived. */
  readonly sanitized?: string
  /** Which blocklist term matched. Only set for `profanity`. */
  readonly term?: string
}

/**
 * Characters we refuse outright rather than escape.
 *
 * - `<` `>` open markup, and no display name needs them.
 * - C0/C1 controls and the bidi overrides let a name reorder the text around
 *   it, which is how a player fakes a system message in a chat transcript.
 * - The unicode line/paragraph separators break single-line layout.
 */
// Matching control characters is the entire purpose of this pattern. The rule
// guards against writing them by accident, which is why every one of them is
// spelled as an escape here.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/

/**
 * Stripped silently rather than rejected: invisible formatting characters that
 * users paste by accident far more often than they use maliciously.
 * Zero-width space/joiner, soft hyphen, BOM, and the Mongolian vowel separator.
 */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200D\u2060\uFEFF]/g

const WHITESPACE_RUN = /\s+/g

/**
 * One character a player would call content: a letter, a digit, or an emoji.
 * Deliberately not "any non-punctuation" — that would admit "-=-", because `=`
 * is a math symbol rather than punctuation.
 *
 * `\p{RI}` is listed separately because a flag is built from two regional
 * indicators and those are *not* `Extended_Pictographic`; without it "🇬🇧" is
 * the one emoji this package calls punctuation.
 *
 * Exported because `avatar.ts` must use the identical class: any name the
 * sanitiser accepts has to be able to produce an initial, or the avatar renders
 * a letter the player never typed. `display-name.test.ts` asserts the two stay
 * in step.
 */
export const NAME_CONTENT_PATTERN = /[\p{L}\p{N}\p{Extended_Pictographic}\p{RI}]/u

/**
 * Cleans a candidate name without judging it. Idempotent: sanitising a
 * sanitised name returns the same string, which is what lets the service
 * re-validate a name that came back off a token without it drifting.
 */
export function sanitizeDisplayName(raw: string): string {
  return raw.normalize('NFKC').replace(INVISIBLE, '').replace(WHITESPACE_RUN, ' ').trim()
}

/** Number of code points, which is what a player counts. */
export function displayNameLength(value: string): number {
  let count = 0
  for (const _ of value) count += 1
  return count
}

export interface ValidateDisplayNameOptions extends ProfanityOptions {
  /** Skip the profanity screen. Only the fun-name generator sets this. */
  readonly skipProfanityCheck?: boolean
}

/**
 * Sanitises then validates. The success value is the sanitised name — callers
 * must persist *that*, not the raw input, or the cleaning is decorative.
 */
export function validateDisplayName(
  raw: string,
  options: ValidateDisplayNameOptions = {},
): Result<string, DisplayNameRejection> {
  if (raw.length > DISPLAY_NAME_MAX_RAW_LENGTH) return err({ reason: 'too_long_raw' })

  const sanitized = sanitizeDisplayName(raw)
  if (sanitized.length === 0) return err({ reason: 'empty' })
  if (FORBIDDEN.test(sanitized)) return err({ reason: 'invalid_characters', sanitized })

  const length = displayNameLength(sanitized)
  if (length < DISPLAY_NAME_MIN_LENGTH) return err({ reason: 'too_short', sanitized })
  if (length > DISPLAY_NAME_MAX_LENGTH) return err({ reason: 'too_long', sanitized })
  if (!NAME_CONTENT_PATTERN.test(sanitized)) {
    return err({ reason: 'no_letters_or_emoji', sanitized })
  }

  if (!options.skipProfanityCheck) {
    const term = findProfanity(sanitized, options)
    if (term !== undefined) return err({ reason: 'profanity', sanitized, term })
  }

  return ok(sanitized)
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escapes text for interpolation into HTML. Use it for server-rendered markup
 * and for the `og:title` / `og:description` meta tags on a lobby link preview.
 * Do not use it before storing a name, and do not use it in React — both
 * escape already, and escaping twice is visible to the player.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string)
}
