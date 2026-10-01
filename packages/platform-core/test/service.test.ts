import { describe, expect, it } from 'vitest'
import {
  type GuestIdentityService,
  type GuestIdentityServiceConfig,
  type VerifiedGuestRef,
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
      reuse: first.identity.ref,
    })
    expect(renamed.identity.guestId).toBe(first.identity.guestId)
    expect(renamed.identity.sessionId).toBe(first.identity.sessionId)
    expect(renamed.identity.avatar.color).toEqual(first.identity.avatar.color)
    expect(renamed.identity.displayName).toBe('Grace Hopper')
  })

  it('reuses only a ref it minted or verified, never a caller-supplied string', () => {
    // Server-authoritative (principle 5). The reuse parameter is branded so a
    // handler cannot read a gid off a request body and mint a token for
    // somebody else's seat. This is a compile-time guarantee, asserted here so
    // the guarantee is a test failure rather than a code-review habit.
    const service = makeService()
    const issued = issueOrThrow(service, { now: NOW_MS, requestedName: 'Ada Lovelace' })

    // Never invoked — the assertion is that this body does not compile without
    // the suppressions, which `tsc -p tsconfig.test.json` checks.
    const wouldNotCompile = (): unknown[] => [
      // @ts-expect-error a bare string is not a VerifiedGuestRef
      service.issue({ now: NOW_MS, reuse: 'somebody-else' }),
      // @ts-expect-error nor is an unbranded object of the right shape
      service.issue({ now: NOW_MS, reuse: { gid: 'somebody-else', sid: 'sid' } }),
    ]
    expect(typeof wouldNotCompile).toBe('function')

    // The producers are a verified identity and its `invalid_name` rejection.
    const verified = service.authenticate(asRequestCookie(issued.setCookie), NOW_MS)
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      expect(verified.value.ref.gid).toBe(issued.identity.guestId)
      expect(verified.value.ref.sid).toBe(issued.identity.sessionId)
    }
  })

  it('returns err rather than throwing when the claims do not fit the token', () => {
    // The brand makes this unreachable through the type system; the schema is
    // still the authority on what fits in a cookie, and a schema failure must
    // arrive as the Result the signature promises. Casting past the brand is
    // exactly how a future refactor would reintroduce the throw.
    const service = makeService()
    const badRefs = [
      { gid: 'x'.repeat(65), sid: 'sid' },
      { gid: '', sid: 'sid' },
      { gid: 'gid', sid: '' },
      { gid: 'gid', sid: 'y'.repeat(65) },
    ]

    for (const bad of badRefs) {
      const ref = bad as unknown as VerifiedGuestRef
      const run = (): ReturnType<GuestIdentityService['issue']> =>
        service.issue({ now: NOW_MS, requestedName: 'Ada Lovelace', reuse: ref })

      expect(run).not.toThrow()
      const result = run()
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('invalid_claims')
        expect(result.error.reason).toBe('invalid_claims')
      }
    }
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

  it('a blocklist update forces a rename, it does not destroy the guest', () => {
    // The rejection above is a rename prompt, not a deletion. If it dropped the
    // gid the caller would have to mint a new guest, and the player would lose
    // their identity, their avatar and their match history because somebody
    // edited a word list.
    const service = makeService()
    const issued = issueOrThrow(service, { now: NOW_MS, requestedName: 'Admin Bot' })
    const stricter = makeService({ nameOptions: { extraTerms: ['adminbot'] } })

    const rejected = stricter.authenticate(asRequestCookie(issued.setCookie), NOW_MS)
    expect(rejected.ok).toBe(false)
    if (rejected.ok || rejected.error.kind !== 'invalid_name') throw new Error('expected a rename')

    expect(rejected.error.guest.gid).toBe(issued.identity.guestId)
    expect(rejected.error.guest.sid).toBe(issued.identity.sessionId)

    // And the ref is directly re-issuable: same guest, new name, same avatar.
    const renamed = issueOrThrow(stricter, {
      now: NOW_MS + 1_000,
      requestedName: 'Grace Hopper',
      reuse: rejected.error.guest,
    })
    expect(renamed.identity.guestId).toBe(issued.identity.guestId)
    expect(renamed.identity.sessionId).toBe(issued.identity.sessionId)
    expect(renamed.identity.avatar.color).toEqual(issued.identity.avatar.color)
    expect(renamed.identity.displayName).toBe('Grace Hopper')
    expect(stricter.authenticate(asRequestCookie(renamed.setCookie), NOW_MS + 2_000).ok).toBe(true)
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

/**
 * Every other test in this file injects `randomBytes`, which is what makes tokens
 * byte-reproducible — and also means the *default* was never executed. It was
 * `node:crypto`'s `randomBytes`; it is now the package's `RandomSource` port, so
 * the Node-builtin list in `platform-core/src` stays at one named, ADR-governed
 * entry (PER-162; ADR-0011 §Decision part 4) — not to make the package
 * edge-importable, which ADR-0011 §3 shows it is not and cannot be.
 *
 * That swap is exactly the kind a passing suite can miss. The default is written
 * as `webCryptoRandomSource().randomBytes`, a method pulled off its object: if it
 * ever came to depend on `this`, or if the global `crypto` were absent on a
 * target, `issue()` would throw at the first mint and nothing here would notice.
 */
describe('default entropy source', () => {
  const uninjected = (): GuestIdentityService => createGuestIdentityService({ keyring: KEYRING })

  it('mints a working guest with no randomBytes injected', () => {
    const { identity, token, setCookie } = issueOrThrow(uninjected(), {
      now: NOW_MS,
      requestedName: 'Swift Otter',
    })

    expect(identity.guestId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(token.split('.')).toHaveLength(4)

    // Round-trips through verification, so the id the default produced is one the
    // token schema accepts — not merely a non-empty string.
    const back = uninjected().authenticate(asRequestCookie(setCookie), NOW_MS)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.value.guestId).toBe(identity.guestId)
  })

  it('does not repeat a guest id', () => {
    const service = uninjected()
    const ids = new Set(
      Array.from({ length: 64 }, () => issueOrThrow(service, { now: NOW_MS }).identity.guestId),
    )
    expect(ids.size).toBe(64)
  })
})
