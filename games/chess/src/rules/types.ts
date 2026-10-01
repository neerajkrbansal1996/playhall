import type { SeatId } from '../sdk/contract.js'

/** chess.js colour codes. `w` is White. */
export type Color = 'w' | 'b'

export const WHITE = 'w' satisfies Color
export const BLACK = 'b' satisfies Color

export function opponent(color: Color): Color {
  return color === 'w' ? 'b' : 'w'
}

/** Promotion targets. A pawn may never promote to a king or stay a pawn. */
export type PromotionPiece = 'q' | 'r' | 'b' | 'n'

/**
 * A move as the client proposes it.
 *
 * Coordinates, not SAN: the server decides legality, and `from`/`to` cannot be
 * ambiguous the way a hand-typed SAN string can. Keyboard entry ("Nf3") is
 * parsed to coordinates before it reaches the reducer — see `parseMoveInput`.
 */
export interface MoveInput {
  readonly from: string
  readonly to: string
  readonly promotion?: PromotionPiece
}

/**
 * Every way a chess game can end.
 *
 * `abort` is deliberately in this union even though it records no result: the
 * match still has to reach a terminal state, and the result layer is what turns
 * it into `reason: 'aborted'` with `unrecordedStandings()` (ADR-0006 §1).
 */
export type ChessEnding =
  // --- decided over the board ---
  | { readonly reason: 'checkmate'; readonly winner: Color }
  | { readonly reason: 'stalemate' }
  | { readonly reason: 'insufficient_material' }
  // --- claimed or automatic draws ---
  | { readonly reason: 'threefold_repetition'; readonly claimedBy: Color | null }
  | { readonly reason: 'fivefold_repetition' }
  | { readonly reason: 'fifty_move_rule'; readonly claimedBy: Color | null }
  | { readonly reason: 'seventy_five_move_rule' }
  // --- decided by the players ---
  | { readonly reason: 'resignation'; readonly winner: Color }
  | { readonly reason: 'draw_agreement' }
  // --- decided by the clock ---
  | { readonly reason: 'timeout'; readonly winner: Color }
  /** The flagged side lost on time, but the other side cannot mate: FIDE 6.9 draw. */
  | { readonly reason: 'timeout_vs_insufficient_material'; readonly flagged: Color }
  // --- decided by disconnection ---
  | { readonly reason: 'abandonment'; readonly winner: Color }
  | { readonly reason: 'abandonment_draw' }
  // --- not a result ---
  | { readonly reason: 'abort'; readonly cause: 'agreed' | 'first_move_timeout' }

export type EndingReason = ChessEnding['reason']

/**
 * A draw the side to move may claim right now.
 *
 * FIDE draws split into claimable (threefold, 50-move) and automatic (fivefold,
 * 75-move). Auto-drawing on the third repetition is a real bug for a player who
 * is repeating to gain time on the clock, so the claim stays explicit.
 */
export type DrawClaim = 'threefold_repetition' | 'fifty_move_rule'

/** Which player sits on which colour. Assigned once, at setup, from `ctx.rng`. */
export interface ColorAssignment {
  readonly w: SeatId
  readonly b: SeatId
}
