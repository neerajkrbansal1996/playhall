import { describe, expect, it } from 'vitest'

import * as shared from '../src/index.js'

/**
 * The barrel is the package's published surface. Pinning it here does two things:
 * a re-export that stops resolving fails loudly instead of at a consumer's build,
 * and the barrel itself gets executed under coverage — an unimported barrel reads
 * as 0% and drags the package under its own threshold without anything being
 * genuinely untested.
 */
describe('@playhall/shared public surface', () => {
  it('exports exactly the documented runtime values', () => {
    expect(Object.keys(shared).sort()).toEqual([
      'APPROVED_NAME',
      'BRAND',
      'INTERNAL_CODENAME',
      'ROOM_CODE_ALPHABET',
      'ROOM_CODE_LENGTH',
      'buildHealthPayload',
      'healthHttpStatus',
      'isValidRoomCode',
      'normalizeRoomCode',
    ])
  })

  it('re-exports the room-code helpers as callable functions', () => {
    expect(shared.normalizeRoomCode('ab2')).toBe('AB2')
    expect(
      shared.isValidRoomCode(shared.ROOM_CODE_ALPHABET.slice(0, shared.ROOM_CODE_LENGTH)),
    ).toBe(true)
  })

  it('re-exports the health helpers as callable functions', () => {
    expect(typeof shared.buildHealthPayload).toBe('function')
    expect(typeof shared.healthHttpStatus).toBe('function')
  })

  it('re-exports a resolved brand, never a factory', () => {
    expect(typeof shared.BRAND.name).toBe('string')
    expect(shared.BRAND.name.length).toBeGreaterThan(0)
  })
})
