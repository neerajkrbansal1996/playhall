/**
 * The guest cookie.
 *
 * `HttpOnly` is the point of the whole design: the token is never readable from
 * JavaScript, so an XSS in a game's UI cannot lift a player's identity.
 *
 * `SameSite=Lax` and not `Strict`, deliberately. Principle 4 is share-first —
 * players arrive by tapping a lobby link in WhatsApp, iMessage or Discord, and
 * `Strict` withholds the cookie on exactly that top-level cross-site
 * navigation. The player would land in the lobby signed out, which is the one
 * flow we cannot afford to break. `Lax` still withholds the cookie from
 * cross-site POSTs, which is the CSRF case that matters.
 *
 * The cookie name is brand-free on purpose: the product name is still a board
 * decision, and a cookie name is not something you want to migrate later.
 */

export const GUEST_COOKIE_NAME = 'guest_token'

/** 30 days. Long enough that a returning player keeps their name and history. */
export const GUEST_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30

export interface GuestCookieOptions {
  /**
   * `Secure`. Defaults to true. Only set false for plain-HTTP local dev —
   * Safari and Chrome both drop a `Secure` cookie on `http://localhost` in
   * some configurations.
   */
  readonly secure?: boolean
  /** `Max-Age` in seconds. Should match the token's remaining lifetime. */
  readonly maxAgeSeconds?: number
  /** `Domain`. Leave unset for a host-only cookie, which is what we want. */
  readonly domain?: string
  readonly path?: string
}

function serialize(value: string, options: GuestCookieOptions, maxAge: number): string {
  const parts = [
    `${GUEST_COOKIE_NAME}=${value}`,
    `Path=${options.path ?? '/'}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (options.secure ?? true) parts.push('Secure')
  if (options.domain !== undefined) parts.push(`Domain=${options.domain}`)
  return parts.join('; ')
}

/**
 * Builds the `Set-Cookie` header value for a freshly issued token.
 *
 * The token is base64url-only by construction, so it needs no percent-encoding
 * and stays readable in a devtools panel.
 */
export function serializeGuestCookie(token: string, options: GuestCookieOptions = {}): string {
  return serialize(token, options, options.maxAgeSeconds ?? GUEST_TOKEN_TTL_SECONDS)
}

/**
 * Builds the `Set-Cookie` header that removes the cookie. Must repeat `Path`
 * (and `Domain`, if it was set) or the browser deletes nothing.
 */
export function clearGuestCookie(options: GuestCookieOptions = {}): string {
  return serialize('', options, 0)
}

/**
 * Pulls the guest token out of a `Cookie` request header.
 *
 * Tolerates the shapes real clients send: no spaces after `;`, quoted values,
 * and duplicate names. On a duplicate the *first* wins, matching how browsers
 * order more-specific paths first — taking the last would let an attacker who
 * can set a cookie on a parent domain override the host-only one.
 */
export function readGuestCookie(cookieHeader: string | undefined | null): string | undefined {
  if (!cookieHeader) return undefined
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    if (pair.slice(0, separator).trim() !== GUEST_COOKIE_NAME) continue
    const raw = pair.slice(separator + 1).trim()
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
    return value.length > 0 ? value : undefined
  }
  return undefined
}
