import { opponent, type ChessEnding, type Color, type ColorAssignment } from './rules/types.js'
import { SCORE, type GameResult, type Standing } from './sdk/contract.js'
import type { ChessMatchState } from './state.js'

/** PGN result tokens. */
export type ScoreLine = '1-0' | '0-1' | '1/2-1/2' | '*'

const COLOR_NAME: Record<Color, string> = { w: 'White', b: 'Black' }

interface Verdict {
  readonly status: GameResult['status']
  /** Winning colour, or `null` for a draw / no result. */
  readonly winner: Color | null
  readonly reason: string
}

/**
 * Turn an ending into a verdict.
 *
 * Every arm of `ChessEnding` is handled explicitly so that adding an end
 * condition without deciding its result is a type error, not a silent `*`.
 */
function verdictOf(ending: ChessEnding): Verdict {
  switch (ending.reason) {
    case 'checkmate':
      return { status: 'decisive', winner: ending.winner, reason: `${COLOR_NAME[ending.winner]} wins by checkmate` }
    case 'resignation':
      return {
        status: 'decisive',
        winner: ending.winner,
        reason: `${COLOR_NAME[opponent(ending.winner)]} resigned`,
      }
    case 'timeout':
      return {
        status: 'decisive',
        winner: ending.winner,
        reason: `${COLOR_NAME[opponent(ending.winner)]} ran out of time`,
      }
    case 'abandonment':
      return {
        status: 'decisive',
        winner: ending.winner,
        reason: `${COLOR_NAME[opponent(ending.winner)]} abandoned the game`,
      }

    case 'stalemate':
      return { status: 'draw', winner: null, reason: 'Draw by stalemate' }
    case 'insufficient_material':
      return { status: 'draw', winner: null, reason: 'Draw by insufficient material' }
    case 'threefold_repetition':
      return { status: 'draw', winner: null, reason: 'Draw by threefold repetition' }
    case 'fivefold_repetition':
      return { status: 'draw', winner: null, reason: 'Draw by fivefold repetition' }
    case 'fifty_move_rule':
      return { status: 'draw', winner: null, reason: 'Draw by the fifty-move rule' }
    case 'seventy_five_move_rule':
      return { status: 'draw', winner: null, reason: 'Draw by the seventy-five-move rule' }
    case 'draw_agreement':
      return { status: 'draw', winner: null, reason: 'Draw by agreement' }
    case 'abandonment_draw':
      return { status: 'draw', winner: null, reason: 'Draw claimed after the opponent left' }
    case 'timeout_vs_insufficient_material':
      return {
        status: 'draw',
        winner: null,
        reason: `${COLOR_NAME[ending.flagged]} ran out of time, but ${COLOR_NAME[opponent(ending.flagged)]} cannot checkmate`,
      }

    case 'abort':
      return {
        status: 'no_result',
        winner: null,
        reason:
          ending.cause === 'first_move_timeout'
            ? 'Aborted — no first move within 30 seconds'
            : 'Aborted before both players moved',
      }
  }
}

function standingsFor(colors: ColorAssignment, winner: Color | null): readonly Standing[] {
  if (winner === null) {
    // A draw is a shared first place, not a two-way second.
    return [
      { seatId: colors.w, rank: 1, score: SCORE.draw, outcome: 'draw' },
      { seatId: colors.b, rank: 1, score: SCORE.draw, outcome: 'draw' },
    ]
  }
  return [
    { seatId: colors[winner], rank: 1, score: SCORE.win, outcome: 'win' },
    { seatId: colors[opponent(winner)], rank: 2, score: SCORE.loss, outcome: 'loss' },
  ]
}

/**
 * Standings for a finished match, or `null` while it is still running.
 *
 * An abort returns a result with `status: 'no_result'` and **no standings** —
 * the match must not be recorded, and an empty standings list is how that is
 * said in the platform's shape without inventing a fake draw.
 */
export function getResult(state: ChessMatchState): GameResult | null {
  if (state.ending === null) return null

  const { status, winner, reason } = verdictOf(state.ending)

  return {
    status,
    reasonCode: state.ending.reason,
    reason,
    standings: status === 'no_result' ? [] : standingsFor(state.colors, winner),
  }
}

/** The PGN result token for a match, `*` while it is unfinished or aborted. */
export function scoreLine(state: ChessMatchState): ScoreLine {
  if (state.ending === null) return '*'
  const { status, winner } = verdictOf(state.ending)
  if (status === 'no_result') return '*'
  if (winner === null) return '1/2-1/2'
  return winner === 'w' ? '1-0' : '0-1'
}

/** Short termination phrase for the PGN `Termination` header and the UI banner. */
export function terminationText(ending: ChessEnding): string {
  return verdictOf(ending).reason
}
