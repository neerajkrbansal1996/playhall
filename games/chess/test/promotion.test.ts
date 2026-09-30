import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import { applyAction } from '../src/state.js'
import { ctx, newGame, playMoves, seatOf } from './helpers.js'

/** White pawn on a7, kings out of the way. */
const READY_TO_PROMOTE = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1'
/** White pawn on b7, black rook on a8 — promotion with a capture. */
const CAPTURE_PROMOTE = 'r3k3/1P6/8/8/8/8/8/4K3 w - - 0 1'
/** Black pawn on a2, about to promote on a1. */
const BLACK_PROMOTE = '4k3/8/8/8/8/8/p7/4K3 b - - 0 1'

function pieceAt(state: ReturnType<typeof newGame>, square: string) {
  const board = new Chess(state.initialFen)
  for (const san of state.moves) board.move(san)
  return board.get(square as never)
}

describe('promotion', () => {
  it('promotes to a queen', () => {
    const after = playMoves(newGame({ fen: READY_TO_PROMOTE }), ['a8=Q'])
    expect(after.moves).toEqual(['a8=Q+'])
    expect(pieceAt(after, 'a8')).toEqual({ type: 'q', color: 'w' })
  })

  it('promotes to a rook', () => {
    const after = playMoves(newGame({ fen: READY_TO_PROMOTE }), ['a8=R'])
    expect(pieceAt(after, 'a8')).toEqual({ type: 'r', color: 'w' })
  })

  it('promotes to a bishop', () => {
    const after = playMoves(newGame({ fen: READY_TO_PROMOTE }), ['a8=B'])
    expect(pieceAt(after, 'a8')).toEqual({ type: 'b', color: 'w' })
  })

  it('promotes to a knight (under-promotion)', () => {
    const after = playMoves(newGame({ fen: READY_TO_PROMOTE }), ['a8=N'])
    expect(pieceAt(after, 'a8')).toEqual({ type: 'n', color: 'w' })
  })

  it('promotes while capturing', () => {
    const after = playMoves(newGame({ fen: CAPTURE_PROMOTE }), ['bxa8=Q'])
    // The new queen rakes the eighth rank, so SAN records the check too.
    expect(after.moves).toEqual(['bxa8=Q+'])
    expect(pieceAt(after, 'a8')).toEqual({ type: 'q', color: 'w' })
  })

  it('promotes for Black on the first rank', () => {
    const after = playMoves(newGame({ fen: BLACK_PROMOTE }), ['a1=Q'])
    expect(pieceAt(after, 'a1')).toEqual({ type: 'q', color: 'b' })
  })

  it('accepts long algebraic entry with a promotion suffix', () => {
    const after = playMoves(newGame({ fen: READY_TO_PROMOTE }), ['a7a8n'])
    expect(pieceAt(after, 'a8')).toEqual({ type: 'n', color: 'w' })
  })
})

describe('promotion — the server always requires an explicit piece', () => {
  it('rejects a promotion move that names no piece', () => {
    // `autoQueen` is a *client* preference: it decides whether the UI shows the
    // picker, never what the server accepts. A client that omits the piece gets
    // its move rejected rather than a silently-chosen queen.
    const game = newGame({ fen: READY_TO_PROMOTE })
    const result = applyAction(
      game,
      { type: 'move', move: { from: 'a7', to: 'a8' } },
      seatOf(game, 'w'),
      ctx(),
    )
    expect(result).toEqual({ ok: false, error: 'illegal_move' })
  })

  it('rejects a promotion move that names an impossible piece', () => {
    const game = newGame({ fen: READY_TO_PROMOTE })
    const result = applyAction(
      game,
      // A tampered client; the type says `PromotionPiece`, the wire does not.
      { type: 'move', move: { from: 'a7', to: 'a8', promotion: 'k' as never } },
      seatOf(game, 'w'),
      ctx(),
    )
    expect(result).toEqual({ ok: false, error: 'illegal_move' })
  })

  it('ignores a promotion piece attached to a move that cannot promote', () => {
    // A stray `promotion` on a6-a7 is harmless: chess.js drops it, and the SAN
    // the server records is the plain pawn move, so the stored position is
    // exactly what a6-a7 produces. No pawn is conjured into a queen on rank 7.
    const game = newGame({ fen: '4k3/8/P7/8/8/8/8/4K3 w - - 0 1' })
    const result = applyAction(
      game,
      { type: 'move', move: { from: 'a6', to: 'a7', promotion: 'q' } },
      seatOf(game, 'w'),
      ctx(),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.moves).toEqual(['a7'])
    expect(pieceAt(result.state, 'a7')).toEqual({ type: 'p', color: 'w' })
  })

  it('offers all four promotion pieces to the picker and nothing else', () => {
    const board = new Chess(READY_TO_PROMOTE)
    const promotions = board
      .moves({ verbose: true })
      .filter((move) => move.promotion !== undefined)
      .map((move) => move.promotion)
    expect(new Set(promotions)).toEqual(new Set(['q', 'r', 'b', 'n']))
  })
})
