import { describe, expect, it } from 'vitest'
import { availableDrawClaims, endingAfter } from '../src/rules/endings.js'
import { analyse, START_FEN } from '../src/rules/position.js'
import { getResult } from '../src/result.js'
import { applyAction } from '../src/state.js'
import { ctx, newGame, playMoves, seatOf } from './helpers.js'

/** Repeating the position four times takes eight moves of knight shuffling. */
const SHUFFLE = ['Nf3', 'Nf6', 'Ng1', 'Ng8'] as const

describe('endingAfter — scoring a move list without building a match', () => {
  it('reports no ending for an unfinished game', () => {
    expect(endingAfter(START_FEN, ['e4', 'e5'])).toBeNull()
  })

  it('reports the ending for a finished one', () => {
    expect(endingAfter(START_FEN, ['f3', 'e5', 'g4', 'Qh4#'])).toEqual({
      reason: 'checkmate',
      winner: 'b',
    })
  })
})

describe('checkmate', () => {
  it("ends the game on Fool's Mate", () => {
    const after = playMoves(newGame(), ['f3', 'e5', 'g4', 'Qh4'])
    expect(after.phase).toBe('finished')
    expect(after.ending).toEqual({ reason: 'checkmate', winner: 'b' })
    expect(after.moves.at(-1)).toBe('Qh4#')
  })

  it('ends the game on back-rank mate, with White winning', () => {
    // White rook drops to the eighth rank behind an unmoved pawn shield.
    const after = playMoves(newGame({ fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1' }), ['Ra8'])
    expect(after.ending).toEqual({ reason: 'checkmate', winner: 'w' })
  })

  it('scores checkmate as a decisive result', () => {
    const after = playMoves(newGame(), ['f3', 'e5', 'g4', 'Qh4'])
    expect(getResult(after)).toEqual({
      // `reason` is the platform's shared vocabulary; chess detail rides along.
      reason: 'completed',
      standings: [
        { seatId: seatOf(after, 'b'), rank: 1, score: 1, outcome: 'win' },
        { seatId: seatOf(after, 'w'), rank: 2, score: 0, outcome: 'loss' },
      ],
      detail: {
        chessReason: 'checkmate',
        description: 'Black wins by checkmate',
        moves: 4,
        recorded: true,
      },
    })
  })
})

describe('stalemate', () => {
  it('draws when the side to move has no legal move and is not in check', () => {
    // Black Ka8; White Qc7 takes a7, b7 and b8 without giving check.
    const game = newGame({ fen: 'k7/2Q5/8/8/8/8/8/7K b - - 0 1' })
    expect(analyse(game.initialFen, game.moves).legalMoveCount).toBe(0)
    expect(analyse(game.initialFen, game.moves).inCheck).toBe(false)

    // Reached by a move so the reducer is what detects it.
    const reached = playMoves(newGame({ fen: 'k7/8/2Q5/8/8/8/8/7K w - - 0 1' }), ['Qc7'])
    expect(reached.ending).toEqual({ reason: 'stalemate' })
    expect(getResult(reached)?.standings.every((s) => s.outcome === 'draw')).toBe(true)
  })
})

describe('insufficient material', () => {
  it('draws immediately when the last piece is captured (K vs K)', () => {
    const after = playMoves(newGame({ fen: '4k3/8/8/8/4n3/3K4/8/8 w - - 0 1' }), ['Kxe4'])
    expect(after.ending).toEqual({ reason: 'insufficient_material' })
    expect(getResult(after)?.detail?.description).toBe('Draw by insufficient material')
  })

  it('draws for king and bishop against a lone king', () => {
    const after = playMoves(newGame({ fen: '4k3/8/8/8/4n3/3K1B2/8/8 w - - 0 1' }), ['Kxe4'])
    expect(after.ending).toEqual({ reason: 'insufficient_material' })
  })

  it('does NOT draw for king and rook against a lone king', () => {
    const after = playMoves(newGame({ fen: '4k3/8/8/8/4n3/3K1R2/8/8 w - - 0 1' }), ['Kxe4'])
    expect(after.ending).toBeNull()
  })
})

describe('threefold repetition', () => {
  it('does not fire on the second occurrence', () => {
    const after = playMoves(newGame(), SHUFFLE)
    const position = analyse(after.initialFen, after.moves)
    expect(position.repetitionCount).toBe(2)
    expect(availableDrawClaims(position)).toEqual([])
  })

  it('becomes claimable on the third occurrence', () => {
    const after = playMoves(newGame(), [...SHUFFLE, ...SHUFFLE])
    expect(analyse(after.initialFen, after.moves).repetitionCount).toBe(3)
    expect(availableDrawClaims(analyse(after.initialFen, after.moves))).toEqual([
      'threefold_repetition',
    ])
  })

  it('is NOT applied automatically — a player repeating for time keeps playing', () => {
    const after = playMoves(newGame(), [...SHUFFLE, ...SHUFFLE])
    expect(after.phase).not.toBe('finished')
    expect(after.ending).toBeNull()
  })

  it('draws when the side to move claims it', () => {
    const after = playMoves(newGame(), [...SHUFFLE, ...SHUFFLE])
    const claimed = applyAction(
      after,
      { type: 'claim_draw', claim: 'threefold_repetition' },
      seatOf(after, 'w'),
      ctx(),
    )
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    expect(claimed.state.ending).toEqual({ reason: 'threefold_repetition', claimedBy: 'w' })
    expect(getResult(claimed.state)).toEqual({
      reason: 'completed',
      standings: [
        { seatId: seatOf(after, 'w'), rank: 1, score: 0.5, outcome: 'draw' },
        { seatId: seatOf(after, 'b'), rank: 1, score: 0.5, outcome: 'draw' },
      ],
      detail: {
        chessReason: 'threefold_repetition',
        description: 'Draw by threefold repetition',
        moves: 8,
        recorded: true,
      },
    })
  })

  it('refuses the claim from the player who is not to move', () => {
    const after = playMoves(newGame(), [...SHUFFLE, ...SHUFFLE])
    const claimed = applyAction(
      after,
      { type: 'claim_draw', claim: 'threefold_repetition' },
      seatOf(after, 'b'),
      ctx(),
    )
    expect(claimed).toEqual({ ok: false, error: 'not_your_turn' })
  })

  it('refuses the claim when the position has only repeated twice', () => {
    const after = playMoves(newGame(), SHUFFLE)
    const claimed = applyAction(
      after,
      { type: 'claim_draw', claim: 'threefold_repetition' },
      seatOf(after, 'w'),
      ctx(),
    )
    expect(claimed).toEqual({ ok: false, error: 'claim_unavailable' })
  })

  it('only counts identical positions, not identical move counts', () => {
    // 1. e4 e5 cannot repeat the start position: the pawns cannot go back.
    const after = playMoves(newGame(), ['e4', 'e5', 'Nf3', 'Nf6', 'Ng1', 'Ng8'])
    expect(analyse(after.initialFen, after.moves).repetitionCount).toBe(2)
  })
})

describe('fivefold repetition', () => {
  it('ends the game automatically, with no claim required', () => {
    const after = playMoves(newGame(), [...SHUFFLE, ...SHUFFLE, ...SHUFFLE, ...SHUFFLE])
    expect(after.ending).toEqual({ reason: 'fivefold_repetition' })
    expect(after.phase).toBe('finished')
    expect(getResult(after)?.standings.every((s) => s.outcome === 'draw')).toBe(true)
  })
})

describe('the fifty-move rule', () => {
  // Kings and a rook, with the halfmove clock already wound forward.
  const NEARLY_FIFTY = '7k/8/8/8/8/8/8/R6K w - - 99 60'

  it('becomes claimable when the hundredth ply passes without a capture or pawn move', () => {
    const after = playMoves(newGame({ fen: NEARLY_FIFTY }), ['Ra2'])
    const position = analyse(after.initialFen, after.moves)
    expect(position.halfmoveClock).toBe(100)
    expect(availableDrawClaims(position)).toEqual(['fifty_move_rule'])
    expect(after.ending).toBeNull()
  })

  it('draws when the side to move claims it', () => {
    const after = playMoves(newGame({ fen: NEARLY_FIFTY }), ['Ra2'])
    const claimed = applyAction(
      after,
      { type: 'claim_draw', claim: 'fifty_move_rule' },
      seatOf(after, 'b'),
      ctx(),
    )
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    expect(claimed.state.ending).toEqual({ reason: 'fifty_move_rule', claimedBy: 'b' })
    expect(getResult(claimed.state)?.detail?.description).toBe('Draw by the fifty-move rule')
  })

  it('resets the counter on a pawn move', () => {
    const after = playMoves(newGame({ fen: '7k/8/8/8/8/8/P7/R6K w - - 99 60' }), ['a4'])
    expect(analyse(after.initialFen, after.moves).halfmoveClock).toBe(0)
    expect(availableDrawClaims(analyse(after.initialFen, after.moves))).toEqual([])
  })

  it('resets the counter on a capture', () => {
    const after = playMoves(newGame({ fen: '7k/8/8/8/8/8/r7/R6K w - - 99 60' }), ['Rxa2'])
    expect(analyse(after.initialFen, after.moves).halfmoveClock).toBe(0)
  })
})

describe('the seventy-five-move rule', () => {
  it('ends the game automatically at 150 plies', () => {
    const after = playMoves(newGame({ fen: '7k/8/8/8/8/8/8/R6K w - - 149 90' }), ['Ra2'])
    expect(after.ending).toEqual({ reason: 'seventy_five_move_rule' })
    expect(getResult(after)?.standings.every((s) => s.outcome === 'draw')).toBe(true)
  })

  it('does not override a checkmate delivered on the same move', () => {
    // FIDE 9.6: the automatic draws do not apply if the move is mate.
    const after = playMoves(newGame({ fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 149 90' }), ['Ra8'])
    expect(after.ending).toEqual({ reason: 'checkmate', winner: 'w' })
  })
})
