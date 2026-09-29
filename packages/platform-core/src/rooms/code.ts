/**
 * Room-code generation.
 *
 * The alphabet itself lives in `@playhall/shared` because the client normalises
 * input against it too. This module owns the two things only the server may
 * do: draw a code without modulo bias, and retry until the code is free.
 *
 * Codes are **global across games**. A code resolves its own game, so
 * `/r/ABC123` is a universal room link and a player never has to know which
 * game they were invited to before they can open it.
 */

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isValidRoomCode } from '@playhall/shared'
import type { RandomSource } from '../runtime.js'

/** 31^6 = 887,503,681. Reported so the collision budget stays visible. */
export const ROOM_CODE_SPACE = ROOM_CODE_ALPHABET.length ** ROOM_CODE_LENGTH

/**
 * Largest multiple of the alphabet size that fits in a byte (31 * 8 = 248).
 * A byte at or above this is discarded rather than folded, which is what keeps
 * the draw uniform — plain `byte % 31` would make the first eight characters
 * of the alphabet ~3% more likely, and a biased code space is a smaller code
 * space.
 */
const REJECTION_CEILING = ROOM_CODE_ALPHABET.length * Math.floor(256 / ROOM_CODE_ALPHABET.length)

/**
 * Draws one uniformly random, alphabet-safe code.
 *
 * Each round asks for exactly the number of bytes still needed and examines
 * every one of them, rejecting the 8 out-of-range values. Requesting exactly
 * what is needed — rather than over-reading a block and discarding its tail —
 * costs about 1.2 rounds per code (the rejection rate is 8/256 ≈ 3.1%) and
 * keeps the byte stream fully consumed, which is what makes the uniformity
 * property testable with a deterministic source instead of a statistic.
 */
export function generateRoomCode(random: RandomSource, length = ROOM_CODE_LENGTH): string {
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`room code length must be a positive integer, got ${length}`)
  }

  const out: string[] = []
  while (out.length < length) {
    for (const byte of random.randomBytes(length - out.length)) {
      if (byte >= REJECTION_CEILING) continue
      out.push(ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]!)
    }
  }
  return out.join('')
}

export interface RoomCodeAllocation {
  readonly code: string
  /** How many draws collided before this one was free. Emit as a metric. */
  readonly collisions: number
}

export class RoomCodeExhaustionError extends Error {
  constructor(readonly attempts: number) {
    super(
      `could not allocate a free room code in ${attempts} attempts; ` +
        `the code space (${ROOM_CODE_SPACE}) is saturated or the reservation store is failing`,
    )
    this.name = 'RoomCodeExhaustionError'
  }
}

/**
 * Draws codes until `reserve` accepts one.
 *
 * `reserve` must be atomic — a check-then-write lets two rooms share a code
 * under concurrency. The Redis implementation is `SET key value NX`; the
 * in-memory one is a `Map` guarded by the single-threaded event loop.
 *
 * With 2,000 live rooms the collision probability per draw is
 * 2000 / 887,503,681 ≈ 2.3e-6, so `maxAttempts: 8` leaves a failure
 * probability below 1e-45. The cap exists to surface a broken store, not to
 * ration retries.
 */
export async function allocateRoomCode(
  random: RandomSource,
  reserve: (code: string) => Promise<boolean> | boolean,
  maxAttempts = 8,
): Promise<RoomCodeAllocation> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generateRoomCode(random)
    if (await reserve(code)) return { code, collisions: attempt }
  }
  throw new RoomCodeExhaustionError(maxAttempts)
}

/**
 * Whether a string is exactly a canonical room code. Re-exported from here so
 * room callers have one import; the implementation is shared with the client.
 */
export { isValidRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH }
