import { Chess } from 'chess.js'
import { canPossiblyMate } from './material.js'
import { analyse, type PositionInfo } from './position.js'
import { opponent, type ChessEnding, type Color, type DrawClaim } from './types.js'

/** FIDE 9.6.1: five occurrences of the same position end the game immediately. */
export const FIVEFOLD_REPETITION = 5
/** FIDE 9.2: three occurrences make a draw *claimable* by the side to move. */
export const THREEFOLD_REPETITION = 3
/** FIDE 9.6.2: 75 moves by each side without a capture or pawn move. In plies. */
export const SEVENTY_FIVE_MOVE_PLIES = 150
/** FIDE 9.3: 50 such moves make a draw *claimable*. In plies. */
export const FIFTY_MOVE_PLIES = 100

/**
 * The ending the position itself forces, if any.
 *
 * Only covers endings that need no input from a player. Claimable draws are
 * deliberately excluded — see `availableDrawClaims`.
 *
 * Order matters: checkmate is checked first because FIDE 9.6 makes the
 * automatic draws conditional on the position not already being mate.
 */
export function detectAutomaticEnding(position: PositionInfo): ChessEnding | null {
  const chess = new Chess(position.fen)

  if (chess.isCheckmate()) {
    // The side to move is the side that got mated.
    return { reason: 'checkmate', winner: opponent(position.turn) }
  }
  if (chess.isStalemate()) {
    return { reason: 'stalemate' }
  }
  // "Dead position": neither side has the material to mate, by any continuation.
  if (chess.isInsufficientMaterial()) {
    return { reason: 'insufficient_material' }
  }
  if (position.repetitionCount >= FIVEFOLD_REPETITION) {
    return { reason: 'fivefold_repetition' }
  }
  if (position.halfmoveClock >= SEVENTY_FIVE_MOVE_PLIES) {
    return { reason: 'seventy_five_move_rule' }
  }
  return null
}

/**
 * Draws the side to move may claim right now.
 *
 * These are offered, never applied automatically. A player repeating a position
 * to gain time on the clock must not have the game drawn out from under them.
 */
export function availableDrawClaims(position: PositionInfo): readonly DrawClaim[] {
  const claims: DrawClaim[] = []
  if (position.repetitionCount >= THREEFOLD_REPETITION) claims.push('threefold_repetition')
  if (position.halfmoveClock >= FIFTY_MOVE_PLIES) claims.push('fifty_move_rule')
  return claims
}

/**
 * The ending produced when `flagged` runs out of time.
 *
 * FIDE 6.9: the flagging player loses, *unless* their opponent cannot checkmate
 * them with the material on the board, in which case the game is drawn. Getting
 * this backwards hands a win to a lone king, so it has its own end reason.
 */
export function timeoutEnding(fen: string, flagged: Color): ChessEnding {
  const other = opponent(flagged)
  return canPossiblyMate(fen, other)
    ? { reason: 'timeout', winner: other }
    : { reason: 'timeout_vs_insufficient_material', flagged }
}

/** Convenience wrapper: replay a move list and report any forced ending. */
export function endingAfter(initialFen: string, moves: readonly string[]): ChessEnding | null {
  return detectAutomaticEnding(analyse(initialFen, moves))
}
