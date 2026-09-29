/**
 * TEMPORARY local shim for `@atrium/game-sdk`.
 *
 * `packages/game-sdk` does not exist yet (PER-10 is still in progress), but the
 * chess rules do not depend on the SDK's *implementation* — only on the shape of
 * the context and the result it hands back. This file declares exactly that
 * surface, and nothing else, so the rules can be written and tested now.
 *
 * When PER-10 lands, the fix is one edit per import site: delete this file and
 * point the imports at `@atrium/game-sdk`. Everything here is type-only except
 * `SCORE`, so there is no runtime coupling to unwind.
 *
 * The surface below is also the concrete ADR request to the CTO: these are the
 * five things chess needs from the SDK.
 */

/** Stable identifier for a seat in the match. The platform owns seat assignment. */
export type SeatId = string

/**
 * Who is asking for a view. Chess has no hidden information, but spectators must
 * still not see a player's pending draw offer, so the viewer is always gated.
 */
export type Viewer =
  | { readonly kind: 'player'; readonly seatId: SeatId }
  | { readonly kind: 'spectator' }

/**
 * Everything a game module is allowed to read from the outside world.
 *
 * `now` and `rng` exist precisely so a game module never calls `Date.now()` or
 * `Math.random()`. `rng` is seeded server-side and the seed is stored on the
 * match, so a replay produces the same colour assignment.
 */
export interface GameContext {
  /** Server-authoritative wall clock, in milliseconds since the epoch. */
  readonly now: number
  /** Seeded PRNG returning a float in [0, 1). Deterministic per match. */
  readonly rng: () => number
}

/** Per-seat outcome in the platform's standard standings shape. */
export interface Standing {
  readonly seatId: SeatId
  /** 1-based. Both seats rank 1 on a draw. */
  readonly rank: number
  /** Chess scoring: 1 for a win, 0.5 for a draw, 0 for a loss. */
  readonly score: number
  readonly outcome: 'win' | 'loss' | 'draw'
}

/** Canonical chess scores, so the result and the PGN never disagree. */
export const SCORE = { win: 1, draw: 0.5, loss: 0 } as const

/**
 * The platform's standard result shape.
 *
 * `status: 'no_result'` with empty standings is how a game says "this match did
 * not happen" — chess uses it for an abort, which must not be recorded.
 */
export interface GameResult {
  readonly status: 'decisive' | 'draw' | 'no_result'
  /** Machine-readable outcome reason, e.g. `checkmate`, `timeout_vs_insufficient_material`. */
  readonly reasonCode: string
  /** Human-readable one-liner for the result banner and the match log. */
  readonly reason: string
  readonly standings: readonly Standing[]
}

/** A portable record of a finished match, for replay and download. */
export interface GameRecord {
  readonly format: string
  readonly mimeType: string
  readonly filename: string
  readonly content: string
}
