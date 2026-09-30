/**
 * Replay-cost benchmark for PER-92.
 *
 * Two measurements, because they answer different questions:
 *
 * 1. `read` — the benchmark from the issue. 20 iterations of
 *    `analyse + replay + getViewFor` against a fixed move list. This is the cost
 *    of *re-reading* a position, which is what the runner pays once per viewer
 *    per broadcast.
 * 2. `game` — one whole game played through `applyAction`, with three views
 *    (both players plus a spectator) built after every ply. This is the cost the
 *    2,000-room target actually cares about, and it is the one that must stop
 *    growing with game length.
 *
 * It asserts nothing — a timing assertion on a shared runner is a flake — and it
 * lives outside `test/`, so `pnpm test` and CI never run it. Run it explicitly
 * with `pnpm --filter @playhall/chess bench`.
 */
import { Chess } from 'chess.js'
import { test } from 'vitest'
import { analyse, replay } from '../src/rules/position.js'
import type { PromotionPiece } from '../src/rules/types.js'
import { asSeatId, type GameContext, type Viewer } from '../src/sdk/contract.js'
import { applyAction, setup, type ChessMatchState } from '../src/state.js'
import { defaultChessSettings } from '../src/settings/schema.js'
import { getViewFor } from '../src/view.js'
import { asGameId, asMatchId, asMatchSeed, createRng } from '@playhall/game-sdk'

const WHITE_SEAT = asSeatId('seat-white')
const BLACK_SEAT = asSeatId('seat-black')
const ITERATIONS = 20
const PLY_TARGETS = [40, 80, 160, 240] as const

/**
 * A fixed-stream context. `now` advances with the ply count so the state is
 * shaped like a real game's, and the rng draw is fixed so White is always the
 * host — the benchmark must measure the same game every run.
 */
function ctx(now: number): GameContext {
  const rng = createRng(asMatchSeed('per-92-bench'))
  return {
    matchId: asMatchId('match-bench'),
    gameId: asGameId('chess'),
    gameVersion: '0.0.0',
    sdkContractVersion: 1,
    now,
    seed: asMatchSeed('per-92-bench'),
    sequence: now,
    rng: { ...rng, next: () => 0.1, fork: () => rng },
  }
}

/** Deterministic 32-bit LCG. Local to the benchmark; the game module never rolls its own. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

/**
 * The longest random legal game found within `attempts`, as a SAN list.
 *
 * Random play usually draws itself out somewhere past a hundred plies, so
 * reaching 240 takes a few tries. Prefixes of one long game are used for the
 * shorter targets, so every row below measures the same opening.
 */
function longestRandomGame(target: number, attempts: number): readonly string[] {
  let best: readonly string[] = []
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const next = lcg(attempt + 1)
    const chess = new Chess()
    const sans: string[] = []
    while (sans.length < target && !chess.isGameOver()) {
      const legal = chess.moves()
      const pick = legal[Math.floor(next() * legal.length)]
      if (pick === undefined) break
      chess.move(pick)
      sans.push(pick)
    }
    if (sans.length > best.length) best = sans
    if (best.length >= target) return best
  }
  return best
}

/** chess.js types `promotion` as any piece symbol; the reducer only takes the four real ones. */
function isPromotion(piece: string | undefined): piece is PromotionPiece {
  return piece === 'q' || piece === 'r' || piece === 'b' || piece === 'n'
}

function stateWith(moves: readonly string[]): ChessMatchState {
  const base = setup(
    { hostSeatId: WHITE_SEAT, guestSeatId: BLACK_SEAT, settings: defaultChessSettings() },
    ctx(0),
  )
  return { ...base, moves, phase: moves.length >= 2 ? 'in_play' : 'awaiting_first_move' }
}

const VIEWERS: readonly Viewer[] = [
  { kind: 'seat', seatId: WHITE_SEAT },
  { kind: 'seat', seatId: BLACK_SEAT },
  { kind: 'spectator' },
]

/**
 * CPU milliseconds consumed by `work`, not wall-clock.
 *
 * The number that matters here is blocking CPU on the event loop, and this
 * machine runs several other jobs at once — wall-clock timings came out
 * non-monotonic in ply count, which is measurement noise, not a property of the
 * code. `process.cpuUsage()` charges only this process.
 */
function cpuMs(work: () => void): number {
  const before = process.cpuUsage()
  work()
  const after = process.cpuUsage(before)
  return (after.user + after.system) / 1000
}

/** The cheapest of `repeats` runs: under contention, the minimum is the honest estimate. */
function fastestOf(repeats: number, work: () => void): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < repeats; i += 1) best = Math.min(best, cpuMs(work))
  return best
}

function benchRead(moves: readonly string[]): number {
  const state = stateWith(moves)
  return (
    fastestOf(3, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        analyse(state.initialFen, state.moves)
        replay(state.initialFen, state.moves)
        getViewFor(state, VIEWERS[0] as Viewer)
      }
    }) / ITERATIONS
  )
}

/** Play `moves` through the reducer, building all three views after every ply. */
function benchGame(moves: readonly string[]): number {
  return fastestOf(2, () => playWholeGame(moves))
}

function playWholeGame(moves: readonly string[]): void {
  let state = setup(
    { hostSeatId: WHITE_SEAT, guestSeatId: BLACK_SEAT, settings: defaultChessSettings() },
    ctx(0),
  )
  for (const [ply, san] of moves.entries()) {
    // The reducer takes coordinates, so resolve the SAN the way a client would.
    const chess = new Chess(analyse(state.initialFen, state.moves).fen)
    const move = chess.moves({ verbose: true }).find((candidate) => candidate.san === san)
    if (move === undefined) throw new Error(`Bench setup error: "${san}" is not legal`)
    const result = applyAction(
      state,
      {
        type: 'move',
        move: isPromotion(move.promotion)
          ? { from: move.from, to: move.to, promotion: move.promotion }
          : { from: move.from, to: move.to },
      },
      state.colors[chess.turn()],
      ctx(ply + 1),
    )
    if (!result.ok) throw new Error(`Bench setup error: ply ${ply} rejected with ${result.error}`)
    state = result.state
    for (const viewer of VIEWERS) getViewFor(state, viewer)
  }
}

const LONGEST = PLY_TARGETS[PLY_TARGETS.length - 1]

test('replay cost', { timeout: 900_000 }, () => {
  const game = longestRandomGame(LONGEST, 4000)
  const report: string[] = []
  if (game.length < LONGEST) {
    report.push(`note: longest random game found was ${game.length} plies`)
  }

  // Warm the JIT on a short game once, so the first row does not absorb
  // compilation. Deliberately short: a warm-up pass per row would double the
  // (already superlinear) runtime of the whole benchmark.
  benchRead(game.slice(0, 20))
  benchGame(game.slice(0, 20))

  report.push(`\nread: ${ITERATIONS} x (analyse + replay + getViewFor), CPU ms per iteration`)
  for (const plies of PLY_TARGETS) {
    if (game.length < plies) continue
    report.push(`  plies=${String(plies).padEnd(6)}${benchRead(game.slice(0, plies)).toFixed(2)} ms`)
  }

  report.push(`\ngame: whole game via applyAction + 3 views per ply, total CPU ms`)
  for (const plies of PLY_TARGETS) {
    if (game.length < plies) continue
    const total = benchGame(game.slice(0, plies))
    report.push(
      `  plies=${String(plies).padEnd(6)}${total.toFixed(2)} ms total, ${(total / plies).toFixed(3)} ms per ply`,
    )
  }

  process.stdout.write(`${report.join('\n')}\n`)
})
