import { describe, expect, it } from 'vitest'
import { getViewFor } from '../src/view.js'
import { applyAction } from '../src/state.js'
import { asSeatId } from '../src/sdk/contract.js'
import { ctx, GUEST, HOST, newGame, playMoves, seatOf } from './helpers.js'

const asWhite = { kind: 'seat', seatId: HOST } as const
const asBlack = { kind: 'seat', seatId: GUEST } as const
const asSpectator = { kind: 'spectator' } as const

describe('getViewFor — redaction', () => {
  const withOffer = () => {
    const game = playMoves(newGame(), ['e4', 'e5'])
    const result = applyAction(game, { type: 'offer_draw' }, seatOf(game, 'w'), ctx())
    if (!result.ok) throw new Error(result.error)
    return result.state
  }

  it('shows a pending draw offer to the player who made it', () => {
    expect(getViewFor(withOffer(), asWhite).drawOffer).toEqual({ by: 'w', isYours: true })
  })

  it('shows a pending draw offer to the player who must answer it', () => {
    expect(getViewFor(withOffer(), asBlack).drawOffer).toEqual({ by: 'w', isYours: false })
  })

  it('HIDES a pending draw offer from spectators', () => {
    // Chess has no hidden information on the board, but an offer is still
    // private to the two players — a spectator must not see it coming.
    expect(getViewFor(withOffer(), asSpectator).drawOffer).toBeNull()
  })

  it('hides a pending draw offer from a seat that is not in the game', () => {
    const stranger = { kind: 'seat', seatId: asSeatId('seat-stranger') } as const
    expect(getViewFor(withOffer(), stranger).drawOffer).toBeNull()
  })
})

describe('getViewFor — legal move hints', () => {
  it('gives hints to the player whose turn it is', () => {
    const view = getViewFor(newGame(), asWhite)
    expect(view.legalMoves['e2']).toContain('e4')
    expect(Object.keys(view.legalMoves).length).toBe(10) // 8 pawns + 2 knights
  })

  it('gives no hints to the player who is waiting', () => {
    expect(getViewFor(newGame(), asBlack).legalMoves).toEqual({})
  })

  it('gives no hints to spectators', () => {
    expect(getViewFor(newGame(), asSpectator).legalMoves).toEqual({})
  })

  it('gives no hints once the game is finished', () => {
    const mated = playMoves(newGame(), ['f3', 'e5', 'g4', 'Qh4'])
    expect(getViewFor(mated, asBlack).legalMoves).toEqual({})
  })

  it('never offers a claim to the player who is not to move', () => {
    const shuffled = playMoves(newGame(), ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'])
    expect(getViewFor(shuffled, asWhite).availableDrawClaims).toEqual(['threefold_repetition'])
    expect(getViewFor(shuffled, asBlack).availableDrawClaims).toEqual([])
    expect(getViewFor(shuffled, asSpectator).availableDrawClaims).toEqual([])
  })
})

describe('getViewFor — board state', () => {
  it('orients the board by telling each viewer their own colour', () => {
    expect(getViewFor(newGame(), asWhite).yourColor).toBe('w')
    expect(getViewFor(newGame(), asBlack).yourColor).toBe('b')
    expect(getViewFor(newGame(), asSpectator).yourColor).toBeNull()
  })

  it('reports the last move for highlighting', () => {
    const game = playMoves(newGame(), ['e4', 'e5', 'Nf3'])
    expect(getViewFor(game, asBlack).lastMove).toEqual({ from: 'g1', to: 'f3' })
  })

  it('reports check', () => {
    const game = playMoves(newGame(), ['e4', 'f5', 'Qh5'])
    expect(getViewFor(game, asBlack).inCheck).toBe(true)
  })

  it('reports the SAN move list for the move panel', () => {
    const game = playMoves(newGame(), ['e4', 'e5', 'Nf3'])
    expect(getViewFor(game, asSpectator).moves).toEqual(['e4', 'e5', 'Nf3'])
  })

  it('reports captured pieces and the material difference', () => {
    // 1. e4 d5 2. exd5 Qxd5 — one pawn each, so material is level again.
    const even = playMoves(newGame(), ['e4', 'd5', 'exd5', 'Qxd5'])
    const view = getViewFor(even, asWhite)
    expect(view.capturedPieces).toEqual({ w: ['p'], b: ['p'] })
    expect(view.materialDifference).toBe(0)

    // Now Black is a queen up for nothing.
    const uneven = playMoves(newGame({ fen: '4k3/8/8/8/8/8/8/q3K3 w - - 0 1' }), [])
    expect(getViewFor(uneven, asWhite).materialDifference).toBe(-9)
  })

  it('surfaces the abort affordance only to players, and only while it applies', () => {
    expect(getViewFor(newGame(), asWhite).canAbort).toBe(true)
    expect(getViewFor(newGame(), asSpectator).canAbort).toBe(false)
    expect(getViewFor(playMoves(newGame(), ['e4', 'e5']), asWhite).canAbort).toBe(false)
  })

  it('carries the finished result for the result banner', () => {
    const mated = playMoves(newGame(), ['f3', 'e5', 'g4', 'Qh4'])
    const view = getViewFor(mated, asSpectator)
    expect(view.phase).toBe('finished')
    expect(view.result?.reason).toBe('completed')
    expect(view.result?.detail?.description).toBe('Black wins by checkmate')
  })

  it('carries no result while the game is still running', () => {
    expect(getViewFor(newGame(), asWhite).result).toBeNull()
  })
})
