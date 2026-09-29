import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AVATAR_PALETTE,
  avatarFor,
  contrastRatio,
  initialsFor,
  relativeLuminance,
} from '../src/identity/avatar.js'

const WCAG_AA_NORMAL_TEXT = 4.5

describe('AVATAR_PALETTE', () => {
  it('meets WCAG 2.1 AA contrast on every entry', () => {
    // The accessibility target is a number, so assert the number rather than
    // trusting that the hexes were eyeballed once.
    for (const color of AVATAR_PALETTE) {
      const ratio = contrastRatio(color.background, color.foreground)
      expect(ratio, `${color.name} ${color.background}/${color.foreground}`).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT,
      )
    }
  })

  it('has unique names and unique backgrounds', () => {
    expect(new Set(AVATAR_PALETTE.map((c) => c.name)).size).toBe(AVATAR_PALETTE.length)
    expect(new Set(AVATAR_PALETTE.map((c) => c.background)).size).toBe(AVATAR_PALETTE.length)
  })

  it('is not so small that a 12-player room is mostly duplicates', () => {
    expect(AVATAR_PALETTE.length).toBeGreaterThanOrEqual(12)
  })
})

describe('contrast helpers', () => {
  it('matches the WCAG reference values at the extremes', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5)
  })

  it('is symmetric', () => {
    expect(contrastRatio('#B91C1C', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', '#B91C1C'), 10)
  })

  it('computes relative luminance on both sides of the sRGB linearisation knee', () => {
    // #0A is below the 0.03928 threshold (linear branch); #80 is above it.
    expect(relativeLuminance('#0A0A0A')).toBeCloseTo(0.003035, 5)
    expect(relativeLuminance('#808080')).toBeCloseTo(0.21586, 4)
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10)
  })
})

describe('initialsFor', () => {
  it.each([
    ['Ada Lovelace', 'AL'],
    ['Swift Otter', 'SO'],
    ['ada lovelace', 'AL'],
    ['Ada', 'A'],
    ['  Ada   Byron   King  ', 'AK'],
    ["O'Brien", 'O'],
    ['Ben & Jerry', 'BJ'],
    ['P1', 'P'],
    ['さくら', 'さ'],
  ])('%j -> %j', (name, expected) => {
    expect(initialsFor(name)).toBe(expected)
  })

  it('takes the first and last word, not the first two', () => {
    expect(initialsFor('Ada Byron King')).toBe('AK')
  })

  it('skips words made entirely of punctuation', () => {
    expect(initialsFor('Ada -- King')).toBe('AK')
  })

  it('returns empty for a name with nothing to initialise', () => {
    expect(initialsFor('---')).toBe('')
    expect(initialsFor('')).toBe('')
  })
})

describe('avatarFor', () => {
  it('is stable across sessions for the same guestId', () => {
    // The done-criterion for this issue: nothing about a later call can change
    // the avatar a returning guest sees.
    const first = avatarFor('guest-abc', 'Swift Otter')
    for (let i = 0; i < 1000; i += 1) {
      expect(avatarFor('guest-abc', 'Swift Otter')).toEqual(first)
    }
  })

  it('keeps the colour when the guest renames themselves', () => {
    const before = avatarFor('guest-abc', 'Swift Otter')
    const after = avatarFor('guest-abc', 'Something Else Entirely')
    expect(after.color).toEqual(before.color)
    expect(after.paletteIndex).toBe(before.paletteIndex)
    expect(after.initials).not.toBe(before.initials)
  })

  it('gives different guests different colours often enough to be useful', () => {
    const counts = new Map<number, number>()
    for (let i = 0; i < 4096; i += 1) {
      const { paletteIndex } = avatarFor(randomBytes(16).toString('base64url'), 'X Y')
      counts.set(paletteIndex, (counts.get(paletteIndex) ?? 0) + 1)
    }
    // Every colour gets used, and none of them swallows the distribution.
    expect(counts.size).toBe(AVATAR_PALETTE.length)
    const expected = 4096 / AVATAR_PALETTE.length
    for (const [index, count] of counts) {
      expect(count, `palette index ${index}`).toBeGreaterThan(expected * 0.5)
      expect(count, `palette index ${index}`).toBeLessThan(expected * 1.5)
    }
  })

  it('always lands inside the palette', () => {
    for (let i = 0; i < 2000; i += 1) {
      const avatar = avatarFor(randomBytes(16).toString('base64url'), 'A B')
      expect(avatar.paletteIndex).toBeGreaterThanOrEqual(0)
      expect(avatar.paletteIndex).toBeLessThan(AVATAR_PALETTE.length)
      expect(avatar.color).toBe(AVATAR_PALETTE[avatar.paletteIndex])
    }
  })

  it('falls back to a per-guest letter rather than a shared placeholder', () => {
    // Two unnamed guests in the same room must still be distinguishable, so the
    // fallback is derived from the id, not a literal "?".
    const a = avatarFor('guest-aaa', '---')
    const b = avatarFor('guest-bbb', '---')
    expect(a.initials).toMatch(/^[A-Z]$/)
    expect(b.initials).toMatch(/^[A-Z]$/)
    expect(a.initials).not.toBe(b.initials)
  })

  it('never returns empty initials', () => {
    for (const name of ['', '---', '   ', '!!!']) {
      expect(avatarFor('guest-abc', name).initials.length).toBeGreaterThan(0)
    }
  })
})
