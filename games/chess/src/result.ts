import { opponent, type ChessEnding, type Color, type ColorAssignment } from './rules/types.js'
import {
  isRecordedResult,
  SCORE,
  unrecordedStandings,
  type MatchResult,
  type ResultReason,
  type SeatOutcome,
  type Standing,
} from './sdk/contract.js'
import type { ChessMatchState } from './state.js'

/** PGN result tokens. */
export type ScoreLine = '1-0' | '0-1' | '1/2-1/2' | '*'

const COLOR_NAME: Record<Color, string> = { w: 'White', b: 'Black' }

interface VerdictBase {
  /** The SDK's coarse reason. The exact chess reason travels in `detail`. */
  readonly reason: ResultReason
  readonly description: string
}

/** An ending that ranks both seats: someone won, or both drew. */
interface RankedVerdict extends VerdictBase {
  /** Winning colour, or `null` for a draw. */
  readonly winner: Color | null
  /** What the losing seat is recorded as. Differs for a player who walked away. */
  readonly loserOutcome: SeatOutcome
}

/**
 * An ending that ranks nobody: the abort arm, and the only one.
 *
 * `loserOutcome` is *absent* here rather than set to a value nothing reads. An
 * abort has no loser, so any value would be dead — and a dead `'loss'` sitting
 * in the abort arm reads like a decision to record one. Splitting the type
 * makes the compiler, not a comment, guarantee that no seat outcome can be
 * derived from a match that did not count (ADR-0006 §1/§2).
 */
interface UnrecordedVerdict extends VerdictBase {
  readonly winner: undefined
}

type Verdict = RankedVerdict | UnrecordedVerdict

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
 * The result for a finished match.
 *
 * Shared by `getResult` and `scoreLine` so the PGN result token and the
 * platform's result can never disagree about whether a match counted.
 *
 * `detail` carries chess's own three keys — `chessReason`, `description` and
 * `moves` — and nothing else. It notably does **not** carry a `recorded` flag:
 * per ADR-0006 §2 a game never authors "did this count". That is a platform
 * fact about a platform record, answered once by `isRecordedResult(result)`,
 * which the SDK derives from `reason`. The keys here are version-pinned public
 * surface; see `games/chess/README.md`.
 */
function resultOf(state: ChessMatchState, ending: ChessEnding): MatchResult {
  const verdict = verdictOf(ending)

  return {
    reason: verdict.reason,
    // `winner === undefined` narrows to the abort arm, which carries no
    // `loserOutcome` to read. Empty standings is the decision ADR-0006 §1
    // sanctions for a match that did not count, not an oversight: no seat won,
    // lost or drew it, so there is nothing to rank.
    standings:
      verdict.winner === undefined
        ? unrecordedStandings()
        : standingsFor(state.colors, verdict.winner, verdict.loserOutcome),
    detail: {
      chessReason: ending.reason,
      description: verdict.description,
      moves: state.moves.length,
    },
  }
}

/**
 * The match result, or `null` while the game is still running.
 *
 * Non-null is the platform's only signal that the match is over, so this must
 * stay `null` for a claimable-but-unclaimed threefold or fifty-move position.
 */
export function getResult(state: ChessMatchState): MatchResult | null {
  if (state.ending === null) return null
  return resultOf(state, state.ending)
}

/**
 * The PGN result token for a match: `*` while unfinished or aborted.
 *
 * Read off the same `MatchResult` the platform gets, so the PGN header and the
 * standings cannot disagree. PGN's `*` is literally "no result", which makes it
 * the token for exactly the matches `isRecordedResult` says did not count —
 * asking the SDK beats re-testing the abort arm here (ADR-0006 §2).
 */
export function scoreLine(state: ChessMatchState): ScoreLine {
  if (state.ending === null) return '*'

  const result = resultOf(state, state.ending)
  if (!isRecordedResult(result)) return '*'

  const winner = result.standings.find((standing) => standing.outcome === 'win')
  if (winner === undefined) return '1/2-1/2'
  return winner.seatId === state.colors.w ? '1-0' : '0-1'
}

/** Short termination phrase for the PGN `Termination` header and the UI banner. */
export function terminationText(ending: ChessEnding): string {
  return verdictOf(ending).description
}
