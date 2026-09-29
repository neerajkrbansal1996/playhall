import { Chess, type Move } from 'chess.js'
import type { Color, MoveInput, PromotionPiece } from './types.js'

const PROMOTION_PIECES: readonly string[] = ['q', 'r', 'b', 'n']

/**
 * chess.js types `Move.promotion` as any piece symbol, including `p` and `k`,
 * which a promotion can never be. Narrow it rather than casting at the call site.
 */
function asPromotion(piece: string | undefined): PromotionPiece | undefined {
  return piece !== undefined && PROMOTION_PIECES.includes(piece)
    ? (piece as PromotionPiece)
    : undefined
}

/** Build a `MoveInput`, omitting `promotion` entirely when there is none. */
function moveInput(from: string, to: string, promotion: string | undefined): MoveInput {
  const piece = asPromotion(promotion)
  return piece ? { from, to, promotion: piece } : { from, to }
}

/** The standard starting position, as a FEN. */
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

/**
 * Everything the rules need to know about the position after a move list.
 *
 * Produced by replaying the move list rather than by loading a stored FEN: a FEN
 * cannot tell you how many times a position has repeated, so a FEN-only state
 * would silently get threefold repetition wrong.
 */
export interface PositionInfo {
  readonly fen: string
  readonly turn: Color
  /** Plies since the last capture or pawn move, straight from the FEN. */
  readonly halfmoveClock: number
  /** How many times the *current* position has occurred in this game, including now. */
  readonly repetitionCount: number
  readonly inCheck: boolean
  readonly legalMoveCount: number
}

/**
 * Replay a move list onto a starting position.
 *
 * Throws if any move is illegal, which is the point: this is the only path by
 * which a move enters the state, so a tampered client cannot smuggle one in.
 */
export function replay(initialFen: string, moves: readonly string[]): Chess {
  const chess = new Chess(initialFen)
  for (const san of moves) {
    // chess.js throws on an illegal or unparseable SAN string.
    chess.move(san)
  }
  return chess
}

function fenField(fen: string, index: number): string {
  const field = fen.split(' ')[index]
  if (field === undefined) throw new Error(`Malformed FEN, missing field ${index}: ${fen}`)
  return field
}

/**
 * The repetition key for a position.
 *
 * Placement, side to move, castling rights, and the en passant square — but the
 * en passant square only counts when an en passant capture is actually legal.
 * FEN records the square after any double pawn push; FIDE only treats positions
 * as different if the capture is available. Skipping this normalisation makes
 * threefold under-count after any double push, which players notice immediately.
 */
export function repetitionKey(chess: Chess): string {
  const fen = chess.fen()
  const placement = fenField(fen, 0)
  const turn = fenField(fen, 1)
  const castling = fenField(fen, 2)
  const enPassant = fenField(fen, 3)

  const captureAvailable =
    enPassant !== '-' &&
    chess.moves({ verbose: true }).some((move: Move) => move.flags.includes('e'))

  return `${placement} ${turn} ${castling} ${captureAvailable ? enPassant : '-'}`
}

/** Replay the game and report the state of the position it arrives at. */
export function analyse(initialFen: string, moves: readonly string[]): PositionInfo {
  const chess = new Chess(initialFen)
  const keys: string[] = [repetitionKey(chess)]

  for (const san of moves) {
    chess.move(san)
    keys.push(repetitionKey(chess))
  }

  const current = keys[keys.length - 1]
  const fen = chess.fen()

  return {
    fen,
    turn: chess.turn(),
    halfmoveClock: Number(fenField(fen, 4)),
    repetitionCount: keys.filter((key) => key === current).length,
    inCheck: chess.isCheck(),
    legalMoveCount: chess.moves().length,
  }
}

/**
 * Apply one move to a replayed game, returning the SAN it produced.
 *
 * Returns `null` for an illegal move instead of throwing, because an illegal
 * move is an expected client error (a stale board, a race, or a tampered
 * client), not an exceptional condition.
 */
export function tryMove(chess: Chess, input: MoveInput): string | null {
  try {
    const move = chess.move({
      from: input.from,
      to: input.to,
      ...(input.promotion ? { promotion: input.promotion } : {}),
    })
    return move.san
  } catch {
    return null
  }
}

/**
 * Parse keyboard move entry into coordinates.
 *
 * Accepts SAN ("e4", "Nf3", "O-O", "exd8=Q+") and long algebraic ("e2e4",
 * "e7e8q"). Resolves against the legal move list, so an ambiguous or illegal
 * string returns `null` rather than a guess.
 */
export function parseMoveInput(chess: Chess, text: string): MoveInput | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  const legal = chess.moves({ verbose: true })

  // Long algebraic: e2e4, e7e8q. Checked first because "b1c3" would otherwise
  // look like a (nonsensical) SAN pawn move.
  const coordinate = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i.exec(trimmed)
  if (coordinate) {
    const [, from, to, promotion] = coordinate
    const match = legal.find(
      (move: Move) =>
        move.from === from?.toLowerCase() &&
        move.to === to?.toLowerCase() &&
        (promotion === undefined || move.promotion === promotion.toLowerCase()),
    )
    return match ? moveInput(match.from, match.to, match.promotion) : null
  }

  // SAN, compared with decorations stripped so "Nf3+" and "Nf3" both resolve.
  const normalise = (san: string): string => san.replace(/[+#?!]/g, '').replace(/0/g, 'O')
  const wanted = normalise(trimmed)
  const matches = legal.filter((move: Move) => normalise(move.san) === wanted)
  const only = matches.length === 1 ? matches[0] : undefined
  if (!only) return null

  return moveInput(only.from, only.to, only.promotion)
}
