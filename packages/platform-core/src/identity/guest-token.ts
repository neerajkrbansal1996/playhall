/**
 * Signed guest tokens.
 *
 * v1 has no accounts. A guest's whole identity is a short signed string in an
 * HttpOnly cookie, so the signature is the only thing standing between a player
 * and somebody else's seat. Consequences, all of which show up below:
 *
 * - **Sign before you parse.** The payload is untrusted bytes until the MAC
 *   checks out, so nothing looks inside it first — not even to read the key id,
 *   which is why `kid` lives in its own unsigned-but-covered segment rather
 *   than inside the payload.
 * - **Constant-time comparison.** `===` on a hex digest leaks a byte at a time.
 * - **A keyring, not a key.** Rotating a signing secret must not sign every
 *   player out. The first key signs; any key may verify.
 * - **`now` is injected.** The platform has one clock and it is
 *   server-authoritative; a token that expires according to the machine's
 *   ambient time is untestable and drifts from the timer service.
 *
 * Format: `v1.<kid>.<payload>.<sig>`, all base64url, signature computed over
 * the literal `v1.<kid>.<payload>` prefix so a token cannot be replayed under a
 * different key id or version.
 *
 * The token is deliberately not a JWT. We would use one algorithm, reject
 * every other, and still inherit `alg: none` and the confused-deputy bugs that
 * come with a header the attacker writes.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { type Result, err, ok } from '@playhall/game-sdk'
import { z } from 'zod'

export const GUEST_TOKEN_VERSION = 'v1'

/** Shortest secret we will sign with: 256 bits, matching HMAC-SHA256's block. */
export const MIN_SIGNING_KEY_BYTES = 32

export interface GuestTokenKey {
  /** Key id, carried in the token so rotation can verify old tokens. */
  readonly kid: string
  /** Raw secret. Never logged, never serialised into the token. */
  readonly secret: Uint8Array
}

/**
 * Ordered keyring. `keys[0]` signs; every entry may verify. Rotate by
 * unshifting a new key and dropping the tail once the old TTL has elapsed.
 */
export type GuestKeyring = readonly [GuestTokenKey, ...GuestTokenKey[]]

/**
 * Claims. Short names because this rides in a cookie on every request from a
 * phone on mobile data, and the whole token stays under ~250 bytes.
 *
 * Nothing here is personal data: `gid` is a random opaque id, `nam` is a
 * self-chosen display name, and there is no email, no IP and no device id.
 */
export const GuestClaimsSchema = z.object({
  /** Guest id. Stable for the life of the cookie; the player's identity. */
  gid: z.string().min(1).max(64),
  /** Session id: one browsing context. Newest session wins (see sessions.ts). */
  sid: z.string().min(1).max(64),
  /** Sanitised display name. Re-validated on read; see `service.ts`. */
  nam: z.string().min(1).max(64),
  /** Issued at, seconds since epoch. */
  iat: z.number().int().nonnegative(),
  /** Expires at, seconds since epoch. */
  exp: z.number().int().nonnegative(),
})

export type GuestClaims = z.infer<typeof GuestClaimsSchema>

export const GUEST_TOKEN_FAILURES = [
  /** Not four segments, or a segment is not base64url. */
  'malformed',
  /** Signed under a version this build does not accept. */
  'unsupported_version',
  /** `kid` is not in the keyring — usually a rotated-out key. */
  'unknown_key',
  /** The MAC did not match. The token was edited, forged, or truncated. */
  'bad_signature',
  /** Signature was good but the payload is not valid claims. */
  'invalid_claims',
  /** Signature and claims were good; `exp` has passed. */
  'expired',
] as const

export type GuestTokenFailure = (typeof GUEST_TOKEN_FAILURES)[number]

export interface GuestTokenRejection {
  readonly reason: GuestTokenFailure
  /** Developer-facing detail. Never contains key material. */
  readonly message?: string
}

function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function base64urlDecode(value: string): Buffer | undefined {
  // Buffer is lenient: it ignores trailing junk instead of failing. Re-encode
  // and compare so a tampered segment that happens to decode is still caught
  // here rather than surviving to the signature check as different bytes.
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) return undefined
  return decoded
}

function sign(signingInput: string, key: GuestTokenKey): Buffer {
  return createHmac('sha256', key.secret).update(signingInput, 'utf8').digest()
}

/** Throws on a short secret. A weak key is a deployment bug, not a request error. */
export function assertUsableKey(key: GuestTokenKey): void {
  if (key.secret.length < MIN_SIGNING_KEY_BYTES) {
    throw new Error(
      `Guest token signing key "${key.kid}" is ${key.secret.length} bytes; ` +
        `at least ${MIN_SIGNING_KEY_BYTES} are required.`,
    )
  }
}

export function signGuestToken(claims: GuestClaims, keyring: GuestKeyring): string {
  const key = keyring[0]
  assertUsableKey(key)
  if (!/^[A-Za-z0-9_-]+$/.test(key.kid)) {
    throw new Error(`Guest token key id "${key.kid}" must be base64url-safe.`)
  }

  const payload = base64urlEncode(Buffer.from(JSON.stringify(GuestClaimsSchema.parse(claims))))
  const signingInput = `${GUEST_TOKEN_VERSION}.${key.kid}.${payload}`
  return `${signingInput}.${base64urlEncode(sign(signingInput, key))}`
}

export interface VerifyGuestTokenOptions {
  /** Server-authoritative time, seconds since epoch. Required — see module doc. */
  readonly now: number
  /** Tolerance for clock skew between instances, in seconds. */
  readonly clockToleranceSeconds?: number
}

export function verifyGuestToken(
  token: string,
  keyring: GuestKeyring,
  options: VerifyGuestTokenOptions,
): Result<GuestClaims, GuestTokenRejection> {
  const segments = token.split('.')
  if (segments.length !== 4) return err({ reason: 'malformed', message: 'expected 4 segments' })

  const [version, kid, payload, signature] = segments as [string, string, string, string]
  if (version !== GUEST_TOKEN_VERSION) return err({ reason: 'unsupported_version' })

  const provided = base64urlDecode(signature)
  const payloadBytes = base64urlDecode(payload)
  if (provided === undefined || payloadBytes === undefined) {
    return err({ reason: 'malformed', message: 'segment is not base64url' })
  }

  const key = keyring.find((candidate) => candidate.kid === kid)
  if (key === undefined) return err({ reason: 'unknown_key' })

  const expected = sign(`${version}.${kid}.${payload}`, key)
  // Length check first: timingSafeEqual throws on a mismatch, and the length of
  // a SHA-256 digest is not a secret.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return err({ reason: 'bad_signature' })
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return err({ reason: 'invalid_claims', message: 'payload is not JSON' })
  }

  const claims = GuestClaimsSchema.safeParse(parsedJson)
  if (!claims.success) {
    return err({ reason: 'invalid_claims', message: claims.error.issues[0]?.message })
  }

  const tolerance = options.clockToleranceSeconds ?? 0
  if (claims.data.exp + tolerance <= options.now) return err({ reason: 'expired' })

  return ok(claims.data)
}

/**
 * Reads the claims without verifying. Exists for one caller: structured logging
 * of a rejected token. Never let its result reach a decision.
 *
 * @internal
 */
export function unsafeDecodeGuestToken(token: string): unknown {
  const payload = token.split('.')[2]
  if (payload === undefined) return undefined
  const bytes = base64urlDecode(payload)
  if (bytes === undefined) return undefined
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
}
