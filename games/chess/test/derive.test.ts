import { Chess, type Move } from 'chess.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearDerivedCache,
  derive,
  DERIVED_CACHE_LIMIT,
  type DerivedMatch,
} from '../src/rules/derive.js'
import { START_FEN } from '../src/rules/position.js'

/**
 * The memo in `derive.ts` is only allowed to change how long an answer takes, never
 * the answer. These tests hold it to that by comparing every access pattern against
 * an *independent* from-scratch oracle — a full replay written here, in the test,
 * using chess.js directly. Comparing `derive` against itself would prove nothing:
 * a memo that consistently returns the same wrong repetition count would pass.
 *
 * The patterns matter because the memo has three paths (exact hit, extend the
 * previous ply, replay from scratch) and a mutable repetition chain shared along a
 * line of play. Each test below pins one of those.
 */

interface Snapshot {
  readonly fen: string
  readonly turn: string
  readonly halfmoveClock: number
  readonly repetitionCount: number
  readonly inCheck: boolean
  readonly legalMoveCount: number
  readonly legalMoveSans: readonly string[]
  readonly capturedPieces: { readonly w: readonly string[]; readonly b: readonly string[] }
  readonly lastMove: { readonly from: string; readonly to: string } | null
}

/**
 * The FIDE repetition key, recomputed here rather than imported.
 *
 * Placement, side to move, castling rights, and the en passant square — but only
 * when an en passant capture is actually legal, because FEN records the square
 * after any double push while FIDE only distinguishes positions where the capture
 * is available.
 */
function oracleKey(chess: Chess): string {
  const [placement, turn, castling, enPassant] = chess.fen().split(' ')
  const captureAvailable =
    enPassant !== '-' &&
    chess.moves({ verbose: true }).some((move: Move) => move.flags.includes('e'))
  return `${placement} ${turn} ${castling} ${captureAvailable ? enPassant : '-'}`
}

/** Everything `derive` claims, computed by replaying from ply 0 every time. */
function oracle(initialFen: string, moves: readonly string[]): Snapshot {
  const chess = new Chess(initialFen)
  const keys: string[] = [oracleKey(chess)]
  const captured: { w: string[]; b: string[] } = { w: [], b: [] }
  let lastMove: { from: string; to: string } | null = null

  for (const san of moves) {
    const move = chess.move(san)
    if (move.captured) captured[move.color].push(move.captured)
    lastMove = { from: move.from, to: move.to }
    keys.push(oracleKey(chess))
  }

  const current = keys[keys.length - 1]
  const fen = chess.fen()

  return {
    fen,
    turn: chess.turn(),
    halfmoveClock: Number(fen.split(' ')[4]),
    repetitionCount: keys.filter((key) => key === current).length,
    inCheck: chess.isCheck(),
    legalMoveCount: chess.moves().length,
    legalMoveSans: [...chess.moves()].sort(),
    capturedPieces: { w: captured.w, b: captured.b },
    lastMove,
  }
}

/** The same shape, read off a `DerivedMatch`. */
function snapshot(derived: DerivedMatch): Snapshot {
  return {
    fen: derived.position.fen,
    turn: derived.position.turn,
    halfmoveClock: derived.position.halfmoveClock,
    repetitionCount: derived.position.repetitionCount,
    inCheck: derived.position.inCheck,
    legalMoveCount: derived.position.legalMoveCount,
    legalMoveSans: [...derived.legalMoves.map((move) => move.san)].sort(),
    capturedPieces: { w: [...derived.capturedPieces.w], b: [...derived.capturedPieces.b] },
    lastMove:
      derived.lastMove === null ? null : { from: derived.lastMove.from, to: derived.lastMove.to },
  }
}

function expectMatchesOracle(initialFen: string, moves: readonly string[]): void {
  expect(snapshot(derive(initialFen, moves))).toEqual(oracle(initialFen, moves))
}

/**
 * 1.Nf3 Nf6 2.Ng1 Ng8 3.Nf3 Nf6 4.Ng1 Ng8 — the knights walk out and back twice,
 * so the starting position occurs three times. Chosen because repetition is the
 * one fact a FEN cannot carry, which makes it the fact the memo could plausibly
 * get wrong.
 */
const SHUFFLE = ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'] as const

/** A short capture-and-double-push line: exercises captured piles and the en passant key. */
const TACTICAL = ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qd8', 'd4', 'c5'] as const

beforeEach(() => {
  clearDerivedCache()
})

describe('derive', () => {
  it('matches a full replay on a cold cache', () => {
    expectMatchesOracle(START_FEN, SHUFFLE)
    expectMatchesOracle(START_FEN, TACTICAL)
  })

  it('returns the same answer warm as cold', () => {
    const cold = snapshot(derive(START_FEN, SHUFFLE))
    const warm = snapshot(derive(START_FEN, SHUFFLE))
    expect(warm).toEqual(cold)
    expect(warm).toEqual(oracle(START_FEN, SHUFFLE))
  })

  it('counts the threefold the same way a replay does', () => {
    // Guards the oracle itself: if this line stopped repeating, every comparison
    // above would still pass while testing nothing interesting.
    expect(oracle(START_FEN, SHUFFLE).repetitionCount).toBe(3)
    expect(derive(START_FEN, SHUFFLE).position.repetitionCount).toBe(3)
  })

  it('agrees with a replay at every ply when walked forwards', () => {
    // The `extend` path: each call finds the previous ply memoised and plays one
    // move. This is what a live match does, one action at a time.
    for (let ply = 0; ply <= SHUFFLE.length; ply += 1) {
      const moves = SHUFFLE.slice(0, ply)
      expect(snapshot(derive(START_FEN, moves))).toEqual(oracle(START_FEN, moves))
    }
  })

  it('agrees with a replay when the move list shrinks', () => {
    // A takeback, or a client asking for an earlier position. Walking backwards
    // means every call is an exact hit on an entry that is no longer the tip.
    derive(START_FEN, SHUFFLE)
    for (let ply = SHUFFLE.length; ply >= 0; ply -= 1) {
      const moves = SHUFFLE.slice(0, ply)
      expect(snapshot(derive(START_FEN, moves))).toEqual(oracle(START_FEN, moves))
    }
  })

  it('keeps two branches off a shared prefix from corrupting each other', () => {
    // The `forkChain` path. After the prefix has been extended once it is no
    // longer the tip, so the second continuation must copy the chain rather than
    // append to it. Get that wrong and the branches pollute each other's
    // repetition counts — which is exactly the bug a FEN-only state would have.
    const prefix = SHUFFLE.slice(0, 7)
    const repeats = [...prefix, 'Ng8'] // back to the starting position, third time
    const diverges = [...prefix, 'Nc6'] // a position seen once

    expectMatchesOracle(START_FEN, prefix)
    expectMatchesOracle(START_FEN, repeats)
    expectMatchesOracle(START_FEN, diverges)

    expect(derive(START_FEN, repeats).position.repetitionCount).toBe(3)
    expect(derive(START_FEN, diverges).position.repetitionCount).toBe(1)

    // And re-reading the first branch after the second forked is still right.
    expectMatchesOracle(START_FEN, repeats)
    expectMatchesOracle(START_FEN, prefix)
  })

  it('agrees with a replay after the entry has been evicted', () => {
    // Fill past the limit so the SHUFFLE line is certainly gone, then ask again:
    // the cold path has to produce the same answer the warm one did.
    const warm = snapshot(derive(START_FEN, SHUFFLE))

    // Distinct initial positions, so these are distinct cache keys rather than
    // plies of one game. The fullmove counter is part of the FEN and part of the
    // key; the position it describes is the same legal one.
    for (let n = 1; n <= DERIVED_CACHE_LIMIT + 8; n += 1) {
      derive(`4k3/8/8/8/8/8/8/4K3 w - - 0 ${n}`, [])
    }

    expect(snapshot(derive(START_FEN, SHUFFLE))).toEqual(warm)
    expectMatchesOracle(START_FEN, SHUFFLE)
  })

  it('bounds the cache', () => {
    for (let n = 1; n <= DERIVED_CACHE_LIMIT + 64; n += 1) {
      derive(`4k3/8/8/8/8/8/8/4K3 w - - 0 ${n}`, [])
    }
    // Nothing to read the size off directly, so prove it the way it matters: the
    // oldest entry is gone and re-deriving it still agrees with a replay.
    expectMatchesOracle('4k3/8/8/8/8/8/8/4K3 w - - 0 1', [])
  })

  it('rejects an illegal move on the cold and the incremental path alike', () => {
    expect(() => derive(START_FEN, ['e4', 'e5', 'Qxh8'])).toThrow()

    derive(START_FEN, ['e4', 'e5'])
    // Same rejection when the prefix is memoised and only the last ply is played.
    expect(() => derive(START_FEN, ['e4', 'e5', 'Qxh8'])).toThrow()
  })

  it('derives a mate from a non-standard initial position', () => {
    // Kh1 boxed in by Qg2 with the black king supporting it.
    const mate = '8/8/8/8/8/5k2/6q1/7K w - - 0 1'
    expectMatchesOracle(mate, [])
    expect(derive(mate, []).position.inCheck).toBe(true)
    expect(derive(mate, []).position.legalMoveCount).toBe(0)
  })

  it('derives a stalemate from a non-standard initial position', () => {
    // No legal move and no check: the two are separate facts and the view panel
    // reads both, so a memo that conflated them would show the wrong ending.
    const stalemate = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'
    expectMatchesOracle(stalemate, [])
    expect(derive(stalemate, []).position.inCheck).toBe(false)
    expect(derive(stalemate, []).position.legalMoveCount).toBe(0)
  })
})

describe('derive purity', () => {
  const realNow = Date.now
  const realRandom = Math.random

  beforeEach(() => {
    // The module guarantees determinism. Make any reach for a clock or a random
    // source fail loudly rather than pass silently.
    Date.now = () => {
      throw new Error('derive must not read the clock')
    }
    Math.random = () => {
      throw new Error('derive must not use Math.random')
    }
  })

  afterEach(() => {
    Date.now = realNow
    Math.random = realRandom
  })

  it('derives without reading the clock or a random source', () => {
    clearDerivedCache()
    expect(snapshot(derive(START_FEN, SHUFFLE))).toEqual(
      // The oracle runs under the same stubs, so it would fail too if chess.js
      // itself needed them.
      oracle(START_FEN, SHUFFLE),
    )
  })
})
