/**
 * Replay-cost benchmark for PER-92.
 *
 * Three measurements, because they answer different questions:
 *
 * 1. `read` — the benchmark from the issue, unchanged so the numbers compare. 20
 *    iterations of `analyse + replay + getViewFor` against a fixed move list.
 *    Note it includes `replay`, which is a full replay *by definition* — it is
 *    what PGN export needs — so this row can never go flat.
 * 2. `views` — 20 iterations of `getViewFor` for all three viewers, and nothing
 *    else. Separated from `read` precisely because `read`'s floor would otherwise
 *    hide whether a *view build* still costs O(game length), which is the thing
 *    the runner pays per viewer per broadcast.
 * 3. `game` — one whole game played through `applyAction`, with three views
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
import type { MoveInput, PromotionPiece } from '../src/rules/types.js'
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

/**
 * `getViewFor` alone, for all three viewers.
 *
 * Separated from `read` because `read` also calls `replay` explicitly, and
 * `replay` is a full replay by definition — it is what PGN export needs. Keeping
 * it in the same row would hide whether a *view build* still costs O(game), which
 * is the thing the 2,000-room target actually pays per viewer per broadcast.
 */
function benchViews(moves: readonly string[]): number {
  const state = stateWith(moves)
  return (
    fastestOf(3, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        for (const viewer of VIEWERS) getViewFor(state, viewer)
      }
    }) / ITERATIONS
  )
}

/**
 * The game as coordinate inputs, resolved ahead of time.
 *
 * The reducer takes `{from, to}`, not SAN, so the bench has to resolve each ply the
 * way a client would. Doing that inside the timed loop needs a position — and once
 * derivation is memoised, the bench's own resolution gets faster too, which would
 * flatter the result. Resolving up front keeps the timed loop to exactly what the
 * runner does: one `applyAction`, then one `getViewFor` per viewer.
 */
function asMoveInputs(moves: readonly string[]): readonly MoveInput[] {
  const chess = new Chess()
  return moves.map((san) => {
    const move = chess.moves({ verbose: true }).find((candidate) => candidate.san === san)
    if (move === undefined) throw new Error(`Bench setup error: "${san}" is not legal`)
    chess.move(san)
    return isPromotion(move.promotion)
      ? { from: move.from, to: move.to, promotion: move.promotion }
      : { from: move.from, to: move.to }
  })
}

/** Play `moves` through the reducer, building all three views after every ply. */
function benchGame(moves: readonly MoveInput[]): number {
  return fastestOf(2, () => playWholeGame(moves))
}

function playWholeGame(moves: readonly MoveInput[]): void {
  let state = setup(
    { hostSeatId: WHITE_SEAT, guestSeatId: BLACK_SEAT, settings: defaultChessSettings() },
    ctx(0),
  )
  for (const [ply, move] of moves.entries()) {
    const result = applyAction(
      state,
      { type: 'move', move },
      // Plies alternate from White, and the bench never reaches an ending early.
      state.colors[ply % 2 === 0 ? 'w' : 'b'],
      ctx(ply + 1),
    )
    if (!result.ok) throw new Error(`Bench setup error: ply ${ply} rejected with ${result.error}`)
    state = result.state
    for (const viewer of VIEWERS) getViewFor(state, viewer)
  }
}

const LONGEST: number = Math.max(...PLY_TARGETS)

/**
 * Found once, at collect time, and shared by every row: prefixes of one long game
 * mean every row measures the same opening. The search is the slowest thing in the
 * file, so it must not run per row.
 */
const GAME = longestRandomGame(LONGEST, 4000)
const INPUTS = asMoveInputs(GAME)

// Warm the JIT once, on a short game, so the first row does not absorb compilation.
benchRead(GAME.slice(0, 20))
benchGame(INPUTS.slice(0, 20))

/**
 * One test per ply target rather than one test for the whole table.
 *
 * Not cosmetic: a single task that runs for minutes trips vitest's `onTaskUpdate`
 * RPC timeout, which surfaces as an unhandled error and a non-zero exit even though
 * the measurement completed. Per-target tasks stay well inside it.
 */
for (const plies of PLY_TARGETS) {
  test(`replay cost at ${plies} plies`, { timeout: 900_000 }, (context) => {
    if (GAME.length < plies) {
      context.skip(`longest random game found was ${GAME.length} plies`)
      return
    }

    const read = benchRead(GAME.slice(0, plies))
    const views = benchViews(GAME.slice(0, plies))
    const game = benchGame(INPUTS.slice(0, plies))

    process.stdout.write(
      [
        `\nplies=${plies}`,
        `  read   ${read.toFixed(2)} ms   (${ITERATIONS}x analyse + replay + getViewFor, CPU ms per iteration)`,
        `  views  ${views.toFixed(2)} ms   (${ITERATIONS}x getViewFor for 3 viewers, CPU ms per iteration)`,
        `  game   ${game.toFixed(2)} ms   (whole game via applyAction + 3 views per ply, total CPU ms)`,
        `  game   ${(game / plies).toFixed(3)} ms   per ply`,
        '',
      ].join('\n'),
    )
  })
}
