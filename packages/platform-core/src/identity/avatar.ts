/**
 * Deterministic guest avatars.
 *
 * No uploads in v1, so an avatar is a pure function of `(guestId, displayName)`
 * — initials on a colour. Two properties matter and both are tested:
 *
 * - **Stable across sessions.** The colour keys off `guestId` alone, never off
 *   the name, so renaming does not repaint a player mid-lobby, and the same
 *   guest looks the same after a reconnect or a server restart.
 * - **Never colour-alone.** The palette is for recognition; the initials carry
 *   the identity. Every pairing clears WCAG 2.1 AA (4.5:1), asserted in the
 *   tests rather than eyeballed.
 *
 * Returning tokens (hex + initials) rather than an SVG string keeps rendering
 * with Frontend, where it belongs, and keeps this package free of markup.
 */

import { NAME_CONTENT_PATTERN } from './display-name.js'

/** FNV-1a, 32-bit. Same mixer the SDK's RNG uses to fold a seed string. */
function hash32(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export interface AvatarColor {
  /** Stable machine name, used in `aria-label` and in tests. */
  readonly name: string
  readonly background: `#${string}`
  readonly foreground: `#${string}`
}

/**
 * Sixteen hues, every one at >= 4.5:1 against white. Ordered by hue so
 * neighbouring seats in a lobby are unlikely to land on adjacent entries.
 */
export const AVATAR_PALETTE: readonly AvatarColor[] = [
  { name: 'crimson', background: '#B91C1C', foreground: '#FFFFFF' },
  { name: 'ember', background: '#C2410C', foreground: '#FFFFFF' },
  { name: 'amber', background: '#A16207', foreground: '#FFFFFF' },
  { name: 'moss', background: '#4D7C0F', foreground: '#FFFFFF' },
  { name: 'forest', background: '#15803D', foreground: '#FFFFFF' },
  { name: 'teal', background: '#0F766E', foreground: '#FFFFFF' },
  { name: 'lagoon', background: '#0E7490', foreground: '#FFFFFF' },
  { name: 'ocean', background: '#0369A1', foreground: '#FFFFFF' },
  { name: 'cobalt', background: '#1D4ED8', foreground: '#FFFFFF' },
  { name: 'indigo', background: '#4338CA', foreground: '#FFFFFF' },
  { name: 'violet', background: '#6D28D9', foreground: '#FFFFFF' },
  { name: 'orchid', background: '#A21CAF', foreground: '#FFFFFF' },
  { name: 'rose', background: '#BE185D', foreground: '#FFFFFF' },
  { name: 'garnet', background: '#9F1239', foreground: '#FFFFFF' },
  { name: 'stone', background: '#57534E', foreground: '#FFFFFF' },
  { name: 'slate', background: '#3F3F46', foreground: '#FFFFFF' },
]

export interface GuestAvatar {
  /**
   * One or two grapheme clusters, already upper-cased. Safe to render as text.
   * A cluster is not a character: "🇬🇧" is one initial and four UTF-16 units.
   */
  readonly initials: string
  readonly color: AvatarColor
  /** Index into `AVATAR_PALETTE`. Persisted nowhere; recompute instead. */
  readonly paletteIndex: number
}

const WORD_SPLIT = /\s+/

/**
 * Grapheme clusters, not code points. `Array.from('🇬🇧')` yields two regional
 * indicators and `Array.from('👍🏽')` splits the skin tone off its base, so
 * taking `[0]` of either renders half an emoji.
 */
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** The first cluster of `word` that `display-name.ts` counts as content. */
function firstContentGrapheme(word: string): string | undefined {
  for (const { segment } of GRAPHEMES.segment(word)) {
    if (NAME_CONTENT_PATTERN.test(segment)) return segment
  }
  return undefined
}

/**
 * First initial of the first word plus first initial of the last word; a single
 * word yields a single initial rather than two, because "AL" for "Alex" reads
 * like two people's initials and "A" does not.
 *
 * An initial is anything `display-name.ts` accepts as content — the two use the
 * same `NAME_CONTENT_PATTERN`. Emoji therefore produce emoji initials: a name
 * the sanitiser deliberately admits ("🙂🙂") must not fall through to the
 * `guestId`-derived latin letter, which would show the player a letter they
 * never typed. Scripts without case (CJK, Devanagari) pass through unchanged —
 * `toUpperCase` is a no-op there, which is correct rather than a gap.
 */
export function initialsFor(displayName: string): string {
  const initials: string[] = []
  for (const word of displayName.split(WORD_SPLIT)) {
    const initial = firstContentGrapheme(word)
    if (initial !== undefined) initials.push(initial)
  }

  if (initials.length === 0) return ''
  const first = initials[0] as string
  if (initials.length === 1) return first.toUpperCase()
  const last = initials[initials.length - 1] as string
  return `${first}${last}`.toUpperCase()
}

/**
 * Builds the avatar. `guestId` alone chooses the colour; `displayName` only
 * chooses the initials.
 *
 * The fallback initial comes from `guestId` rather than a literal "?" so an
 * unnamed guest is still visually distinguishable from every other unnamed
 * guest in the room.
 */
export function avatarFor(guestId: string, displayName: string): GuestAvatar {
  const paletteIndex = hash32(guestId) % AVATAR_PALETTE.length
  const color = AVATAR_PALETTE[paletteIndex] as AvatarColor

  const fromName = initialsFor(displayName)
  const initials =
    fromName.length > 0
      ? fromName
      : // 'A'-'Z' from a second, independent mix of the same id.
        String.fromCharCode(65 + (hash32(`initial:${guestId}`) % 26))

  return { initials, color, paletteIndex }
}

/** WCAG 2.1 relative luminance of an `#RRGGBB` colour. */
export function relativeLuminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** WCAG 2.1 contrast ratio between two `#RRGGBB` colours, 1-21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la]
  return (lighter + 0.05) / (darker + 0.05)
}
