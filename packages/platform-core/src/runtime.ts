/**
 * Ambient capabilities, as injected ports.
 *
 * Nothing in `platform-core` reads the wall clock or the system CSPRNG
 * directly. Two reasons, and neither is style:
 *
 * 1. **The lint rule.** `Date.now` and `Math.random` are banned in every
 *    package's `src` tree (ADR-0002 §4). The composition root —
 *    `apps/realtime` — is exempt and is where the real implementations live.
 * 2. **Testability of time.** Every lifecycle rule in this package is a
 *    deadline. A test that has to sleep 30 minutes is a test nobody runs, so
 *    the clock is a value we control.
 *
 * `Clock.now()` is epoch milliseconds and is the single source of truth for
 * every deadline the platform enforces. A client-supplied timestamp never
 * reaches it.
 */

export interface Clock {
  /** Epoch milliseconds, server-authoritative. */
  now(): number
}

/** A clock a test drives by hand. Also used by the lifecycle sweeper tests. */
export interface MutableClock extends Clock {
  set(epochMs: number): void
  advance(deltaMs: number): void
}

export function fixedClock(startEpochMs: number): MutableClock {
  let current = startEpochMs
  return {
    now: () => current,
    set: (epochMs: number) => {
      current = epochMs
    },
    advance: (deltaMs: number) => {
      current += deltaMs
    },
  }
}

/**
 * Cryptographically strong bytes. Room codes are guessable-by-construction
 * (31^6), so the generator must at least not be *predictable* on top of that;
 * the real defence is the per-IP failed-join cap.
 */
export interface RandomSource {
  /** Fills and returns a buffer of `length` uniformly random bytes. */
  randomBytes(length: number): Uint8Array
}

/**
 * Backed by the Web Crypto API, which Node 19+ and every supported browser
 * expose globally. Deliberately not `node:crypto` — this package has to stay
 * importable from an edge runtime.
 */
export function webCryptoRandomSource(): RandomSource {
  return {
    randomBytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length)
      globalThis.crypto.getRandomValues(bytes)
      return bytes
    },
  }
}

/**
 * A deterministic source for tests: cycles the supplied bytes. Never use it
 * for anything a player can see.
 */
export function sequenceRandomSource(sequence: readonly number[]): RandomSource {
  if (sequence.length === 0) throw new RangeError('sequenceRandomSource needs at least one byte')
  let cursor = 0
  return {
    randomBytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length)
      for (let index = 0; index < length; index += 1) {
        bytes[index] = sequence[cursor % sequence.length]! & 0xff
        cursor += 1
      }
      return bytes
    },
  }
}

/** Opaque id minting (room ids, match ids). Injected for the same reasons. */
export interface IdSource {
  newId(): string
}

export function randomIdSource(random: RandomSource, byteLength = 16): IdSource {
  return {
    newId(): string {
      const bytes = random.randomBytes(byteLength)
      let out = ''
      for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
      return out
    },
  }
}

/** Monotonically numbered ids. Tests only. */
export function countingIdSource(prefix = 'id'): IdSource {
  let counter = 0
  return {
    newId(): string {
      counter += 1
      return `${prefix}-${counter}`
    },
  }
}
