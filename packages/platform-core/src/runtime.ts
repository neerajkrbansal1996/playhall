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
 * A clock that advances by `stepMs` on every *read*, on top of whatever the
 * test sets by hand.
 *
 * It exists to keep `fixedClock` honest. Under a constant clock every write in
 * a test carries the same `updatedAt`, which is what let a compare-and-set
 * comparing `updatedAt` look correct for an entire green suite — the token
 * never changed, so the check never had an opportunity to fire. Running the
 * same concurrency assertions under both clocks is what proves the CAS depends
 * on `Room.version` and not on the wall clock: one of the two clocks would
 * catch a regression either way round.
 */
export function tickingClock(startEpochMs: number, stepMs = 1): MutableClock {
  let current = startEpochMs
  return {
    now: () => {
      const reading = current
      current += stepMs
      return reading
    },
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
 * expose globally.
 *
 * Deliberately not `node:crypto`, but the reason is narrower than the one this
 * comment used to give. It claimed "this package has to stay importable from an
 * edge runtime", which is not true as written — `identity/guest-token.ts` signs
 * with `node:crypto`, and because `src/index.ts` re-exports the whole package,
 * one entrypoint decides the answer for every module behind it. Measured in
 * ADR-0011 §3: a Next.js Edge middleware importing nothing but `readGuestCookie`
 * still fails `next build`, because the barrel is not tree-shaken.
 *
 * What is true (ADR-0011):
 *
 * - `@playhall/platform-core` — the default entrypoint — targets **Node** and
 *   **Cloudflare Workers**. Both support `node:crypto` in full, so it may use it.
 *   It is **not** importable from Next.js Edge middleware.
 * - An edge consumer imports `@playhall/platform-core/edge`, a second entrypoint
 *   whose module graph reaches no Node builtin. It carries the cookie reader and
 *   these ports, and it is built when the first edge consumer lands — there is
 *   none today.
 *
 * So this function is not load-bearing for a package-wide invariant. It is the
 * default `RandomSource` because a port is the right shape for an ambient
 * capability (see the module doc above), and it is what the `/edge` entrypoint
 * exports when it exists.
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
