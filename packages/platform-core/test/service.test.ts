import { describe, expect, it } from 'vitest'
import {
  type GuestIdentityService,
  type GuestIdentityServiceConfig,
  createGuestIdentityService,
} from '../src/identity/service.js'
import { GUEST_COOKIE_NAME, GUEST_TOKEN_TTL_SECONDS } from '../src/identity/cookie.js'
import type { GuestKeyring } from '../src/identity/guest-token.js'
import { avatarFor } from '../src/identity/avatar.js'
import { suggestDisplayNameFor } from '../src/identity/fun-names.js'

const KEYRING: GuestKeyring = [{ kid: 'k1', secret: Buffer.alloc(32, 7) }]
const NOW_MS = 1_700_000_000_000
const NOW_SECONDS = 1_700_000_000

/**
 * Counter-based entropy: every id is distinct, and every token in this file is
 * byte-reproducible, which is what lets the assertions below compare tokens
 * rather than just shapes.
 */
function countingRandomBytes(): (size: number) => Uint8Array {
  let counter = 0
  return (size: number) => {
    counter += 1
    const bytes = Buffer.alloc(size)
    bytes.writeUInt32BE(counter, 0)
    return bytes
  }
}

function makeService(overrides: Partial<GuestIdentityServiceConfig> = {}): GuestIdentityService {
  return createGuestIdentityService({
    keyring: KEYRING,
    randomBytes: countingRandomBytes(),
    ...overrides,
  })
}

function issueOrThrow(
  service: GuestIdentityService,
  options: Parameters<GuestIdentityService['issue']>[0],
) {
  const result = service.issue(options)
  if (!result.ok) throw new Error(`issue failed: ${result.error.reason}`)
  return result.value
}

/** Turns a `Set-Cookie` value into the `Cookie` header a browser would send back. */
function asRequestCookie(setCookie: string): string {
  return setCookie.split(';')[0] as string
}

describe('issue', () => {
  it('mints a guest, signs a token and returns a ready-to-send cookie', () => {
    const { identity, token, setCookie } = issueOrThrow(makeService(), {
      now: NOW_MS,
      requestedName: 'Swift Otter',
    })

    expect(identity.displayName).toBe('Swift Otter')
    expect(identity.guestId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(identity.sessionId).not.toBe(identity.guestId)
    expect(identity.issuedAt).toBe(NOW_SECONDS)
    expect(identity.expiresAt).toBe(NOW_SECONDS + GUEST_TOKEN_TTL_SECONDS)
    expect(setCookie.startsWith(`${GUEST_COOKIE_NAME}=${token}`)).toBe(true)
    expect(setCookie).toContain('HttpOnly')
  })

  it('collects no personal data — the token carries only the six declared claims', () => {
    const { token } = issueOrThrow(makeService(), { now: NOW_MS, requestedName: 'Swift Otter' })
    const payload = JSON.parse(
      Buffer.from(token.split('.')[2] as string, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['exp', 'gid', 'iat', 'nam', 'sid'])
  })

  it('falls back to the pre-filled suggestion when the player types nothing', () => {
    // Zero friction (principle 3): a blank field is the player accepting the
    // suggestion, not an error to send back to them.
    for (const requestedName of [undefined, null, '', '   ']) {
      const { identity } = issueOrThrow(makeService(), { now: NOW_MS, requestedName })
      expect(identity.displayName).toBe(suggestDisplayNameFor(identity.guestId))
    }
  })

  it('exposes the same suggestion the form pre-fills', () => {
    const service = makeService()
    expect(service.suggestNameFor('guest-abc')).toBe(suggestDisplayNameFor('guest-abc'))
  })

  it('stores the sanitised name, not the raw input', () => {
    const { identity } = issueOrThrow(makeService(), {
      now: NOW_MS,
      requestedName: '  Swift   Otter  ',
    })
    expect(identity.displayName).toBe('Swift Otter')
  })

  it('rejects a bad name with the reason the form needs', () => {
    const service = makeService()
    expect(service.issue({ now: NOW_MS, requestedName: 'A' })).toEqual({
      ok: false,
      error: { kind: 'invalid_name', reason: 'too_short', sanitized: 'A' },
    })
    const profane = service.issue({ now: NOW_MS, requestedName: 'shit lord' })
    expect(profane.ok).toBe(false)
    if (!profane.ok) expect(profane.error.reason).toBe('profanity')
  })

  it('rejects markup in a requested name', () => {
    const result = makeService().issue({ now: NOW_MS, requestedName: '<script>alert(1)</script>' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toBe('invalid_characters')
  })

  it('attaches a deterministic avatar', () => {
    const { identity } = issueOrThrow(makeService(), { now: NOW_MS, requestedName: 'Ada Lovelace' })
    expect(identity.avatar).toEqual(avatarFor(identity.guestId, 'Ada Lovelace'))
    expect(identity.avatar.initials).toBe('AL')
  })

  it('mints a distinct guest id per call', () => {
    const service = makeService()
    const ids = new Set<string>()
    for (let i = 0; i < 50; i += 1) {
      ids.add(issueOrThrow(service, { now: NOW_MS, requestedName: 'Ada' }).identity.guestId)
    }
    expect(ids.size).toBe(50)
  })

  it('keeps the guest id and avatar across a rename', () => {
    const service = makeService()
    const first = issueOrThrow(service, { now: NOW_MS, requestedName: 'Ada Lovelace' })
    const renamed = issueOrThrow(service, {
      now: NOW_MS + 60_000,
      requestedName: 'Grace Hopper',
      guestId: first.identity.guestId,
      sessionId: first.identity.sessionId,
    })
    expect(renamed.identity.guestId).toBe(first.identity.guestId)
    expect(renamed.identity.avatar.color).toEqual(first.identity.avatar.color)
    expect(renamed.identity.displayName).toBe('Grace Hopper')
  })

  it('honours a configured TTL in both the token and the cookie', () => {
    const { identity, setCookie } = issueOrThrow(makeService({ ttlSeconds: 600 }), {
      now: NOW_MS,
      requestedName: 'Ada',
    })
    expect(identity.expiresAt).toBe(NOW_SECONDS + 600)
    expect(setCookie).toContain('Max-Age=600')
  })

  it('passes cookie options through', () => {
    const { setCookie } = issueOrThrow(makeService({ cookie: { secure: false } }), {
      now: NOW_MS,
      requestedName: 'Ada',
    })
    expect(setCookie).not.toContain('Secure')
  })

  it('applies the configured name policy', () => {
    const service = makeService({ nameOptions: { extraTerms: ['adminbot'] } })
    expect(service.issue({ now: NOW_MS, requestedName: 'Admin Bot' }).ok).toBe(false)
  })
})

describe('authenticate', () => {
  it('turns a cookie back into the identity it was issued for', () => {
    const service = makeService()
    const issued = issueOrThrow(service, { now: NOW_MS, requestedName: 'Swift Otter' })
    const result = service.authenticate(asRequestCookie(issued.setCookie), NOW_MS + 60_000)
    expect(result).toEqual({ ok: true, value: issued.identity })
  })

  it('gives the same identity on a later request — stable across sessions', () => {
    const service = makeService()
    const issued = issueOrThrow(service, { now: NOW_MS, requestedName: 'Swift Otter' })
    const cookie = asRequestCookie(issued.setCookie)
    const later = service.authenticate(cookie, NOW_MS + 29 * 86_400_000)
    expect(later.ok).toBe(true)
    if (later.ok) {
      expect(later.value.guestId).toBe(issued.identity.guestId)
      expect(later.value.avatar).toEqual(issued.identity.avatar)
    }
  })

  it('reports a missing cookie distinctly from a bad one', () => {
    const service = makeService()
    expect(service.authenticate(undefined, NOW_MS)).toEqual({
      ok: false,
      error: { kind: 'no_cookie' },
    })
    expect(service.authenticate('other=1', NOW_MS)).toEqual({
      ok: false,
      error: { kind: 'no_cookie' },
    })
  })

  it('rejects a tampered cookie', () => {
    // The done-criterion for this issue, exercised end to end through the
    // service rather than only at the token layer.
    const service = makeService()
    const issued = issueOrThrow(service, { now: NOW_MS, requestedName: 'Swift Otter' })
    const forgedPayload = Buffer.from(
      JSON.stringify({
        gid: 'somebody-else',
        sid: issued.identity.sessionId,
        nam: 'Impostor',
        iat: NOW_SECONDS,
        exp: NOW_SECONDS + 3600,
      }),
    ).toString('base64url')
    const segments = issued.token.split('.')
    segments[2] = forgedPayload
    const result = service.authenticate(`${GUEST_COOKIE_NAME}=${segments.join('.')}`, NOW_MS)
    expect(result).toEqual({ ok: false, error: { kind: 'invalid_token', reason: 'bad_signature' } })
  })

  it('rejects a cookie signed by a key that is no longer on the ring', () => {
    const issued = issueOrThrow(makeService(), { now: NOW_MS, requestedName: 'Swift Otter' })
    const rotated = makeService({ keyring: [{ kid: 'k2', secret: Buffer.alloc(32, 9) }] })
    const result = rotated.authenticate(asRequestCookie(issued.setCookie), NOW_MS)
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toMatchObject({ kind: 'invalid_token', reason: 'unknown_key' })
  })

  it('rejects an expired cookie', () => {
    const service = makeService({ ttlSeconds: 600 })
    const issued = issueOrThrow(service, { now: NOW_MS, requestedName: 'Swift Otter' })
    const result = service.authenticate(asRequestCookie(issued.setCookie), NOW_MS + 601_000)
    expect(result).toEqual({ ok: false, error: { kind: 'invalid_token', reason: 'expired' } })
  })

  it('re-screens the name, so a policy change applies to tokens already issued', () => {
    // A signature proves origin, not current policy. A name that was fine when
    // the token was signed must not keep its seat after the list is tightened.
    const issued = issueOrThrow(makeService(), { now: NOW_MS, requestedName: 'Admin Bot' })
    const stricter = makeService({ nameOptions: { extraTerms: ['adminbot'] } })
    const result = stricter.authenticate(asRequestCookie(issued.setCookie), NOW_MS)
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toMatchObject({ kind: 'invalid_name', reason: 'profanity' })
  })
})

describe('clearCookie', () => {
  it('expires the cookie with the same attributes it was set with', () => {
    const header = makeService({ cookie: { domain: 'example.test' } }).clearCookie()
    expect(header).toContain('Max-Age=0')
    expect(header).toContain('Domain=example.test')
    expect(header).toContain('HttpOnly')
  })
})
