/**
 * The guest identity service: the one place a request turns into an identity.
 *
 * Everything under `identity/` is a pure function; this file is the only piece
 * that touches entropy, and even that is injectable so tests get byte-exact
 * tokens. Time is always a parameter — the platform has one clock and the
 * timer service owns it (PER-14).
 *
 * What is *not* here, on purpose: storage. A guest has no server-side record to
 * look up. The cookie is the record, the signature is the proof, and that is
 * what makes "no accounts, no personal data" true rather than aspirational.
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { type PlayerId, type Result, asPlayerId, err, ok } from '@playhall/game-sdk'
import { type GuestAvatar, avatarFor } from './avatar.js'
import {
  type GuestCookieOptions,
  GUEST_TOKEN_TTL_SECONDS,
  clearGuestCookie,
  readGuestCookie,
  serializeGuestCookie,
} from './cookie.js'
import {
  type DisplayNameRejection,
  type ValidateDisplayNameOptions,
  validateDisplayName,
} from './display-name.js'
import { suggestDisplayNameFor } from './fun-names.js'
import {
  type GuestClaims,
  type GuestKeyring,
  type GuestTokenRejection,
  signGuestToken,
  verifyGuestToken,
} from './guest-token.js'

/** 128 bits. Opaque, unguessable, and short enough for a 6-char-code-era URL. */
export const GUEST_ID_BYTES = 16

export interface GuestIdentity {
  /**
   * Branded as `PlayerId` because that is what it is downstream — the SDK's
   * `Seat.occupant`. Games never see it directly; they key on `SeatId`.
   */
  readonly guestId: PlayerId
  /** This browsing context. See `sessions.ts` for the newest-wins rule. */
  readonly sessionId: string
  readonly displayName: string
  readonly avatar: GuestAvatar
  /** Seconds since epoch, from the token. */
  readonly issuedAt: number
  readonly expiresAt: number
}

export interface IssuedGuestIdentity {
  readonly identity: GuestIdentity
  readonly token: string
  /** Ready-to-send `Set-Cookie` header value. */
  readonly setCookie: string
}

/** Injectable so tests are deterministic. Defaults to `node:crypto`. */
export type RandomBytes = (size: number) => Uint8Array

export interface GuestIdentityServiceConfig {
  readonly keyring: GuestKeyring
  /** Token and cookie lifetime. Defaults to 30 days. */
  readonly ttlSeconds?: number
  readonly cookie?: GuestCookieOptions
  readonly randomBytes?: RandomBytes
  /** Passed through to the display-name screen, so Product can tune the list. */
  readonly nameOptions?: ValidateDisplayNameOptions
  /** Skew tolerance when verifying, in seconds. */
  readonly clockToleranceSeconds?: number
}

export type IssueGuestRejection = { readonly kind: 'invalid_name' } & DisplayNameRejection

export type AuthenticateRejection =
  | ({ readonly kind: 'no_cookie' } & { reason?: undefined })
  | ({ readonly kind: 'invalid_token' } & GuestTokenRejection)
  | ({ readonly kind: 'invalid_name' } & DisplayNameRejection)

export interface IssueGuestOptions {
  /** Server time, ms since epoch. */
  readonly now: number
  /** What the player typed. Absent or blank means "use the suggestion". */
  readonly requestedName?: string | null
  /**
   * Reuse an existing guest id — a returning player renaming themselves, or a
   * sliding-expiry renewal. Omit to mint a new guest.
   */
  readonly guestId?: string
  /** Reuse an existing session id. Omit to mint a new browsing context. */
  readonly sessionId?: string
}

export interface GuestIdentityService {
  /**
   * The suggestion the create-lobby form pre-fills. Deterministic per guest id,
   * so a reload does not shuffle the field under the player's cursor.
   */
  suggestNameFor(guestId: string): string
  /** Mints an id if needed, validates the name, signs a token, builds the cookie. */
  issue(options: IssueGuestOptions): Result<IssuedGuestIdentity, IssueGuestRejection>
  /** Verifies a `Cookie` header. The only way a request becomes an identity. */
  authenticate(
    cookieHeader: string | undefined | null,
    now: number,
  ): Result<GuestIdentity, AuthenticateRejection>
  /** `Set-Cookie` value that signs the guest out. */
  clearCookie(): string
}

function toSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000)
}

function identityFromClaims(claims: GuestClaims): GuestIdentity {
  return {
    guestId: asPlayerId(claims.gid),
    sessionId: claims.sid,
    displayName: claims.nam,
    avatar: avatarFor(claims.gid, claims.nam),
    issuedAt: claims.iat,
    expiresAt: claims.exp,
  }
}

export function createGuestIdentityService(
  config: GuestIdentityServiceConfig,
): GuestIdentityService {
  const randomBytes = config.randomBytes ?? ((size: number) => nodeRandomBytes(size))
  const ttlSeconds = config.ttlSeconds ?? GUEST_TOKEN_TTL_SECONDS
  const cookieOptions: GuestCookieOptions = { maxAgeSeconds: ttlSeconds, ...config.cookie }

  const newId = (): string => Buffer.from(randomBytes(GUEST_ID_BYTES)).toString('base64url')

  return {
    suggestNameFor: suggestDisplayNameFor,

    issue(options) {
      const guestId = options.guestId ?? newId()
      const sessionId = options.sessionId ?? newId()

      // A blank field is not an error — it is the player accepting the
      // suggestion, which is the two-tap path we are optimising for.
      const requested = options.requestedName?.trim()
      const candidate =
        requested === undefined || requested.length === 0
          ? suggestDisplayNameFor(guestId)
          : requested

      const name = validateDisplayName(candidate, config.nameOptions)
      if (!name.ok) return err({ kind: 'invalid_name', ...name.error })

      const issuedAt = toSeconds(options.now)
      const claims: GuestClaims = {
        gid: guestId,
        sid: sessionId,
        nam: name.value,
        iat: issuedAt,
        exp: issuedAt + ttlSeconds,
      }
      const token = signGuestToken(claims, config.keyring)

      return ok({
        identity: identityFromClaims(claims),
        token,
        setCookie: serializeGuestCookie(token, cookieOptions),
      })
    },

    authenticate(cookieHeader, now) {
      const token = readGuestCookie(cookieHeader)
      if (token === undefined) return err({ kind: 'no_cookie' })

      const verified = verifyGuestToken(token, config.keyring, {
        now: toSeconds(now),
        clockToleranceSeconds: config.clockToleranceSeconds,
      })
      if (!verified.ok) return err({ kind: 'invalid_token', ...verified.error })

      // Re-screen the name on the way in. The token is authentic, but it may
      // have been signed before a blocklist update, or by an older build with
      // a looser rule. A signature proves origin, not current policy.
      const name = validateDisplayName(verified.value.nam, config.nameOptions)
      if (!name.ok) return err({ kind: 'invalid_name', ...name.error })

      return ok(identityFromClaims({ ...verified.value, nam: name.value }))
    },

    clearCookie() {
      return clearGuestCookie(cookieOptions)
    },
  }
}
