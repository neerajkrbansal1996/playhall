import { Chess, type Move } from 'chess.js'
import type { Color } from './types.js'

/**
 * Incremental derivation of a position from a move list.
 *
 * The move list stays the single source of truth — a FEN cannot tell you how
 * many times a position has repeated, so threefold would be wrong without it.
 * What changes here is *how often* we pay for that: instead of replaying from
 * ply 0 on every read, each derivation is built by extending the derivation one
 * ply behind it, and the results are memoised by `(initialFen, moves)`.
 *
 * Purity is unaffected. The cache is a memo: for the same `initialFen` and the
 * same move list it returns the same values it would have computed from scratch,
 * and `derive.test.ts` asserts exactly that — cold, warm, branched, and after
 * eviction. Nothing here reads `Date.now()` or `Math.random()`.
 *
 * The cache is game-local on purpose. It needs no SDK support and no per-match
 * scratch space from the platform: the key is content, so a match rehydrated
 * from Redis into fresh objects still hits it.
 */

/** Everything the rules need to know about the position after a move list. */
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

/** Pieces one side has captured, as piece letters (`p`, `n`, `b`, `r`, `q`). */
export interface CapturedPieces {
  readonly w: readonly string[]
  readonly b: readonly string[]
}

/**
 * Repetition keys for one line of play, shared by every derivation along it.
 *
 * Append-only, so a derivation at ply `n` owns `keys[0..n]` for as long as
 * `keys.length === n + 1`. Once a longer derivation has appended, the shorter
 * one is no longer the tip and any further extension of it forks a copy — which
 * is what keeps two branches from the same prefix (a real thing in tests, and in
 * a takeback later) from corrupting each other.
 */
interface RepetitionChain {
  readonly keys: string[]
  /** Occurrences of each key in `keys`. Kept in step with it, so counting is O(1). */
  readonly counts: Map<string, number>
}

/** A position, plus the parts of the game's history the view needs. */
export interface DerivedMatch {
  readonly initialFen: string
  /** Plies applied. `chain.keys.length === plies + 1` exactly when this is the tip. */
  readonly plies: number
  readonly position: PositionInfo
  /** Legal moves in this position, verbose. Also what decides en passant availability. */
  readonly legalMoves: readonly Move[]
  readonly capturedPieces: CapturedPieces
  readonly lastMove: { readonly from: string; readonly to: string } | null
  readonly chain: RepetitionChain
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
 *
 * `legalMoves` is a thunk because it is only needed when there is an en passant
 * square at all, and generating moves is the expensive part.
 */
export function positionKey(fen: string, legalMoves: () => readonly Move[]): string {
  const placement = fenField(fen, 0)
  const turn = fenField(fen, 1)
  const castling = fenField(fen, 2)
  const enPassant = fenField(fen, 3)

  const captureAvailable =
    enPassant !== '-' && legalMoves().some((move: Move) => move.flags.includes('e'))

  return `${placement} ${turn} ${castling} ${captureAvailable ? enPassant : '-'}`
}

const NOTHING_CAPTURED: CapturedPieces = Object.freeze({
  w: Object.freeze([]) as readonly string[],
  b: Object.freeze([]) as readonly string[],
})

/** The starting point of a derivation: the initial position, no moves applied. */
function start(initialFen: string, chess: Chess): DerivedMatch {
  const legalMoves = chess.moves({ verbose: true })
  const fen = chess.fen()
  const key = positionKey(fen, () => legalMoves)

  return {
    initialFen,
    plies: 0,
    position: {
      fen,
      turn: chess.turn(),
      halfmoveClock: Number(fenField(fen, 4)),
      repetitionCount: 1,
      inCheck: chess.isCheck(),
      legalMoveCount: legalMoves.length,
    },
    legalMoves,
    capturedPieces: NOTHING_CAPTURED,
    lastMove: null,
    chain: { keys: [key], counts: new Map([[key, 1]]) },
  }
}

/** Copy the part of the chain a non-tip derivation owns, so extending it cannot clobber the tip. */
function forkChain(previous: DerivedMatch): RepetitionChain {
  const keys = previous.chain.keys.slice(0, previous.plies + 1)
  const counts = new Map<string, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return { keys, counts }
}

function withCapture(previous: CapturedPieces, by: Color, piece: string): CapturedPieces {
  const taken = Object.freeze([...previous[by], piece]) as readonly string[]
  // `by` is the capturing side, so the piece goes on their pile.
  return Object.freeze(by === 'w' ? { w: taken, b: previous.b } : { w: previous.w, b: taken })
}

/**
 * The derivation one ply on, given a `Chess` that has just played `move`.
 *
 * One move generation per ply, shared by the legal-move count, the en passant
 * normalisation in the repetition key, and the view's legal-move dots. The old
 * code generated moves twice per ply for the first two of those.
 */
function step(previous: DerivedMatch, chess: Chess, move: Move): DerivedMatch {
  const chain =
    previous.chain.keys.length === previous.plies + 1 ? previous.chain : forkChain(previous)

  const legalMoves = chess.moves({ verbose: true })
  const fen = chess.fen()
  const key = positionKey(fen, () => legalMoves)
  const repetitionCount = (chain.counts.get(key) ?? 0) + 1
  chain.keys.push(key)
  chain.counts.set(key, repetitionCount)

  return {
    initialFen: previous.initialFen,
    plies: previous.plies + 1,
    position: {
      fen,
      turn: chess.turn(),
      halfmoveClock: Number(fenField(fen, 4)),
      repetitionCount,
      inCheck: chess.isCheck(),
      legalMoveCount: legalMoves.length,
    },
    legalMoves,
    capturedPieces: move.captured
      ? withCapture(previous.capturedPieces, move.color, move.captured)
      : previous.capturedPieces,
    lastMove: Object.freeze({ from: move.from, to: move.to }),
    chain,
  }
}

/**
 * Replay the whole move list. The cold path: a fresh process, or a match whose
 * previous derivation has been evicted.
 *
 * Throws if any move is illegal, which is the point: this is the only path by
 * which a move enters the state, so a tampered client cannot smuggle one in.
 */
function fromScratch(initialFen: string, moves: readonly string[]): DerivedMatch {
  const chess = new Chess(initialFen)
  let current = start(initialFen, chess)
  for (const san of moves) {
    // chess.js throws on an illegal or unparseable SAN string.
    const move = chess.move(san)
    current = step(current, chess, move)
  }
  return current
}

/** Extend a derivation by one SAN move, without replaying anything before it. */
function extend(previous: DerivedMatch, san: string): DerivedMatch {
  // Legality and SAN disambiguation depend only on the position, and a FEN
  // carries all of it — placement, side to move, castling rights, the en passant
  // square and both clocks. Repetition is the one thing it cannot express, and
  // that comes from the chain instead.
  const chess = new Chess(previous.position.fen)
  const move = chess.move(san)
  return step(previous, chess, move)
}

/**
 * How many derivations to keep. Each entry is a position plus its legal move
 * list — a few KB — and a live match only ever needs its two most recent, so
 * this covers far more concurrent matches than it looks like.
 */
export const DERIVED_CACHE_LIMIT = 512

/** Insertion order is LRU order: a hit re-inserts, and eviction takes the front. */
const cache = new Map<string, DerivedMatch>()

function cacheKey(initialFen: string, moves: readonly string[]): string {
  return `${initialFen}#${moves.join(' ')}`
}

function remember(key: string, derived: DerivedMatch): DerivedMatch {
  cache.delete(key)
  cache.set(key, derived)
  while (cache.size > DERIVED_CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
  return derived
}

function recall(key: string): DerivedMatch | undefined {
  const hit = cache.get(key)
  if (hit === undefined) return undefined
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

/**
 * The position after `moves`, computing as little as possible to get there.
 *
 * Three paths, cheapest first: the exact move list is memoised; the move list
 * one ply back is memoised, so only the new ply is played; or nothing is, and
 * the game is replayed in full.
 *
 * During a live match the second path is the one that runs — one action adds one
 * ply — so the work per action is bounded by the new plies rather than by the
 * length of the game. Every viewer's view build after it takes the first path.
 */
export function derive(initialFen: string, moves: readonly string[]): DerivedMatch {
  const key = cacheKey(initialFen, moves)
  const hit = recall(key)
  if (hit !== undefined) return hit

  const last = moves[moves.length - 1]
  if (last !== undefined) {
    const previous = recall(cacheKey(initialFen, moves.slice(0, -1)))
    if (previous !== undefined) return remember(key, extend(previous, last))
  }

  return remember(key, fromScratch(initialFen, moves))
}

/**
 * Empty the memo.
 *
 * For tests that need to measure the cold path, and for nothing else: clearing
 * it can never change an answer, only the time taken to reach one.
 */
export function clearDerivedCache(): void {
  cache.clear()
}
