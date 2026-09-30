/**
 * Match results.
 *
 * `getResult(state)` returning non-null is the single definition of "the match
 * is over". The platform does not infer it from an event, a timer or a phase
 * name, because those differ per game and the lobby, the result panel, the
 * rematch flow and persistence all need one answer.
 *
 * `reason` and `outcome` are independent axes: `reason` says how the match
 * ended, `outcome` says what each seat got. Neither may be derived from the
 * other — chess ends `timeout_vs_insufficient_material` as
 * `reason: 'timeout'` with two draws. The one sanctioned inference is
 * `isRecordedResult`. See ADR-0006.
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

/**
 * The reasons for which the match **did not count**: no seat won, lost or drew,
 * and nothing lands in anyone's history. `standings` is empty for exactly these
 * reasons and non-empty for every other one — see `validateMatchResult`.
 *
 * Whether a result counts is a platform fact about a platform record, so the
 * platform derives it from `reason` (`isRecordedResult`). A game never asserts
 * it, because two sources of truth with no tiebreak is how a player ends up
 * with a phantom win. See ADR-0006.
 */
export const UNRECORDED_RESULT_REASONS = ['aborted', 'abandoned'] as const

export type UnrecordedResultReason = (typeof UNRECORDED_RESULT_REASONS)[number]

export interface MatchResult {
  /** How the match ended. Says nothing about what any seat got — see `Standing.outcome`. */
  readonly reason: ResultReason
  /**
   * One entry per seat in the match, including seats that forfeited — except
   * for an unrecorded reason, where it is empty. Never a partial roster.
   */
  readonly standings: readonly Standing[]
  /**
   * Game-owned extras: JSON-safe, persisted verbatim with the match, returned
   * to clients, and read by **that game's own** `<ResultPanel>`. The platform
   * never reads a key of this object. Because it is persisted and matches are
   * version-pinned, the keys are part of the game module's public surface: a
   * game documents them and changes them only with a record-version bump.
   */
  readonly detail?: JsonObject
}

/**
 * Whether this result counts towards a player's history.
 *
 * The single sanctioned inference between `reason` and `standings`. Callers use
 * this rather than testing `standings.length`, so the partition lives in one
 * place when it changes.
 */
export function isRecordedResult(result: MatchResult): boolean {
  return !(UNRECORDED_RESULT_REASONS as readonly string[]).includes(result.reason)
}

export type MatchResultProblem =
  /** An unrecorded reason with standings, or a recorded one without. */
  | {
      readonly code: 'standings_arity'
      readonly reason: ResultReason
      readonly expected: number
      readonly actual: number
    }
  | { readonly code: 'unknown_seat'; readonly seatId: SeatId }
  | { readonly code: 'duplicate_seat'; readonly seatId: SeatId }
  | { readonly code: 'missing_seat'; readonly seatId: SeatId }
  | { readonly code: 'bad_rank'; readonly seatId: SeatId; readonly rank: number }
  /** Ties share a rank and the next rank skips: 1, 1, 3 — never 1, 1, 2. */
  | {
      readonly code: 'rank_not_competition_ordered'
      readonly rank: number
      readonly expected: number
    }

/**
 * Checks a `MatchResult` against the contract in ADR-0006. Empty means valid.
 *
 * This is what the `result-standings-well-formed` conformance check runs, and
 * what makes "empty standings means the match did not count" distinguishable
 * from "the game forgot to fill standings in".
 */
export function validateMatchResult(
  result: MatchResult,
  seatIds: readonly SeatId[],
): MatchResultProblem[] {
  const problems: MatchResultProblem[] = []
  const expected = isRecordedResult(result) ? seatIds.length : 0

  if (result.standings.length !== expected) {
    problems.push({
      code: 'standings_arity',
      reason: result.reason,
      expected,
      actual: result.standings.length,
    })
  }

  const seen = new Set<SeatId>()
  for (const standing of result.standings) {
    // Repetition first, membership second: a seat that is both repeated and
    // unknown is two distinct problems, and reporting `unknown_seat` twice
    // tells the game author the wrong thing about the second entry.
    if (seen.has(standing.seatId)) {
      problems.push({ code: 'duplicate_seat', seatId: standing.seatId })
    } else if (!seatIds.includes(standing.seatId)) {
      problems.push({ code: 'unknown_seat', seatId: standing.seatId })
    }
    seen.add(standing.seatId)

    if (!Number.isInteger(standing.rank) || standing.rank < 1) {
      problems.push({ code: 'bad_rank', seatId: standing.seatId, rank: standing.rank })
    }
  }

  if (expected > 0) {
    for (const seatId of seatIds) {
      if (!seen.has(seatId)) problems.push({ code: 'missing_seat', seatId })
    }
  }

  // Competition ranking: the nth distinct rank must equal 1 + the number of
  // seats placed above it. This catches 1, 1, 2 and 2, 3 without needing the
  // game to sort its standings.
  const ranks = result.standings
    .map((standing) => standing.rank)
    .filter((rank) => Number.isInteger(rank) && rank >= 1)
    .sort((a, b) => a - b)
  for (let i = 0; i < ranks.length; i += 1) {
    const rank = ranks[i] as number
    if (i > 0 && rank === ranks[i - 1]) continue
    if (rank !== i + 1) {
      problems.push({ code: 'rank_not_competition_ordered', rank, expected: i + 1 })
    }
  }

  return problems
}

/**
 * Standings for a match that did not count: none.
 *
 * Exists so a game states the intent (`unrecordedStandings()`) instead of
 * writing a bare `[]` that reads like an oversight.
 */
export function unrecordedStandings(): readonly Standing[] {
  return []
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
