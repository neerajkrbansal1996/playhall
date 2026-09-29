import { z } from 'zod'

/**
 * The correlation id is a **platform contract**, not a web concern.
 *
 * It is minted at the edge of the *first* hop and carried across the
 * web -> realtime boundary as an explicit field on the join/handshake message.
 * It is never recovered from a Node-specific request object and never from an
 * `AsyncLocalStorage` that exists in only one process: the moment `apps/web`
 * and `apps/realtime` sit on different hosts — which every hosting candidate
 * on ADR-0003 implies — an implicitly-propagated id stops correlating and
 * "filter one room's logs by correlation id" silently becomes untrue.
 *
 * Room id and correlation id are **distinct**. A correlation id follows one
 * player's causal chain (landing -> lobby -> join -> first action); a room id
 * groups every player in one match. Both belong on every realtime log line.
 */

/** HTTP header used to carry an already-minted id into a later hop. */
export const CORRELATION_ID_HEADER = 'x-correlation-id'

/** Wire field name on the join/handshake message. Do not rename casually. */
export const CORRELATION_ID_FIELD = 'correlationId'

/** 16 random bytes rendered as lowercase base32 without padding. */
export const CORRELATION_ID_LENGTH = 26

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const CORRELATION_ID_PATTERN = new RegExp(`^[${BASE32}]{${CORRELATION_ID_LENGTH}}$`)

export const CorrelationIdSchema = z
  .string()
  .regex(CORRELATION_ID_PATTERN, 'Not a well-formed correlation id.')

export type CorrelationId = string

/**
 * Byte source for id minting. Injected so the facade stays runtime-agnostic and
 * so tests are deterministic — a module-level `crypto` capture would bind us to
 * whichever runtime loaded the module first.
 */
export type RandomBytes = (byteLength: number) => Uint8Array

/**
 * Uses the Web Crypto global, which exists in Node 22 and in `workerd`. Throws
 * rather than silently degrading to a weak source.
 */
export const webCryptoRandomBytes: RandomBytes = (byteLength) => {
  const webcrypto = globalThis.crypto
  if (!webcrypto?.getRandomValues) {
    throw new Error('No Web Crypto available; pass an explicit RandomBytes source.')
  }
  return webcrypto.getRandomValues(new Uint8Array(byteLength))
}

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32.charAt((value >>> bits) & 31)
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31)
  return out
}

/** Mint a fresh correlation id. 128 bits of entropy, 26 base32 characters. */
export function mintCorrelationId(random: RandomBytes = webCryptoRandomBytes): CorrelationId {
  return encodeBase32(random(16)).slice(0, CORRELATION_ID_LENGTH)
}

/**
 * Accept a client-supplied id only if it is well formed. A malformed or absent
 * id is replaced, never trusted and never echoed: an unvalidated id is a free
 * log-injection channel for anything that reads our log stream.
 */
export function parseCorrelationId(value: unknown): CorrelationId | undefined {
  const parsed = CorrelationIdSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export interface ResolvedCorrelationId {
  readonly correlationId: CorrelationId
  /** True when the inbound value was absent or malformed and we minted a new one. */
  readonly minted: boolean
}

/**
 * The single entry point every hop uses: take whatever arrived, keep it if it
 * is valid, otherwise mint. `minted: true` on a hop that should have received
 * an id means propagation is broken upstream — log it, do not hide it.
 */
export function resolveCorrelationId(
  inbound: unknown,
  random: RandomBytes = webCryptoRandomBytes,
): ResolvedCorrelationId {
  const existing = parseCorrelationId(inbound)
  if (existing) return { correlationId: existing, minted: false }
  return { correlationId: mintCorrelationId(random), minted: true }
}
