import { describe, expect, it } from 'vitest'
import { asSeatId } from '../src/sdk/contract.js'
import { getResult } from '../src/result.js'
import { applyAction, canAbort, firstMoveDeadline, FIRST_MOVE_TIMEOUT_MS } from '../src/state.js'
import { ctx, newGame, playMoves, seatOf } from './helpers.js'

describe('resignation', () => {
  it('hands the win to the opponent', () => {
    const game = playMoves(newGame(), ['e4', 'e5'])
    const result = applyAction(game, { type: 'resign' }, seatOf(game, 'w'), ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.ending).toEqual({ reason: 'resignation', winner: 'b' })
    expect(getResult(result.state)).toEqual({
      reason: 'resignation',
      standings: [
        { seatId: seatOf(game, 'b'), rank: 1, score: 1, outcome: 'win' },
        { seatId: seatOf(game, 'w'), rank: 2, score: 0, outcome: 'loss' },
      ],
      detail: {
        chessReason: 'resignation',
        description: 'White resigned',
        moves: 2,
        recorded: true,
      },
    })
  })

  it('can be done on the opponent’s turn', () => {
    const game = playMoves(newGame(), ['e4'])
    const result = applyAction(game, { type: 'resign' }, seatOf(game, 'b'), ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.ending).toEqual({ reason: 'resignation', winner: 'w' })
  })

  it('is refused from a seat that is not in the game', () => {
    const game = newGame()
    expect(applyAction(game, { type: 'resign' }, asSeatId('seat-stranger'), ctx())).toEqual({
      ok: false,
      error: 'not_a_player',
    })
  })

  it('is refused once the game is over', () => {
    const game = playMoves(newGame(), ['f3', 'e5', 'g4', 'Qh4'])
    expect(applyAction(game, { type: 'resign' }, seatOf(game, 'w'), ctx())).toEqual({
      ok: false,
      error: 'game_over',
    })
  })
})

describe('draw by agreement', () => {
  const offered = () => {
    const game = playMoves(newGame(), ['e4', 'e5'])
    const result = applyAction(game, { type: 'offer_draw' }, seatOf(game, 'w'), ctx())
    if (!result.ok) throw new Error(result.error)
    return result.state
  }

  it('draws when the opponent accepts', () => {
    const state = offered()
    const accepted = applyAction(state, { type: 'accept_draw' }, seatOf(state, 'b'), ctx())
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(accepted.state.ending).toEqual({ reason: 'draw_agreement' })
    expect(getResult(accepted.state)?.reason).toBe('agreed_draw')
    expect(getResult(accepted.state)?.detail?.description).toBe('Draw by agreement')
  })

  it('keeps playing when the opponent declines', () => {
    const state = offered()
    const declined = applyAction(state, { type: 'decline_draw' }, seatOf(state, 'b'), ctx())
    expect(declined.ok).toBe(true)
    if (!declined.ok) return
    expect(declined.state.drawOffer).toBeNull()
    expect(declined.state.ending).toBeNull()
  })

  it('does not let the offering player accept their own offer', () => {
    const state = offered()
    expect(applyAction(state, { type: 'accept_draw' }, seatOf(state, 'w'), ctx())).toEqual({
      ok: false,
      error: 'no_draw_offer',
    })
  })

  it('allows only one pending offer at a time', () => {
    const state = offered()
    expect(applyAction(state, { type: 'offer_draw' }, seatOf(state, 'b'), ctx())).toEqual({
      ok: false,
      error: 'draw_offer_pending',
    })
  })

  it('cannot be accepted when nothing was offered', () => {
    const game = playMoves(newGame(), ['e4', 'e5'])
    expect(applyAction(game, { type: 'accept_draw' }, seatOf(game, 'b'), ctx())).toEqual({
      ok: false,
      error: 'no_draw_offer',
    })
  })

  it('cannot be declined when nothing was offered', () => {
    const game = playMoves(newGame(), ['e4', 'e5'])
    expect(applyAction(game, { type: 'decline_draw' }, seatOf(game, 'b'), ctx())).toEqual({
      ok: false,
      error: 'no_draw_offer',
    })
  })

  it('does not let the offering player decline their own offer', () => {
    const state = offered()
    expect(applyAction(state, { type: 'decline_draw' }, seatOf(state, 'w'), ctx())).toEqual({
      ok: false,
      error: 'no_draw_offer',
    })
  })

  it('withdraws a standing offer as soon as a move is played', () => {
    const state = offered()
    const moved = playMoves(state, ['Nf3'])
    expect(moved.drawOffer).toBeNull()
  })

  it('rate-limits repeat offers until the offering side has had another turn', () => {
    const state = offered()
    const declined = applyAction(state, { type: 'decline_draw' }, seatOf(state, 'b'), ctx())
    if (!declined.ok) throw new Error(declined.error)

    // Immediately re-offering is refused.
    expect(applyAction(declined.state, { type: 'offer_draw' }, seatOf(state, 'w'), ctx())).toEqual({
      ok: false,
      error: 'draw_offer_cooldown',
    })

    // After both sides move, the offer is allowed again.
    const later = playMoves(declined.state, ['Nf3', 'Nc6'])
    expect(applyAction(later, { type: 'offer_draw' }, seatOf(state, 'w'), ctx()).ok).toBe(true)
  })
})

describe('abort', () => {
  it('is allowed before anyone has moved', () => {
    const game = newGame()
    expect(canAbort(game)).toBe(true)
    const result = applyAction(game, { type: 'abort' }, seatOf(game, 'b'), ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.ending).toEqual({ reason: 'abort', cause: 'agreed' })
  })

  it('is still allowed after only White has moved', () => {
    const game = playMoves(newGame(), ['e4'])
    expect(canAbort(game)).toBe(true)
    expect(applyAction(game, { type: 'abort' }, seatOf(game, 'w'), ctx()).ok).toBe(true)
  })

  it('is refused once both players have moved', () => {
    const game = playMoves(newGame(), ['e4', 'e5'])
    expect(canAbort(game)).toBe(false)
    expect(applyAction(game, { type: 'abort' }, seatOf(game, 'w'), ctx())).toEqual({
      ok: false,
      error: 'abort_not_allowed',
    })
  })

  it('records NO result', () => {
    const game = newGame()
    const result = applyAction(game, { type: 'abort' }, seatOf(game, 'w'), ctx())
    if (!result.ok) throw new Error(result.error)
    expect(getResult(result.state)).toEqual({
      reason: 'aborted',
      // No seat won, lost or drew it, and `recorded: false` says so out loud.
      standings: [],
      detail: {
        chessReason: 'abort',
        description: 'Aborted before both players moved',
        moves: 0,
        recorded: false,
      },
    })
  })
})

describe('the 30-second first move', () => {
  it('sets the deadline 30 s after the match starts', () => {
    const game = newGame({ now: 1_000 })
    expect(firstMoveDeadline(game)).toBe(1_000 + FIRST_MOVE_TIMEOUT_MS)
  })

  it('refuses to abort before the deadline', () => {
    const game = newGame({ now: 0 })
    expect(applyAction(game, { type: 'first_move_timeout' }, null, ctx({ now: 29_999 }))).toEqual({
      ok: false,
      error: 'first_move_deadline_not_reached',
    })
  })

  it('aborts once the deadline passes', () => {
    const game = newGame({ now: 0 })
    const result = applyAction(game, { type: 'first_move_timeout' }, null, ctx({ now: 30_000 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.ending).toEqual({ reason: 'abort', cause: 'first_move_timeout' })
    expect(getResult(result.state)).toEqual({
      reason: 'aborted',
      standings: [],
      detail: {
        chessReason: 'abort',
        description: 'Aborted — no first move within 30 seconds',
        moves: 0,
        recorded: false,
      },
    })
  })

  it('restarts the window for Black once White has moved', () => {
    const game = playMoves(newGame({ now: 0 }), ['e4'], 5_000)
    expect(firstMoveDeadline(game)).toBe(5_000 + FIRST_MOVE_TIMEOUT_MS)
    expect(applyAction(game, { type: 'first_move_timeout' }, null, ctx({ now: 34_999 }))).toEqual({
      ok: false,
      error: 'first_move_deadline_not_reached',
    })
    expect(applyAction(game, { type: 'first_move_timeout' }, null, ctx({ now: 35_000 })).ok).toBe(
      true,
    )
  })

  it('stops applying once both players have moved', () => {
    const game = playMoves(newGame({ now: 0 }), ['e4', 'e5'], 5_000)
    expect(firstMoveDeadline(game)).toBeNull()
    expect(applyAction(game, { type: 'first_move_timeout' }, null, ctx({ now: 999_999 }))).toEqual({
      ok: false,
      error: 'abort_not_allowed',
    })
  })
})

describe('abandonment', () => {
  it('gives the win to the player who claims it', () => {
    const game = playMoves(newGame(), ['e4', 'e5'])
    const result = applyAction(
      game,
      { type: 'claim_abandonment', outcome: 'win' },
      seatOf(game, 'w'),
      ctx(),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.ending).toEqual({ reason: 'abandonment', winner: 'w' })
    expect(getResult(result.state)?.reason).toBe('disconnect_forfeit')
    expect(getResult(result.state)?.detail?.description).toBe('Black abandoned the game')
    // The seat that walked away is recorded as `abandoned`, not a plain loss.
    expect(getResult(result.state)?.standings[1]?.outcome).toBe('abandoned')
  })

  it('draws when the claimant asks for a draw instead', () => {
    const game = playMoves(newGame(), ['e4', 'e5'])
    const result = applyAction(
      game,
      { type: 'claim_abandonment', outcome: 'draw' },
      seatOf(game, 'b'),
      ctx(),
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.state.ending).toEqual({ reason: 'abandonment_draw' })
    expect(getResult(result.state)?.standings.every((s) => s.outcome === 'draw')).toBe(true)
  })

  it('is refused from a seat that is not in the game', () => {
    const game = playMoves(newGame(), ['e4', 'e5'])
    expect(
      applyAction(game, { type: 'claim_abandonment', outcome: 'win' }, asSeatId('nobody'), ctx()),
    ).toEqual({ ok: false, error: 'not_a_player' })
  })
})

describe('illegal input is rejected server-side', () => {
  it('rejects a move that is not legal in the position', () => {
    const game = newGame()
    expect(
      applyAction(game, { type: 'move', move: { from: 'e2', to: 'e5' } }, seatOf(game, 'w'), ctx()),
    ).toEqual({ ok: false, error: 'illegal_move' })
  })

  it('rejects a move from an empty square', () => {
    const game = newGame()
    expect(
      applyAction(game, { type: 'move', move: { from: 'e4', to: 'e5' } }, seatOf(game, 'w'), ctx()),
    ).toEqual({ ok: false, error: 'illegal_move' })
  })

  it('rejects a move made out of turn', () => {
    const game = newGame()
    expect(
      applyAction(game, { type: 'move', move: { from: 'e7', to: 'e5' } }, seatOf(game, 'b'), ctx()),
    ).toEqual({ ok: false, error: 'not_your_turn' })
  })

  it('rejects moving the opponent’s piece on your own turn', () => {
    const game = newGame()
    expect(
      applyAction(game, { type: 'move', move: { from: 'e7', to: 'e5' } }, seatOf(game, 'w'), ctx()),
    ).toEqual({ ok: false, error: 'illegal_move' })
  })

  it('rejects a move that leaves the king in check', () => {
    // The f3 knight is pinned: the bishop on b7 rakes b7-f3-h1, where the king sits.
    const game = newGame({ fen: '4k3/1b6/8/8/8/5N2/8/7K w - - 0 1' })
    expect(
      applyAction(game, { type: 'move', move: { from: 'f3', to: 'd4' } }, seatOf(game, 'w'), ctx()),
    ).toEqual({ ok: false, error: 'illegal_move' })
  })

  it('rejects any action from a non-player seat', () => {
    const game = newGame()
    expect(
      applyAction(
        game,
        { type: 'move', move: { from: 'e2', to: 'e4' } },
        asSeatId('seat-spectator'),
        ctx(),
      ),
    ).toEqual({ ok: false, error: 'not_a_player' })
  })
})
