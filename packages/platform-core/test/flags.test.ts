import { describe, expect, it } from 'vitest'
import { PLATFORM_FLAGS, createFeatureFlags, flagOverridesFromEnv } from '../src/flags.js'

describe('defaults', () => {
  it('keeps public room listing off', () => {
    expect(PLATFORM_FLAGS.publicRoomListing).toBe(false)
    expect(createFeatureFlags().isEnabled('publicRoomListing')).toBe(false)
  })

  it('enables an unknown game by default, so adding a game needs no flag edit', () => {
    expect(createFeatureFlags().isGameEnabled('brand-new')).toBe(true)
  })
})

describe('overrides', () => {
  it('applies a platform override', () => {
    const flags = createFeatureFlags({ platform: { publicRoomListing: true } })
    expect(flags.isEnabled('publicRoomListing')).toBe(true)
    expect(flags.snapshot().publicRoomListing).toBe(true)
  })

  it('applies a per-game override', () => {
    const flags = createFeatureFlags({ games: { chess: false } })
    expect(flags.isGameEnabled('chess')).toBe(false)
    expect(flags.isGameEnabled('tic-tac-toe')).toBe(true)
  })

  it('throws on an unknown flag rather than defaulting it to false', () => {
    expect(() => createFeatureFlags({ platform: { nope: true } as never })).toThrow(RangeError)
    expect(() => createFeatureFlags().isEnabled('nope' as never)).toThrow(RangeError)
  })

  it('returns a frozen snapshot', () => {
    expect(Object.isFrozen(createFeatureFlags().snapshot())).toBe(true)
  })
})

describe('env parsing', () => {
  it('reads platform flags in screaming snake case', () => {
    const overrides = flagOverridesFromEnv({ PLAYHALL_FLAG_PUBLIC_ROOM_LISTING: 'true' })
    expect(overrides.platform).toEqual({ publicRoomListing: true })
  })

  it('reads per-game flags and converts the key back to a slug', () => {
    const overrides = flagOverridesFromEnv({ PLAYHALL_GAME_TIC_TAC_TOE: '0' })
    expect(overrides.games).toEqual({ 'tic-tac-toe': false })
  })

  it('accepts the usual truthy spellings and treats everything else as false', () => {
    for (const value of ['1', 'true', 'TRUE', ' on ', 'yes']) {
      expect(flagOverridesFromEnv({ PLAYHALL_FLAG_REMATCH: value }).platform?.rematch).toBe(true)
    }
    for (const value of ['0', 'false', '', 'maybe']) {
      expect(flagOverridesFromEnv({ PLAYHALL_FLAG_REMATCH: value }).platform?.rematch).toBe(false)
    }
  })

  it('ignores unrelated environment variables', () => {
    const overrides = flagOverridesFromEnv({ PATH: '/usr/bin', NODE_ENV: 'test' })
    expect(overrides.platform).toEqual({})
    expect(overrides.games).toEqual({})
  })

  it('round-trips into a usable flag set', () => {
    const flags = createFeatureFlags(
      flagOverridesFromEnv({ PLAYHALL_FLAG_PUBLIC_ROOM_LISTING: '1', PLAYHALL_GAME_CHESS: 'no' }),
    )
    expect(flags.isEnabled('publicRoomListing')).toBe(true)
    expect(flags.isGameEnabled('chess')).toBe(false)
  })
})
