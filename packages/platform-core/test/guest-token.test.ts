import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  GUEST_TOKEN_VERSION,
  type GuestClaims,
  type GuestKeyring,
  type GuestTokenKey,
  MIN_SIGNING_KEY_BYTES,
  assertUsableKey,
  signGuestToken,
  unsafeDecodeGuestToken,
  verifyGuestToken,
} from '../src/identity/guest-token.js'

const KEY: GuestTokenKey = { kid: 'k1', secret: Buffer.alloc(32, 7) }
const ROTATED: GuestTokenKey = { kid: 'k2', secret: Buffer.alloc(32, 9) }
const KEYRING: GuestKeyring = [KEY]

const NOW = 1_700_000_000
const CLAIMS: GuestClaims = {
  gid: 'guest-abc',
  sid: 'session-1',
  nam: 'Swift Otter',
  iat: NOW,
  exp: NOW + 3600,
}

function reasonFor(token: string, keyring: GuestKeyring = KEYRING, now = NOW): string {
  const result = verifyGuestToken(token, keyring, { now })
  if (result.ok) throw new Error('expected the token to be rejected')
  return result.error.reason
}

function mutateSegment(token: string, index: number, replacement: string): string {
  const segments = token.split('.')
  segments[index] = replacement
  return segments.join('.')
}

describe('signGuestToken', () => {
  it('produces a four-segment v1 token carrying the key id', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    const segments = token.split('.')
    expect(segments).toHaveLength(4)
    expect(segments[0]).toBe(GUEST_TOKEN_VERSION)
    expect(segments[1]).toBe('k1')
  })

  it('is deterministic for the same claims and key', () => {
    expect(signGuestToken(CLAIMS, KEYRING)).toBe(signGuestToken(CLAIMS, KEYRING))
  })

  it('stays small enough to ride on every request from a phone', () => {
    // Budget: the cookie must not become a meaningful share of a mobile request.
    const token = signGuestToken({ ...CLAIMS, nam: 'A'.repeat(20) }, KEYRING)
    expect(token.length).toBeLessThan(250)
  })

  it('never puts key material in the token', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    expect(token).not.toContain(Buffer.from(KEY.secret).toString('base64url'))
  })

  it('refuses a secret shorter than the digest it is protecting', () => {
    const weak: GuestKeyring = [{ kid: 'weak', secret: Buffer.alloc(16, 1) }]
    expect(() => signGuestToken(CLAIMS, weak)).toThrow(/at least 32/)
    expect(() => assertUsableKey(weak[0])).toThrow()
    expect(() => assertUsableKey(KEY)).not.toThrow()
    expect(MIN_SIGNING_KEY_BYTES).toBe(32)
  })

  it('refuses a key id that would break the token grammar', () => {
    const bad: GuestKeyring = [{ kid: 'has.dot', secret: Buffer.alloc(32, 1) }]
    expect(() => signGuestToken(CLAIMS, bad)).toThrow(/base64url-safe/)
  })
})

describe('verifyGuestToken — happy path', () => {
  it('round-trips the claims exactly', () => {
    const result = verifyGuestToken(signGuestToken(CLAIMS, KEYRING), KEYRING, { now: NOW })
    expect(result).toEqual({ ok: true, value: CLAIMS })
  })

  it('verifies a token signed by a rotated-out key still on the ring', () => {
    const oldRing: GuestKeyring = [ROTATED]
    const token = signGuestToken(CLAIMS, oldRing)
    // New key signs, old key still verifies: rotation does not sign anyone out.
    const afterRotation: GuestKeyring = [KEY, ROTATED]
    expect(verifyGuestToken(token, afterRotation, { now: NOW }).ok).toBe(true)
  })
})

describe('verifyGuestToken — tamper rejection', () => {
  it('rejects an edited payload', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    const forged = Buffer.from(JSON.stringify({ ...CLAIMS, gid: 'somebody-else' })).toString(
      'base64url',
    )
    expect(reasonFor(mutateSegment(token, 2, forged))).toBe('bad_signature')
  })

  it('rejects a single flipped character in the payload', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    const payload = token.split('.')[2] as string
    const flipped = (payload[0] === 'a' ? 'b' : 'a') + payload.slice(1)
    expect(reasonFor(mutateSegment(token, 2, flipped))).toBe('bad_signature')
  })

  it('rejects a single flipped character in the signature', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    const signature = token.split('.')[3] as string
    const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A')
    expect(reasonFor(mutateSegment(token, 3, flipped))).toBe('bad_signature')
  })

  it('rejects a signature computed with a different secret', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    const [version, kid, payload] = token.split('.') as [string, string, string]
    const wrong = createHmac('sha256', ROTATED.secret)
      .update(`${version}.${kid}.${payload}`, 'utf8')
      .digest('base64url')
    expect(reasonFor(`${version}.${kid}.${payload}.${wrong}`)).toBe('bad_signature')
  })

  it('rejects a token re-labelled with another key id on the ring', () => {
    // Signature covers `version.kid.payload`, so swapping kid invalidates it
    // even when the attacker picks a kid that exists.
    const token = signGuestToken(CLAIMS, [KEY, ROTATED] as GuestKeyring)
    expect(reasonFor(mutateSegment(token, 1, 'k2'), [KEY, ROTATED] as GuestKeyring)).toBe(
      'bad_signature',
    )
  })

  it('rejects an unknown key id without attempting a comparison', () => {
    const token = signGuestToken(CLAIMS, [ROTATED] as GuestKeyring)
    expect(reasonFor(token)).toBe('unknown_key')
  })

  it('rejects a downgraded version', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    expect(reasonFor(mutateSegment(token, 0, 'v0'))).toBe('unsupported_version')
  })

  it.each([
    ['empty', ''],
    ['no segments', 'nonsense'],
    ['three segments', 'v1.k1.payload'],
    ['five segments', 'v1.k1.payload.sig.extra'],
    ['non-base64url payload', 'v1.k1.not base64!.sig'],
    ['non-canonical base64 padding', 'v1.k1.YQ==.sig'],
  ])('rejects a malformed token: %s', (_label, token) => {
    expect(reasonFor(token)).toBe('malformed')
  })

  it('rejects a truncated signature that is no longer canonical base64url', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    const signature = token.split('.')[3] as string
    // 10 base64url characters do not encode a whole number of bytes, so this is
    // caught at the decode step rather than the compare step.
    expect(reasonFor(mutateSegment(token, 3, signature.slice(0, 10)))).toBe('malformed')
  })

  it('rejects a well-formed signature of the wrong length', () => {
    // Exercises the length guard in front of timingSafeEqual, which throws
    // rather than returning false when the buffers differ in size.
    const token = signGuestToken(CLAIMS, KEYRING)
    const short = randomBytes(16).toString('base64url')
    expect(reasonFor(mutateSegment(token, 3, short))).toBe('bad_signature')
  })

  it('rejects an authentically signed payload that is not valid claims', () => {
    // The insider case: a build with a bug, or a key that leaked and was used
    // to mint garbage. A good signature is not a good payload.
    const payload = Buffer.from(JSON.stringify({ gid: 'x' })).toString('base64url')
    const signingInput = `${GUEST_TOKEN_VERSION}.k1.${payload}`
    const signature = createHmac('sha256', KEY.secret)
      .update(signingInput, 'utf8')
      .digest('base64url')
    expect(reasonFor(`${signingInput}.${signature}`)).toBe('invalid_claims')
  })

  it('rejects an authentically signed payload that is not JSON', () => {
    const payload = Buffer.from('not json').toString('base64url')
    const signingInput = `${GUEST_TOKEN_VERSION}.k1.${payload}`
    const signature = createHmac('sha256', KEY.secret)
      .update(signingInput, 'utf8')
      .digest('base64url')
    expect(reasonFor(`${signingInput}.${signature}`)).toBe('invalid_claims')
  })

  it('rejects randomly generated tokens', () => {
    for (let i = 0; i < 200; i += 1) {
      const token = `v1.k1.${randomBytes(48).toString('base64url')}.${randomBytes(32).toString('base64url')}`
      expect(verifyGuestToken(token, KEYRING, { now: NOW }).ok).toBe(false)
    }
  })
})

describe('verifyGuestToken — expiry', () => {
  it('accepts up to the last second before exp', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    expect(verifyGuestToken(token, KEYRING, { now: CLAIMS.exp - 1 }).ok).toBe(true)
  })

  it('rejects at exp', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    expect(reasonFor(token, KEYRING, CLAIMS.exp)).toBe('expired')
  })

  it('rejects well after exp', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    expect(reasonFor(token, KEYRING, CLAIMS.exp + 86_400)).toBe('expired')
  })

  it('honours a clock-skew tolerance between instances', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    const justAfter = CLAIMS.exp + 5
    expect(verifyGuestToken(token, KEYRING, { now: justAfter }).ok).toBe(false)
    expect(verifyGuestToken(token, KEYRING, { now: justAfter, clockToleranceSeconds: 30 }).ok).toBe(
      true,
    )
  })

  it('checks the signature before expiry, so a stale forgery reads as a forgery', () => {
    const token = signGuestToken(CLAIMS, KEYRING)
    const payload = token.split('.')[2] as string
    const flipped = (payload[0] === 'a' ? 'b' : 'a') + payload.slice(1)
    expect(reasonFor(mutateSegment(token, 2, flipped), KEYRING, CLAIMS.exp + 1)).toBe(
      'bad_signature',
    )
  })
})

describe('unsafeDecodeGuestToken', () => {
  it('reads claims off an unverified token for logging', () => {
    expect(unsafeDecodeGuestToken(signGuestToken(CLAIMS, KEYRING))).toEqual(CLAIMS)
  })

  it('returns undefined rather than throwing on junk', () => {
    expect(unsafeDecodeGuestToken('v1')).toBeUndefined()
    expect(unsafeDecodeGuestToken('v1.k1.!!!.sig')).toBeUndefined()
    const payload = Buffer.from('not json').toString('base64url')
    expect(unsafeDecodeGuestToken(`v1.k1.${payload}.sig`)).toBeUndefined()
  })
})
