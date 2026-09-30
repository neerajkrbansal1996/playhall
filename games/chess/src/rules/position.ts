import { Chess, type Move } from 'chess.js'
import { derive, positionKey, type PositionInfo } from './derive.js'
import type { MoveInput, PromotionPiece } from './types.js'

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
 * would silently get threefold repetition wrong. Defined next to the derivation
 * that produces it; re-exported here because this is where callers look for it.
 */
export type { PositionInfo }

/**
 * Replay a move list onto a starting position, returning the `Chess` itself.
 *
 * For the callers that need chess.js's own history — PGN export, and tests that
 * want the move list a position allows. Anything that only needs to *know* about
 * the position should call `analyse`, which is memoised; this always replays.
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

/**
 * The repetition key for a position, for callers holding a `Chess`.
 *
 * See `positionKey` in `derive.ts` for what goes into it and why the en passant
 * square is normalised.
 */
export function repetitionKey(chess: Chess): string {
  return positionKey(chess.fen(), () => chess.moves({ verbose: true }))
}

/**
 * Report the state of the position a move list arrives at.
 *
 * Memoised by `(initialFen, moves)` — see `derive.ts`. Same inputs, same answer;
 * the cache only changes how long it takes to get it.
 */
export function analyse(initialFen: string, moves: readonly string[]): PositionInfo {
  return derive(initialFen, moves).position
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
 *
 * "Ambiguous" includes a promoting push written without its promotion letter:
 * "e7e8" names four distinct legal moves, so it is rejected and the caller has
 * to ask which piece. Defaulting silently — to a queen, or to whatever chess.js
 * happens to list first — would let the server apply a move the player never
 * chose, and an unwanted knight in a won endgame loses the game.
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
    const candidates = legal.filter(
      (move: Move) =>
        move.from === from?.toLowerCase() &&
        move.to === to?.toLowerCase() &&
        (promotion === undefined || move.promotion === promotion.toLowerCase()),
    )
    // Exactly one, mirroring the SAN branch below. A from/to pair normally
    // identifies a single move; the one case where it does not is a promotion
    // with the piece left off, which lands here as four candidates.
    const match = candidates.length === 1 ? candidates[0] : undefined
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
