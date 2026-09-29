import { Chess } from 'chess.js'
import type { Color } from './types.js'

/** A side's material, ignoring the king (which is always present). */
export interface MaterialCount {
  readonly p: number
  readonly n: number
  readonly b: number
  readonly r: number
  readonly q: number
  /** Square colours the side's bishops stand on. */
  readonly bishopSquareColors: ReadonlySet<'light' | 'dark'>
}

export function countMaterial(fen: string, color: Color): MaterialCount {
  const board = new Chess(fen).board()
  const counts = { p: 0, n: 0, b: 0, r: 0, q: 0 }
  const bishopSquareColors = new Set<'light' | 'dark'>()

  for (const [rankIndex, rank] of board.entries()) {
    for (const [fileIndex, square] of rank.entries()) {
      if (!square || square.color !== color) continue
      if (square.type === 'k') continue
      counts[square.type] += 1
      if (square.type === 'b') {
        // board()[0] is rank 8. a8 is a light square, and colour flips with each
        // step in either direction, so parity of (file + rank) decides it.
        bishopSquareColors.add((fileIndex + rankIndex) % 2 === 0 ? 'light' : 'dark')
      }
    }
  }

  return { ...counts, bishopSquareColors }
}

/**
 * Can `color` still deliver checkmate, given only its own material?
 *
 * This is the test behind FIDE 6.9: when a player's clock runs out, they lose
 * *unless* the opponent cannot checkmate them, in which case the game is drawn.
 *
 * The rule is deliberately about mating *at all*, not about mating by force, so
 * two knights count as sufficient — K+N+N vs K cannot be forced but can be
 * reached (for example Black Kh8, White Kh6, Ng6, Nf6 is mate). The cases that
 * genuinely cannot mate a lone king are:
 *
 *  - a bare king,
 *  - king and a single knight,
 *  - king and any number of bishops that all stand on one square colour.
 *
 * Anything else — a pawn, a rook, a queen, two knights, or bishops on both
 * colours — can mate, so the flagging player loses.
 *
 * Note this evaluates one side's material in isolation. That matches how online
 * chess scores a flag and keeps the rule explainable; it is marginally stricter
 * than a full "no legal series of moves leads to mate" search, which would also
 * have to consider helpmates using the *opponent's* pieces.
 */
export function canPossiblyMate(fen: string, color: Color): boolean {
  const { p, n, b, r, q, bishopSquareColors } = countMaterial(fen, color)

  if (p > 0 || r > 0 || q > 0) return true
  if (n >= 2) return true
  if (n === 1 && b >= 1) return true
  if (n === 1) return false
  if (b === 0) return false

  // Bishops only: they can mate if and only if they cover both square colours.
  return bishopSquareColors.size > 1
}

/** Material difference in centipawn-free "pawn units", from White's point of view. */
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 } as const

export function materialDifference(fen: string): number {
  const white = countMaterial(fen, 'w')
  const black = countMaterial(fen, 'b')
  return (Object.keys(PIECE_VALUES) as (keyof typeof PIECE_VALUES)[]).reduce(
    (total, piece) => total + (white[piece] - black[piece]) * PIECE_VALUES[piece],
    0,
  )
}
