import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'

import { parseMoveInput, tryMove } from '../src/rules/position.js'

/**
 * Guards the `PieceSymbol` -> `PromotionPiece` narrowing in `position.ts`.
 *
 * chess.js types `Move.promotion` as the whole piece alphabet, including 'p' and
 * 'k'. `MoveInput.promotion` is the narrower q/r/b/n. `asPromotion` narrows
 * through a guard rather than a cast, so these tests exist to prove the guard
 * preserves every legal promotion instead of quietly dropping one — a cast would
 * have type-checked while letting a malformed value through.
 */

/** White pawn on e7, both kings clear of the promotion square. */
const PROMOTION_FEN = '8/4P3/8/8/8/8/8/K6k w - - 0 1'

/** White pawn on b7, black rook on a8 and c8: quiet push or either capture. */
const PROMOTION_CAPTURE_FEN = 'r1r5/1P6/8/8/8/8/8/K6k w - - 0 1'

describe('parseMoveInput promotion narrowing', () => {
  it.each([
    ['q', 'e8=Q'],
    ['r', 'e8=R'],
    ['b', 'e8=B'],
    ['n', 'e8=N'],
  ] as const)('keeps a long-algebraic promotion to %s', (piece, san) => {
    const parsed = parseMoveInput(new Chess(PROMOTION_FEN), `e7e8${piece}`)

    expect(parsed).toEqual({ from: 'e7', to: 'e8', promotion: piece })
    // The parsed input must still produce the SAN a player would expect.
    expect(tryMove(new Chess(PROMOTION_FEN), parsed!)).toBe(san)
  })

  it.each([
    ['e8=Q', 'q'],
    ['e8=R', 'r'],
    ['e8=B', 'b'],
    ['e8=N', 'n'],
  ] as const)('keeps a SAN promotion %s', (san, piece) => {
    const parsed = parseMoveInput(new Chess(PROMOTION_FEN), san)

    expect(parsed).toEqual({ from: 'e7', to: 'e8', promotion: piece })
    expect(tryMove(new Chess(PROMOTION_FEN), parsed!)).toBe(san)
  })

  it('keeps the promotion piece on a capture-promotion', () => {
    const parsed = parseMoveInput(new Chess(PROMOTION_CAPTURE_FEN), 'b7a8n')

    expect(parsed).toEqual({ from: 'b7', to: 'a8', promotion: 'n' })
    expect(tryMove(new Chess(PROMOTION_CAPTURE_FEN), parsed!)).toBe('bxa8=N')
  })

  it('does not attach a promotion to an ordinary move', () => {
    const parsed = parseMoveInput(new Chess(), 'e4')

    expect(parsed).toEqual({ from: 'e2', to: 'e4' })
    expect(parsed).not.toHaveProperty('promotion')
  })

  it('rejects a promotion to pawn or king, which chess.js would type as valid', () => {
    // 'p' and 'k' live in chess.js's PieceSymbol but are not legal promotions.
    // The coordinate regex never admits them, so these resolve to null rather
    // than to a move carrying an out-of-range promotion.
    expect(parseMoveInput(new Chess(PROMOTION_FEN), 'e7e8p')).toBeNull()
    expect(parseMoveInput(new Chess(PROMOTION_FEN), 'e7e8k')).toBeNull()
    expect(parseMoveInput(new Chess(PROMOTION_FEN), 'e8=P')).toBeNull()
    expect(parseMoveInput(new Chess(PROMOTION_FEN), 'e8=K')).toBeNull()
  })

  it('rejects a promotion push that is not legal in the position', () => {
    // No pawn on d7, so there is nothing to promote.
    expect(parseMoveInput(new Chess(PROMOTION_FEN), 'd7d8q')).toBeNull()
  })
})

/**
 * A bare from/to pair on a promoting push names four legal moves, not one.
 *
 * Before the fix the coordinate branch took the first legal move whose from/to
 * matched, and chess.js lists promotions n, b, r, q — so "e7e8" underpromoted
 * to a knight with no signal to the player. Rejecting instead forces the caller
 * (keyboard entry, or a drag-and-drop client whose promotion picker did not
 * open) to ask which piece.
 */
describe('parseMoveInput on a bare coordinate promotion', () => {
  it('rejects a quiet promotion push with no promotion piece', () => {
    expect(parseMoveInput(new Chess(PROMOTION_FEN), 'e7e8')).toBeNull()
  })

  it('rejects a capture-promotion with no promotion piece', () => {
    expect(parseMoveInput(new Chess(PROMOTION_CAPTURE_FEN), 'b7a8')).toBeNull()
  })

  it('still resolves the same pushes once the piece is given', () => {
    // The rejection is about the missing piece, not about the squares: the very
    // same inputs with a letter appended resolve normally.
    expect(parseMoveInput(new Chess(PROMOTION_FEN), 'e7e8q')).toEqual({
      from: 'e7',
      to: 'e8',
      promotion: 'q',
    })
    expect(parseMoveInput(new Chess(PROMOTION_CAPTURE_FEN), 'b7a8q')).toEqual({
      from: 'b7',
      to: 'a8',
      promotion: 'q',
    })
  })

  it('leaves a non-promoting coordinate move unaffected', () => {
    // The from/to pair is unambiguous here, so no promotion letter is needed.
    expect(parseMoveInput(new Chess(), 'e2e4')).toEqual({ from: 'e2', to: 'e4' })
    expect(parseMoveInput(new Chess(), 'g1f3')).toEqual({ from: 'g1', to: 'f3' })
    expect(parseMoveInput(new Chess(), 'e4')).toEqual({ from: 'e2', to: 'e4' })
  })

  it('leaves a pawn push to the last rank by a non-pawn unaffected', () => {
    // A rook reaching the eighth rank is one move, not four: the "exactly one
    // candidate" rule must not reject ordinary traffic into the back rank.
    const rookToEighth = '7k/8/8/8/8/8/8/K5R1 w - - 0 1'

    expect(parseMoveInput(new Chess(rookToEighth), 'g1g8')).toEqual({ from: 'g1', to: 'g8' })
  })
})
