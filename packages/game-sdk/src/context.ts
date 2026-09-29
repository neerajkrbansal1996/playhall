/**
 * The execution context handed to every server-side game entry point.
 *
 * This is the complete list of things a game may read from the outside world.
 * There is no logger, no fetch, no storage handle and no scheduler here, and
 * that is deliberate: everything a game wants to *do* to the outside world it
 * returns as a value (events, timer commands) and the platform performs.
 *
 * Purity rule, restated: a game module must be a pure function of
 * `(ctx, state, input)`. No I/O. No `Date.now()` — use `ctx.now`. No
 * `Math.random()` — use `ctx.rng`. CI enforces the last two by lint
 * (`no-restricted-properties` over `packages/**` and `games/**`).
 */

import type { GameId, MatchId, MatchSeed } from './ids.js'
import { type Rng, createContextRng } from './rng.js'

export interface GameContext {
  readonly matchId: MatchId
  readonly gameId: GameId
  /**
   * The module version this match is pinned to. A match that started on
   * 1.2.0 stays on 1.2.0 until it ends, even if 1.3.0 deploys underneath it.
   */
  readonly gameVersion: string
  /** SDK contract major this match was started against. See `versioning.ts`. */
  readonly sdkContractVersion: number
  /**
   * Server-authoritative wall clock, ms since the Unix epoch. The only clock a
   * game may read. It is constant for the whole of one call, so two reads
   * inside one `applyAction` cannot disagree and replay cannot drift.
   */
  readonly now: number
  /** The match seed. Stored on the match; replay re-derives everything from it. */
  readonly seed: MatchSeed
  /**
   * Monotonic index of the mutation being applied. `0` is
   * `createInitialState`; each accepted action, timer firing or lifecycle hook
   * increments it. Together with `seed` it determines `rng`.
   */
  readonly sequence: number
  /** Deterministic stream for this `(seed, sequence)`. Never `Math.random()`. */
  readonly rng: Rng
}

/** Adds the tick-loop coordinates a real-time game needs. */
export interface RealtimeContext extends GameContext {
  /** Monotonic tick number since the world was created. */
  readonly tick: number
  /** Ticks per second the room is running at, from the manifest. */
  readonly tickRate: number
}

export interface GameContextInit {
  readonly matchId: MatchId
  readonly gameId: GameId
  readonly gameVersion: string
  readonly sdkContractVersion: number
  readonly now: number
  readonly seed: MatchSeed
  readonly sequence: number
}

/**
 * The single place a `GameContext` is built.
 *
 * `@playhall/platform-core` and `@playhall/game-testkit` both call this so that a
 * replay in a test and a replay on the server derive the same RNG stream.
 */
export function createGameContext(init: GameContextInit): GameContext {
  return Object.freeze({
    ...init,
    rng: createContextRng(init.seed, init.sequence),
  })
}

export function createRealtimeContext(
  init: GameContextInit & { readonly tick: number; readonly tickRate: number },
): RealtimeContext {
  return Object.freeze({
    ...init,
    rng: createContextRng(init.seed, init.sequence),
  })
}

/**
 * Globals a game package may not touch, exported so the dependency-boundary
 * and determinism lint rules have one source of truth instead of a list
 * copy-pasted into `eslint.config.mjs`.
 */
export const FORBIDDEN_GLOBALS_IN_GAMES = [
  { object: 'Date', property: 'now', use: 'ctx.now' },
  { object: 'Math', property: 'random', use: 'ctx.rng' },
  { object: 'performance', property: 'now', use: 'ctx.now' },
] as const
