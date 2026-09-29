import { opponent, type ChessEnding, type Color, type ColorAssignment } from './rules/types.js'
import {
  SCORE,
  type MatchResult,
  type ResultReason,
  type SeatOutcome,
  type Standing,
} from './sdk/contract.js'
import type { ChessMatchState } from './state.js'

/** PGN result tokens. */
export type ScoreLine = '1-0' | '0-1' | '1/2-1/2' | '*'

const COLOR_NAME: Record<Color, string> = { w: 'White', b: 'Black' }

interface Verdict {
  /** The SDK's coarse reason. The exact chess reason travels in `detail`. */
  readonly reason: ResultReason
  /** Winning colour, `null` for a draw, `undefined` when nothing is recorded. */
  readonly winner: Color | null | undefined
  readonly description: string
  /** What the losing seat is recorded as. Differs for a player who walked away. */
  readonly loserOutcome: SeatOutcome
}

/**
 * Turn an ending into a verdict.
 *
 * Every arm of `ChessEnding` is handled explicitly, so adding an end condition
 * without deciding its result is a type error rather than a silent `*`.
 *
 * `ResultReason` is the platform's seven-value vocabulary, shared by every game;
 * it deliberately cannot express "fivefold repetition". The chess-specific
 * reason code goes in `detail` where the result panel and the match log can
 * read it without the platform having to know any chess.
 */
function verdictOf(ending: ChessEnding): Verdict {
  switch (ending.reason) {
    case 'checkmate':
      return {
        reason: 'completed',
        winner: ending.winner,
        description: `${COLOR_NAME[ending.winner]} wins by checkmate`,
        loserOutcome: 'loss',
      }
    case 'resignation':
      return {
        reason: 'resignation',
        winner: ending.winner,
        description: `${COLOR_NAME[opponent(ending.winner)]} resigned`,
        loserOutcome: 'loss',
      }
    case 'timeout':
      return {
        reason: 'timeout',
        winner: ending.winner,
        description: `${COLOR_NAME[opponent(ending.winner)]} ran out of time`,
        loserOutcome: 'loss',
      }
    case 'abandonment':
      return {
        reason: 'disconnect_forfeit',
        winner: ending.winner,
        description: `${COLOR_NAME[opponent(ending.winner)]} abandoned the game`,
        loserOutcome: 'abandoned',
      }

    case 'stalemate':
      return draw('completed', 'Draw by stalemate')
    case 'insufficient_material':
      return draw('completed', 'Draw by insufficient material')
    case 'threefold_repetition':
      return draw('completed', 'Draw by threefold repetition')
    case 'fivefold_repetition':
      return draw('completed', 'Draw by fivefold repetition')
    case 'fifty_move_rule':
      return draw('completed', 'Draw by the fifty-move rule')
    case 'seventy_five_move_rule':
      return draw('completed', 'Draw by the seventy-five-move rule')
    case 'draw_agreement':
      return draw('agreed_draw', 'Draw by agreement')
    case 'abandonment_draw':
      return draw('disconnect_forfeit', 'Draw claimed after the opponent left')
    case 'timeout_vs_insufficient_material':
      return draw(
        'timeout',
        `${COLOR_NAME[ending.flagged]} ran out of time, but ${COLOR_NAME[opponent(ending.flagged)]} cannot checkmate`,
      )

    case 'abort':
      return {
        reason: 'aborted',
        winner: undefined,
        description:
          ending.cause === 'first_move_timeout'
            ? 'Aborted — no first move within 30 seconds'
            : 'Aborted before both players moved',
        loserOutcome: 'loss',
      }
  }
}

function draw(reason: ResultReason, description: string): Verdict {
  return { reason, winner: null, description, loserOutcome: 'draw' }
}

function standingsFor(
  colors: ColorAssignment,
  winner: Color | null,
  loserOutcome: SeatOutcome,
): readonly Standing[] {
  if (winner === null) {
    // A draw is a shared first place, not a two-way second.
    return [
      { seatId: colors.w, rank: 1, outcome: 'draw', score: SCORE.draw },
      { seatId: colors.b, rank: 1, outcome: 'draw', score: SCORE.draw },
    ]
  }
  return [
    { seatId: colors[winner], rank: 1, outcome: 'win', score: SCORE.win },
    { seatId: colors[opponent(winner)], rank: 2, outcome: loserOutcome, score: SCORE.loss },
  ]
}

/**
 * The match result, or `null` while the game is still running.
 *
 * Non-null is the platform's only signal that the match is over, so this must
 * stay `null` for a claimable-but-unclaimed threefold or fifty-move position.
 *
 * An abort returns `reason: 'aborted'` with **empty standings**: the match must
 * not be recorded, and no seat won, lost or drew it. `detail.recorded` says so
 * explicitly for anything reading the match log.
 */
export function getResult(state: ChessMatchState): MatchResult | null {
  if (state.ending === null) return null

  const { reason, winner, description, loserOutcome } = verdictOf(state.ending)
  const aborted = winner === undefined

  return {
    reason,
    standings: aborted ? [] : standingsFor(state.colors, winner, loserOutcome),
    detail: {
      chessReason: state.ending.reason,
      description,
      moves: state.moves.length,
      recorded: !aborted,
    },
  }
}

/** The PGN result token for a match: `*` while unfinished or aborted. */
export function scoreLine(state: ChessMatchState): ScoreLine {
  if (state.ending === null) return '*'
  const { winner } = verdictOf(state.ending)
  if (winner === undefined) return '*'
  if (winner === null) return '1/2-1/2'
  return winner === 'w' ? '1-0' : '0-1'
}

/** Short termination phrase for the PGN `Termination` header and the UI banner. */
export function terminationText(ending: ChessEnding): string {
  return verdictOf(ending).description
}
