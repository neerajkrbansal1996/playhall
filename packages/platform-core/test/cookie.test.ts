import { describe, expect, it } from 'vitest'
import {
  GUEST_COOKIE_NAME,
  GUEST_TOKEN_TTL_SECONDS,
  clearGuestCookie,
  readGuestCookie,
  serializeGuestCookie,
} from '../src/identity/cookie.js'

describe('serializeGuestCookie', () => {
  const header = serializeGuestCookie('v1.k1.payload.sig')

  it('is HttpOnly, so an XSS in a game UI cannot lift the identity', () => {
    expect(header).toContain('HttpOnly')
  })

  it('is Secure by default', () => {
    expect(header).toContain('Secure')
    expect(serializeGuestCookie('t', { secure: false })).not.toContain('Secure')
  })

  it('uses SameSite=Lax so a shared lobby link still arrives signed in', () => {
    // Strict would withhold the cookie on the top-level cross-site navigation
    // from WhatsApp or Discord, which is the primary arrival path (principle 4).
    expect(header).toContain('SameSite=Lax')
    expect(header).not.toContain('SameSite=Strict')
  })

  it('is host-only unless a domain is configured', () => {
    expect(header).not.toContain('Domain=')
    expect(serializeGuestCookie('t', { domain: 'example.test' })).toContain('Domain=example.test')
  })

  it('defaults Max-Age to the token TTL and allows an override', () => {
    expect(header).toContain(`Max-Age=${GUEST_TOKEN_TTL_SECONDS}`)
    expect(serializeGuestCookie('t', { maxAgeSeconds: 60 })).toContain('Max-Age=60')
  })

  it('scopes to the whole site by default', () => {
    expect(header).toContain('Path=/')
    expect(serializeGuestCookie('t', { path: '/app' })).toContain('Path=/app')
  })

  it('round-trips through readGuestCookie', () => {
    const token = 'v1.k1.abc-_123.sig'
    const value = serializeGuestCookie(token).split(';')[0] as string
    expect(readGuestCookie(value)).toBe(token)
  })
})

describe('clearGuestCookie', () => {
  it('expires immediately and repeats the attributes the browser matches on', () => {
    const header = clearGuestCookie({ domain: 'example.test', path: '/app' })
    expect(header).toContain(`${GUEST_COOKIE_NAME}=`)
    expect(header).toContain('Max-Age=0')
    expect(header).toContain('Path=/app')
    expect(header).toContain('Domain=example.test')
  })
})

describe('readGuestCookie', () => {
  it.each([
    ['single cookie', `${GUEST_COOKIE_NAME}=abc`, 'abc'],
    ['spaced pairs', `other=1; ${GUEST_COOKIE_NAME}=abc; third=2`, 'abc'],
    ['no spaces', `other=1;${GUEST_COOKIE_NAME}=abc;third=2`, 'abc'],
    ['quoted value', `${GUEST_COOKIE_NAME}="abc"`, 'abc'],
    ['leading whitespace', `  ${GUEST_COOKIE_NAME} = abc `, 'abc'],
    ['value containing =', `${GUEST_COOKIE_NAME}=a=b`, 'a=b'],
  ])('reads %s', (_label, header, expected) => {
    expect(readGuestCookie(header)).toBe(expected)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['other cookies only', 'a=1; b=2'],
    ['empty value', `${GUEST_COOKIE_NAME}=`],
    ['no equals sign', 'flagonly'],
    ['prefix collision', `not_${GUEST_COOKIE_NAME}=abc`],
  ])('returns undefined for %s', (_label, header) => {
    expect(readGuestCookie(header)).toBeUndefined()
  })

  it('takes the first of duplicate cookies', () => {
    // Browsers send more-specific paths first. Taking the last would let a
    // cookie set on a parent domain override the host-only one.
    expect(readGuestCookie(`${GUEST_COOKIE_NAME}=host; ${GUEST_COOKIE_NAME}=parent`)).toBe('host')
  })
})
