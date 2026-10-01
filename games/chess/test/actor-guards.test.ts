import { describe, expect, it } from 'vitest'
import { asSeatId } from '../src/sdk/contract.js'
import { applyAction, FIRST_MOVE_TIMEOUT_MS } from '../src/state.js'
import { ctx, newGame, playMoves, seatOf } from './helpers.js'

/**
 * The actor shape is a security boundary, not a convention.
 *
 * `flag` and `first_move_timeout` are raised by the platform clock and carry no
 * actor; every other action is raised by a seat and must carry one. The reducer
 * has no clock and no presence state, so for `flag` in particular the actor
 * shape is the *only* thing standing between a modified client and an instant
 * win. These tests pin that refusal so a runner which forwards a client action
 * envelope straight into `applyAction` cannot decide a game.
 */
describe('server-raised actions refuse an actor', () => {
  it('refuses a flag that came from the seat it would benefit', () => {
    const game = playMoves(newGame(), ['e4'])
    // A modified client sends `{ type: 'flag', color: 'b' }` at move 1.
    expect(applyAction(game, { type: 'flag', color: 'b' }, seatOf(game, 'w'), ctx())).toEqual({
      ok: false,
      error: 'not_a_player',
    })
  })

  it('refuses a flag from the seat it would lose, too', () => {
    // Not just self-serving flags: a seat may not raise one at all.
    const game = newGame()
    expect(applyAction(game, { type: 'flag', color: 'b' }, seatOf(game, 'b'), ctx())).toEqual({
      ok: false,
      error: 'not_a_player',
    })
  })

  it('refuses a flag from a seat that is not in the game', () => {
    const game = newGame()
    expect(
      applyAction(game, { type: 'flag', color: 'w' }, asSeatId('seat-spectator'), ctx()),
    ).toEqual({ ok: false, error: 'not_a_player' })
  })

  it('still accepts a flag the server raised', () => {
    const game = playMoves(newGame(), ['e4'])
    const result = applyAction(game, { type: 'flag', color: 'b' }, null, ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.ending).toEqual({ reason: 'timeout', winner: 'w' })
  })

  it('refuses a first_move_timeout from a seat even after the deadline', () => {
    const game = newGame({ now: 0 })
    const late = ctx({ now: FIRST_MOVE_TIMEOUT_MS })
    // The deadline really has passed — the refusal is about the actor, not timing.
    expect(applyAction(game, { type: 'first_move_timeout' }, null, late).ok).toBe(true)
    expect(applyAction(game, { type: 'first_move_timeout' }, seatOf(game, 'b'), late)).toEqual({
      ok: false,
      error: 'not_a_player',
    })
  })
})

describe('seat-raised actions refuse a missing actor', () => {
  it('refuses an abandonment claim the server raised on nobody’s behalf', () => {
    // There is no server-raised form: an abandonment win is attributed to a
    // colour, so a claim with no seat has no colour to award it to.
    const game = playMoves(newGame(), ['e4', 'e5'])
    expect(applyAction(game, { type: 'claim_abandonment', outcome: 'win' }, null, ctx())).toEqual({
      ok: false,
      error: 'not_a_player',
    })
  })

  it('refuses a resignation with no actor', () => {
    const game = newGame()
    expect(applyAction(game, { type: 'resign' }, null, ctx())).toEqual({
      ok: false,
      error: 'not_a_player',
    })
  })
})

describe('an abandonment win is decided by material, not by the claimant', () => {
  // White has a lone king; Black has a queen and has walked away.
  const LONE_WHITE_KING = '4k3/8/8/8/8/8/q7/4K3 w - - 0 1'

  it('refuses a win claim from a side that cannot mate', () => {
    const game = newGame({ fen: LONE_WHITE_KING })
    expect(
      applyAction(game, { type: 'claim_abandonment', outcome: 'win' }, seatOf(game, 'w'), ctx()),
    ).toEqual({ ok: false, error: 'claim_unavailable' })
  })

  it('lets that same side claim a draw instead', () => {
    const game = newGame({ fen: LONE_WHITE_KING })
    const result = applyAction(
      game,
      { type: 'claim_abandonment', outcome: 'draw' },
      seatOf(game, 'w'),
      ctx(),
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.state.ending).toEqual({ reason: 'abandonment_draw' })
  })

  it('still awards the win to a claimant who can mate', () => {
    const game = newGame({ fen: LONE_WHITE_KING })
    const result = applyAction(
      game,
      { type: 'claim_abandonment', outcome: 'win' },
      seatOf(game, 'b'),
      ctx(),
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.state.ending).toEqual({ reason: 'abandonment', winner: 'b' })
  })

  it('applies the FIDE 6.9 material test, not a crude piece count', () => {
    // King and a single knight cannot mate, so no win is available.
    const game = newGame({ fen: '4k3/8/8/8/8/8/q7/3NK3 w - - 0 1' })
    expect(
      applyAction(game, { type: 'claim_abandonment', outcome: 'win' }, seatOf(game, 'w'), ctx()),
    ).toEqual({ ok: false, error: 'claim_unavailable' })

    // Two knights can, even though mate cannot be forced.
    const twoKnights = newGame({ fen: '4k3/8/8/8/8/8/q7/1N1NK3 w - - 0 1' })
    const result = applyAction(
      twoKnights,
      { type: 'claim_abandonment', outcome: 'win' },
      seatOf(twoKnights, 'w'),
      ctx(),
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.state.ending).toEqual({ reason: 'abandonment', winner: 'w' })
  })
})
