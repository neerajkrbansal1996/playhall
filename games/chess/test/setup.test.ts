import { afterEach, describe, expect, it, vi } from 'vitest'
import { asSeatId } from '../src/sdk/contract.js'
import { chessSettingsSchema } from '../src/settings/schema.js'
import { colorOf, setup, turnOf } from '../src/state.js'
import { ctx, GUEST, HOST } from './helpers.js'

function start(color: 'white' | 'black' | 'random', rng: () => number) {
  return setup(
    {
      hostSeatId: HOST,
      guestSeatId: GUEST,
      settings: chessSettingsSchema.parse({ color }),
    },
    ctx({ rng }),
  )
}

const never = () => {
  throw new Error('rng must not be consumed for an explicit colour choice')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('colour assignment', () => {
  it('puts the host on White when they ask for White', () => {
    const game = start('white', never)
    expect(colorOf(game, HOST)).toBe('w')
    expect(colorOf(game, GUEST)).toBe('b')
  })

  it('puts the host on Black when they ask for Black', () => {
    const game = start('black', never)
    expect(colorOf(game, HOST)).toBe('b')
    expect(colorOf(game, GUEST)).toBe('w')
  })

  it('does not consume a draw from the rng for an explicit choice', () => {
    // `never` throws if called; reaching this line proves it was not.
    expect(() => start('white', never)).not.toThrow()
    expect(() => start('black', never)).not.toThrow()
  })

  it('gives the host White on a low rng draw', () => {
    expect(colorOf(start('random', () => 0.0), HOST)).toBe('w')
    expect(colorOf(start('random', () => 0.499), HOST)).toBe('w')
  })

  it('gives the host Black on a high rng draw', () => {
    expect(colorOf(start('random', () => 0.5), HOST)).toBe('b')
    expect(colorOf(start('random', () => 0.999), HOST)).toBe('b')
  })

  it('is deterministic — the same seed sequence gives the same colours', () => {
    const seeded = () => {
      const draws = [0.73, 0.12, 0.91]
      let index = 0
      return () => draws[index++ % draws.length] as number
    }
    const first = start('random', seeded())
    const second = start('random', seeded())
    expect(first.colors).toEqual(second.colors)
  })

  it('never reads Math.random', () => {
    // The determinism lens, enforced at runtime as well as by the lint rule: a
    // match replayed from its stored seed must reproduce the same colours.
    const spy = vi.spyOn(Math, 'random')
    start('random', () => 0.25)
    start('random', () => 0.75)
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns null for a seat that is not playing', () => {
    expect(colorOf(start('white', never), asSeatId('seat-elsewhere'))).toBeNull()
  })
})

describe('a fresh match', () => {
  it('starts from the standard position with White to move', () => {
    const game = start('white', never)
    expect(game.moves).toEqual([])
    expect(game.phase).toBe('awaiting_first_move')
    expect(game.ending).toBeNull()
    expect(turnOf(game)).toBe('w')
  })

  it('records the start time from ctx.now, not the wall clock', () => {
    const game = setup(
      { hostSeatId: HOST, guestSeatId: GUEST },
      ctx({ now: 1_700_000_000_000, rng: () => 0.1 }),
    )
    expect(game.startedAt).toBe(1_700_000_000_000)
    expect(game.lastMoveAt).toBeNull()
  })

  it('falls back to the default settings when none are supplied', () => {
    const game = setup({ hostSeatId: HOST, guestSeatId: GUEST }, ctx({ rng: () => 0.1 }))
    expect(game.settings.takebacks).toBe(false)
    expect(game.settings.autoQueen).toBe(false)
  })
})
