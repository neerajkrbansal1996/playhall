/**
 * Match results.
 *
 * `getResult(state)` returning non-null is the single definition of "the match
 * is over". The platform does not infer it from an event, a timer or a phase
 * name, because those differ per game and the lobby, the result panel, the
 * rematch flow and persistence all need one answer.
 */

import type { SeatId } from './ids.js'
import type { JsonObject } from './json.js'

export type SeatOutcome = 'win' | 'loss' | 'draw' | 'eliminated' | 'forfeit' | 'abandoned'

export interface Standing {
  readonly seatId: SeatId
  /** 1-based. Ties share a rank (1, 1, 3), so a draw is representable. */
  readonly rank: number
  readonly outcome: SeatOutcome
  /** Game-defined points, if the game scores. Higher is better. */
  readonly score?: number
  /** Game-specific extras for the result panel, e.g. `{ moves: 41 }`. JSON-safe. */
  readonly detail?: JsonObject
}

export const RESULT_REASONS = [
  'completed',
  'resignation',
  'timeout',
  'disconnect_forfeit',
  'agreed_draw',
  /** Everyone left; no winner is recorded. */
  'abandoned',
  /** Ended before it counted, e.g. a seat never filled. Not a loss for anyone. */
  'aborted',
] as const

export type ResultReason = (typeof RESULT_REASONS)[number]

export interface MatchResult {
  readonly reason: ResultReason
  /** One entry per seat in the match, including seats that forfeited. */
  readonly standings: readonly Standing[]
  readonly detail?: JsonObject
}

/** Convenience for the common two-outcome case. */
export function standingsFromWinners(
  allSeatIds: readonly SeatId[],
  winnerSeatIds: readonly SeatId[],
): Standing[] {
  return allSeatIds.map((seatId) => {
    const won = winnerSeatIds.includes(seatId)
    return { seatId, rank: won ? 1 : 2, outcome: won ? 'win' : 'loss' }
  })
}

/** Convenience for a draw across every seat. */
export function drawStandings(allSeatIds: readonly SeatId[]): Standing[] {
  return allSeatIds.map((seatId) => ({ seatId, rank: 1, outcome: 'draw' as const }))
}
