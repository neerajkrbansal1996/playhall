import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import { tryMove } from '../src/rules/position.js'
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

  // One move, one wire spelling. chess.js silently drops a `promotion` letter on
  // a move that cannot promote, which would give every ordinary move a second
  // accepted spelling that `getLegalActions` never lists — precisely the
  // disagreement the conformance suite's `legal-actions-agree` check exists to
  // catch. The disagreement is latent, not observed: the chess subject probes the
  // a7-a8 rook lift at every state and the suite still passes 11/11 without the
  // guard at 96 playouts, because random play almost never reaches a position
  // where that spelling is legal. These cases are the pin the gate cannot be
  // relied on to provide. The stored position was never wrong; the accepted input
  // set was.
  describe.each([
    // A pawn one rank short of promoting. The near miss, and the reason a
    // "harmless" reading is tempting.
    { label: 'a pawn push that is one rank short', fen: '4k3/8/P7/8/8/8/8/4K3 w - - 0 1', from: 'a6', to: 'a7' },
    // A rook reaching the eighth rank: the exact input the gate caught.
    { label: 'a rook lift to the eighth rank', fen: '4k3/R7/8/8/8/8/8/4K3 w - - 0 1', from: 'a7', to: 'a8' },
    // A knight move, where a promotion letter is pure nonsense.
    { label: 'a knight move', fen: '4k3/8/8/8/8/8/8/4K1N1 w - - 0 1', from: 'g1', to: 'f3' },
  ])('rejects a promotion piece attached to $label', ({ fen, from, to }) => {
    it('is an illegal move, and the clean spelling still plays', () => {
      const game = newGame({ fen })
      const seat = seatOf(game, 'w')
      expect(applyAction(game, { type: 'move', move: { from, to, promotion: 'q' } }, seat, ctx())).toEqual({
        ok: false,
        error: 'illegal_move',
      })

      // The move itself is legal — only the spurious letter was rejected.
      const clean = applyAction(game, { type: 'move', move: { from, to } }, seat, ctx())
      expect(clean.ok).toBe(true)
    })
  })

  it('leaves the position untouched when it rejects the spurious letter', () => {
    // `tryMove` applies the move to its replayed board before it can see that the
    // promotion letter was meaningless, so it has to undo. If it did not, a
    // rejected action could still leave a mutated board behind for any caller
    // that reads the instance after a `null`.
    const board = new Chess('4k3/R7/8/8/8/8/8/4K3 w - - 0 1')
    const before = board.fen()
    expect(tryMove(board, { from: 'a7', to: 'a8', promotion: 'q' })).toBeNull()
    expect(board.fen()).toBe(before)
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
