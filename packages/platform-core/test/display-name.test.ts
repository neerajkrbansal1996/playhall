import { describe, expect, it } from 'vitest'
import {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MAX_RAW_LENGTH,
  displayNameLength,
  escapeHtml,
  sanitizeDisplayName,
  validateDisplayName,
} from '../src/identity/display-name.js'
import { findProfanity, foldForProfanity, isProfane } from '../src/identity/profanity.js'
import { initialsFor } from '../src/identity/avatar.js'

/**
 * Non-ASCII inputs are written as `\u` escapes throughout. A zero-width space
 * and a soft hyphen are invisible in a diff and in a review, and a test whose
 * input you cannot see is a test you cannot trust.
 */
const ZWSP = '\u200B'
const ZWJ = '\u200D'
const BOM = '\uFEFF'
const SOFT_HYPHEN = '\u00AD'
const RTL_OVERRIDE = '\u202E'
const LTR_ISOLATE = '\u2066'

function reject(raw: string): { reason: string; term?: string } {
  const result = validateDisplayName(raw)
  if (result.ok) throw new Error(`expected rejection, got "${result.value}"`)
  return result.error
}

function accept(raw: string): string {
  const result = validateDisplayName(raw)
  if (!result.ok) throw new Error(`expected acceptance, got ${result.error.reason}`)
  return result.value
}

describe('sanitizeDisplayName', () => {
  it('collapses whitespace runs and trims', () => {
    expect(sanitizeDisplayName('  Ada   \t\n Lovelace  ')).toBe('Ada Lovelace')
  })

  it('strips zero-width and other invisible formatting characters', () => {
    expect(sanitizeDisplayName(`Ad${ZWSP}a${ZWJ} Lo${BOM}velace`)).toBe('Ada Lovelace')
    expect(sanitizeDisplayName(`soft${SOFT_HYPHEN}hyphen`)).toBe('softhyphen')
  })

  it('applies NFKC so lookalike forms converge on one name', () => {
    // Fullwidth latin and the fi ligature both normalise, so two players cannot
    // take names that render identically but compare unequal.
    expect(sanitizeDisplayName('Ａda')).toBe('Ada')
    expect(sanitizeDisplayName('ﬁnn')).toBe('finn')
  })

  it('is idempotent', () => {
    const once = sanitizeDisplayName(`  Ｏ${ZWJ}tter \t Ace `)
    expect(once).toBe('Otter Ace')
    expect(sanitizeDisplayName(once)).toBe(once)
  })
})

describe('displayNameLength', () => {
  it('counts code points, not UTF-16 units', () => {
    expect('\u{1F642}\u{1F642}'.length).toBe(4)
    expect(displayNameLength('\u{1F642}\u{1F642}')).toBe(2)
  })
})

describe('validateDisplayName — accepts', () => {
  it.each([
    ['Ada', 'Ada'],
    ['  Swift Otter  ', 'Swift Otter'],
    ["O'Brien", "O'Brien"],
    ['Ben & Jerry', 'Ben & Jerry'],
    ['René Müller', 'René Müller'],
    ['さくら', 'さくら'],
    ['P1', 'P1'],
    ['\u{1F642}\u{1F642}', '\u{1F642}\u{1F642}'],
    ['Scunthorpe', 'Scunthorpe'],
    ['A'.repeat(DISPLAY_NAME_MAX_LENGTH), 'A'.repeat(DISPLAY_NAME_MAX_LENGTH)],
  ])('accepts %j as %j', (raw, expected) => {
    expect(accept(raw)).toBe(expected)
  })

  it('keeps ampersands and quotes as plain text rather than entities', () => {
    // Storing escaped text double-escapes downstream and makes the length limit
    // lie. Escaping is a render-time concern; see escapeHtml.
    expect(accept('Ben & Jerry')).toBe('Ben & Jerry')
    expect(accept('Ben & Jerry')).not.toContain('&amp;')
  })
})

describe('validateDisplayName — rejects', () => {
  it('rejects raw input over the hard cap before doing any work', () => {
    expect(reject('a'.repeat(DISPLAY_NAME_MAX_RAW_LENGTH + 1)).reason).toBe('too_long_raw')
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    [`${ZWSP}${ZWSP}`, 'empty'],
    ['A', 'too_short'],
    [' x ', 'too_short'],
    [`A${ZWSP}${ZWSP}${ZWSP}`, 'too_short'],
    ['A'.repeat(DISPLAY_NAME_MAX_LENGTH + 1), 'too_long'],
    ['\u{1F642}'.repeat(DISPLAY_NAME_MAX_LENGTH + 1), 'too_long'],
    ['<script>alert(1)</script>', 'invalid_characters'],
    ['a<b', 'invalid_characters'],
    ['a>b', 'invalid_characters'],
    ['ab\u0007cd', 'invalid_characters'],
    [`ab${RTL_OVERRIDE}cd`, 'invalid_characters'],
    [`ab${LTR_ISOLATE}cd`, 'invalid_characters'],
    ['...', 'no_letters_or_emoji'],
    // `=` is a math symbol, not punctuation, so "reject anything that is all
    // punctuation" would have let this through.
    ['-=-', 'no_letters_or_emoji'],
  ])('rejects %j with %s', (raw, reason) => {
    expect(reject(raw).reason).toBe(reason)
  })

  it('accepts an emoji-only name but not a punctuation-only one', () => {
    // Emoji are how a lot of players on a phone actually name themselves;
    // punctuation soup is not a name anyone can refer to out loud.
    expect(accept('\u{1F642}\u{1F642}')).toBe('\u{1F642}\u{1F642}')
    expect(reject('!?!').reason).toBe('no_letters_or_emoji')
  })

  it('accepts a flag, which is regional indicators rather than a pictograph', () => {
    // `\p{Extended_Pictographic}` is false for U+1F1E6..U+1F1FF, so a flag was
    // the one emoji this module was calling punctuation.
    expect(accept('\u{1F1EC}\u{1F1E7}')).toBe('\u{1F1EC}\u{1F1E7}')
  })

  it('every name it accepts can produce an avatar initial', () => {
    // The two modules share `NAME_CONTENT_PATTERN` precisely so this holds. If
    // they drift, a name the sanitiser admits renders a latin letter derived
    // from the guest id — a letter the player never typed.
    for (const name of [
      '\u{1F642}\u{1F642}',
      '\u{1F642} \u{1F642}',
      '\u{1F1EC}\u{1F1E7}',
      '\u{1F44D}\u{1F3FD} Ada',
      'Ada Lovelace',
      '中文',
      '42',
    ]) {
      expect(validateDisplayName(name).ok, name).toBe(true)
      expect(initialsFor(name), name).not.toBe('')
    }
  })

  it('refuses markup rather than escaping it into the stored name', () => {
    // The alternative — accepting and escaping — leaves "&lt;b&gt;" sitting in
    // a seat chip the moment some render path forgets to unescape.
    expect(reject('<b>Ada</b>').reason).toBe('invalid_characters')
  })
})

describe('validateDisplayName — profanity screen', () => {
  it('rejects a plain slur and reports the matched term', () => {
    const rejection = reject('shit lord')
    expect(rejection.reason).toBe('profanity')
    expect(rejection.term).toBe('shit')
  })

  it.each([
    ['upper case', 'SHIT'],
    ['spaced out', 's h i t'],
    ['leet digits', 'sh1t'],
    ['leet symbols', '$hit'],
    ['fullwidth', 'ｓｈｉｔ'],
    ['diacritics', 'shít'],
    ['punctuated', 's.h.i.t'],
  ])('sees through evasion: %s', (_label, raw) => {
    expect(validateDisplayName(raw).ok).toBe(false)
  })

  it('does not fire on innocent names that contain a blocked substring', () => {
    for (const name of ['Scunthorpe', 'Peacock', 'Dickens', 'Analyst', 'Titan', 'Essex']) {
      expect(validateDisplayName(name).ok, name).toBe(true)
    }
  })

  it('applies the allowlist per word, so a surname plus a first name still passes', () => {
    // Folding the whole name first concatenates across the space, which made
    // the exact-match allowlist unreachable the moment a second word appeared
    // while the substring blocklist kept firing. "Emily Dickinson" folded to
    // `emilydickinson`, which is not `dickinson`, so it was rejected for
    // "dick". Every one of these was a measured rejection before the fix.
    for (const name of [
      'Emily Dickinson',
      'Scunthorpe United',
      'Peacock Jim',
      'Analyst Ann',
      'Grape Ape',
    ]) {
      expect(validateDisplayName(name).ok, name).toBe(true)
    }
  })

  it('still catches a blocked term inside a single unallowlisted word', () => {
    // The allowlist is exact-match per word on purpose: "shuttlecock" is a
    // badminton shuttle, "cockfaceshuttlecock" is not a place in Lincolnshire.
    expect(validateDisplayName('cockfaceshuttlecock').ok).toBe(false)
    expect(findProfanity('cockfaceshuttlecock')).toBe('cock')
  })

  it('still catches a term written across a space', () => {
    // Per-word screening alone would miss this, which is why the whole-name
    // pass still runs — over the words the allowlist did not clear.
    expect(validateDisplayName('Fu ck').ok).toBe(false)
    expect(validateDisplayName('Shuttlecock fu ck').ok).toBe(false)
    expect(validateDisplayName('Pea Cock').ok).toBe(false)
  })

  it('takes extra terms from config so Product can tune without a release', () => {
    expect(validateDisplayName('Admin Bot', { extraTerms: ['adminbot'] }).ok).toBe(false)
    expect(validateDisplayName('Admin Bot').ok).toBe(true)
  })

  it('takes an extra allowlist entry', () => {
    expect(validateDisplayName('Cockfosters').ok).toBe(false)
    expect(validateDisplayName('Cockfosters', { extraAllowed: ['Cockfosters'] }).ok).toBe(true)
  })

  it('a one-word allowlist entry does not clear the same letters spread over two', () => {
    // Otherwise "peacock" on the list lets "Pea Cock" through, which is the
    // evasion the per-word screen exists to catch.
    expect(validateDisplayName('Pea Cock').ok).toBe(false)
    expect(validateDisplayName('Pea Cock', { extraAllowed: ['peacock'] }).ok).toBe(false)
    // A phrase entry is how an operator permits it deliberately.
    expect(validateDisplayName('Pea Cock', { extraAllowed: ['Pea Cock'] }).ok).toBe(true)
  })

  it('can be skipped for internally generated names', () => {
    expect(validateDisplayName('shit', { skipProfanityCheck: true }).ok).toBe(true)
  })
})

describe('profanity helpers', () => {
  it('folds diacritics, leet and punctuation onto the blocklist form', () => {
    expect(foldForProfanity('F.Ü.C.K')).toBe('fuck')
    expect(foldForProfanity('$h1t')).toBe('shit')
  })

  it('returns undefined when nothing folds to a letter', () => {
    expect(findProfanity('123')).toBeUndefined()
  })

  it('isProfane mirrors findProfanity', () => {
    expect(isProfane('shit')).toBe(true)
    expect(isProfane('Ada')).toBe(false)
  })
})

describe('escapeHtml', () => {
  it('escapes every character that can open markup or break out of an attribute', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
    )
  })

  it('renders an accepted name safely for a link preview meta tag', () => {
    expect(escapeHtml(accept('Ben & Jerry'))).toBe('Ben &amp; Jerry')
  })

  it('leaves text with no special characters untouched', () => {
    expect(escapeHtml('Swift Otter')).toBe('Swift Otter')
  })
})
