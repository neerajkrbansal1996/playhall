import { type Move } from 'chess.js'
import { availableDrawClaims } from './rules/endings.js'
import { materialDifference } from './rules/material.js'
import { analyse, replay } from './rules/position.js'
import type { ChessEnding, Color, ColorAssignment, DrawClaim } from './rules/types.js'
import type { MatchResult, Viewer } from './sdk/contract.js'
import { getResult } from './result.js'
import { canAbort, firstMoveDeadline, type ChessMatchState } from './state.js'

/** Pieces one side has captured, as piece letters (`p`, `n`, `b`, `r`, `q`). */
export interface CapturedPieces {
  readonly w: readonly string[]
  readonly b: readonly string[]
}

export interface ChessView {
  readonly phase: ChessMatchState['phase']
  readonly fen: string
  readonly turn: Color
  readonly moves: readonly string[]
  readonly lastMove: { readonly from: string; readonly to: string } | null
  readonly inCheck: boolean
  readonly colors: ColorAssignment
  /** The viewer's colour, or `null` for a spectator. Drives board orientation. */
  readonly yourColor: Color | null
  /**
   * Legal destinations keyed by origin square, for legal-move dots.
   * Only ever populated for the player whose turn it is — these are hints, and
   * the server re-checks every move regardless of what the client was told.
   */
  readonly legalMoves: Readonly<Record<string, readonly string[]>>
  /**
   * Pending draw offer. Redacted to `null` for spectators: chess has no hidden
   * information on the board, but an offer is still private to the two players.
   */
  readonly drawOffer: { readonly by: Color; readonly isYours: boolean } | null
  /** Draws the viewer may claim right now. Empty unless it is their turn. */
  readonly availableDrawClaims: readonly DrawClaim[]
  readonly canAbort: boolean
  /** Epoch ms at which the 30 s first-move window expires, or `null`. */
  readonly firstMoveDeadline: number | null
  readonly capturedPieces: CapturedPieces
  /** Positive means White is ahead, in pawn units. */
  readonly materialDifference: number
  readonly ending: ChessEnding | null
  readonly result: MatchResult | null
}

function capturedPieces(history: readonly Move[]): CapturedPieces {
  const captured: { w: string[]; b: string[] } = { w: [], b: [] }
  for (const move of history) {
    if (!move.captured) continue
    // `move.color` is the capturing side, so the piece goes to their pile.
    captured[move.color].push(move.captured)
  }
  return captured
}

function legalMovesFor(history: readonly Move[]): Readonly<Record<string, readonly string[]>> {
  const byOrigin: Record<string, string[]> = {}
  for (const move of history) {
    const destinations = byOrigin[move.from] ?? (byOrigin[move.from] = [])
    if (!destinations.includes(move.to)) destinations.push(move.to)
  }
  return byOrigin
}

/**
 * Build the view a given viewer is allowed to see.
 *
 * Chess has no hidden information, so this is not about the position — it is
 * about everything *around* it: a spectator must not learn that a player has a
 * draw offer pending, and nobody gets legal-move hints for a side they are not
 * playing.
 */
export function getViewFor(state: ChessMatchState, viewer: Viewer): ChessView {
  const chess = replay(state.initialFen, state.moves)
  const position = analyse(state.initialFen, state.moves)
  const history = chess.history({ verbose: true })
  const last = history[history.length - 1]

  // A `replay` viewer has full information, but it is only ever constructed
  // after the match is over — by then there is no offer pending and no turn to
  // hint, so it lands on the same view a spectator gets.
  const yourColor =
    viewer.kind === 'seat'
      ? state.colors.w === viewer.seatId
        ? 'w'
        : state.colors.b === viewer.seatId
          ? 'b'
          : null
      : null

  const isYourTurn = yourColor !== null && yourColor === position.turn && state.phase !== 'finished'

  return {
    phase: state.phase,
    fen: position.fen,
    turn: position.turn,
    moves: state.moves,
    lastMove: last ? { from: last.from, to: last.to } : null,
    inCheck: position.inCheck,
    colors: state.colors,
    yourColor,
    legalMoves: isYourTurn ? legalMovesFor(chess.moves({ verbose: true })) : {},
    drawOffer:
      yourColor !== null && state.drawOffer !== null
        ? { by: state.drawOffer.by, isYours: state.drawOffer.by === yourColor }
        : null,
    availableDrawClaims: isYourTurn ? availableDrawClaims(position) : [],
    canAbort: yourColor !== null && canAbort(state),
    firstMoveDeadline: firstMoveDeadline(state),
    capturedPieces: capturedPieces(history),
    materialDifference: materialDifference(position.fen),
    ending: state.ending,
    result: getResult(state),
  }
}
