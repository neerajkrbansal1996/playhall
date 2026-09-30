/**
 * Deterministic randomness.
 *
 * A game may never call `Math.random()`. It reads `ctx.rng`, which the platform
 * derives from the match seed and the sequence number of the mutation being
 * applied. That derivation is the whole trick:
 *
 *   rng(match) = f(seed, sequence)
 *
 * Because the stream is a pure function of `(seed, sequence)` and not of how
 * many numbers a previous call consumed, a game never has to persist RNG state,
 * and replaying a match log from any point reproduces the same outcome. Same
 * seed plus same inputs equals same result — which is what buys us replays,
 * crash recovery and reproducible tests.
 */

import { type MatchSeed, asMatchSeed } from './ids.js'

export interface Rng {
  /** The seed this stream was derived from. Useful for logging and forking. */
  readonly seed: string
  /** Uniform float in `[0, 1)`. */
  next(): number
  /** Uniform integer in `[minInclusive, maxExclusive)`. */
  int(minInclusive: number, maxExclusive: number): number
  /** `true` with the given probability (default 0.5). */
  bool(probability?: number): boolean
  /** Uniformly picks one element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T
  /** Returns a new, shuffled copy (Fisher-Yates). Does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[]
  /**
   * An independent sub-stream. Use this when one logical concern (shuffling a
   * deck) must not shift the numbers another concern (spawn points) receives.
   */
  fork(label: string): Rng
}

/** FNV-1a, 32-bit. Stable across engines; used only to mix a seed string. */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Joins parts into a seed string. Deterministic and collision-resistant enough
 * for our purposes because parts are length-prefixed rather than concatenated.
 */
export function deriveSeed(...parts: readonly (string | number)[]): string {
  return parts.map((part) => `${String(part).length}:${String(part)}`).join('|')
}

/**
 * splitmix32. Chosen over `Math.random` (not seedable) and over a Mersenne
 * Twister (512 bytes of state for no benefit at our sample sizes): it is
 * 32-bit-integer-only, so it produces identical output on every JS engine,
 * and it has no visible structure at the scale a board game or a 30 Hz tick
 * loop consumes.
 */
function splitmix32(state: number): () => number {
  let a = state | 0
  return () => {
    a = (a + 0x9e3779b9) | 0
    let t = a ^ (a >>> 16)
    t = Math.imul(t, 0x21f0aaad)
    t ^= t >>> 15
    t = Math.imul(t, 0x735a2d97)
    t ^= t >>> 15
    return (t >>> 0) / 4294967296
  }
}

/** Creates a deterministic stream from a seed string. */
export function createRng(seed: string): Rng {
  const next = splitmix32(hashString(seed))

  const rng: Rng = {
    seed,
    next,
    int(minInclusive: number, maxExclusive: number): number {
      if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
        throw new RangeError('rng.int requires integer bounds')
      }
      if (maxExclusive <= minInclusive) {
        throw new RangeError(
          `rng.int requires maxExclusive > minInclusive (got ${minInclusive}, ${maxExclusive})`,
        )
      }
      return minInclusive + Math.floor(next() * (maxExclusive - minInclusive))
    },
    bool(probability = 0.5): boolean {
      return next() < probability
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('rng.pick requires a non-empty array')
      return items[rng.int(0, items.length)] as T
    },
    shuffle<T>(items: readonly T[]): T[] {
      const copy = items.slice()
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = rng.int(0, i + 1)
        const a = copy[i] as T
        const b = copy[j] as T
        copy[i] = b
        copy[j] = a
      }
      return copy
    },
    fork(label: string): Rng {
      return createRng(deriveSeed(seed, 'fork', label))
    },
  }

  return rng
}

/**
 * The single place where a match's per-mutation stream is derived.
 *
 * Both `@playhall/platform-core` (production) and `@playhall/game-testkit`
 * (conformance tests) call this, so a replay in a test and a replay on the
 * server cannot drift.
 */
export function createContextRng(seed: MatchSeed, sequence: number): Rng {
  return createRng(deriveSeed(seed, sequence))
}

/**
 * Builds a match seed from platform entropy. Called once, on the server, when
 * the match starts; the result is stored on the match. This is the only point
 * in the system where non-determinism is allowed to enter a game.
 */
export function createMatchSeed(entropy: string): MatchSeed {
  return asMatchSeed(entropy)
}
