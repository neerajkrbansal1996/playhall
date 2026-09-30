import { replay, START_FEN } from './rules/position.js'
import type { MatchRecord } from './sdk/contract.js'
import { scoreLine, terminationText } from './result.js'
import type { ChessMatchState } from './state.js'

export interface RecordOptions {
  /** Display names for the two seats, if the platform has them. */
  readonly playerNames?: { readonly w?: string; readonly b?: string }
  /** `YYYY.MM.DD` in PGN's seven-tag format. Supplied by the caller, not read from the clock. */
  readonly date?: string
  readonly event?: string
  readonly round?: string
}

/**
 * Export the match as PGN.
 *
 * The move text is produced by chess.js from the replayed move list, so the PGN
 * and the board can never disagree. An unfinished or aborted game exports with
 * `*`, which is exactly what PGN means by "no result".
 */
export function exportRecord(state: ChessMatchState, options: RecordOptions = {}): MatchRecord {
  const chess = replay(state.initialFen, state.moves)
  const result = scoreLine(state)

  chess.setHeader('Event', options.event ?? 'Casual game')
  chess.setHeader('Site', '-')
  chess.setHeader('Date', options.date ?? '????.??.??')
  chess.setHeader('Round', options.round ?? '-')
  chess.setHeader('White', options.playerNames?.w ?? 'White')
  chess.setHeader('Black', options.playerNames?.b ?? 'Black')
  chess.setHeader('Result', result)

  // Only emitted for a non-standard start, per the PGN spec's FEN/SetUp pair.
  if (state.initialFen !== START_FEN) {
    chess.setHeader('SetUp', '1')
    chess.setHeader('FEN', state.initialFen)
  }

  if (state.ending !== null) {
    chess.setHeader('Termination', terminationText(state.ending))
  }

  return {
    format: 'pgn',
    mimeType: 'application/x-chess-pgn',
    filenameHint: 'game.pgn',
    content: chess.pgn(),
  }
}
