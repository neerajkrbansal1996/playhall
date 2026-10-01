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

import { type PlayerId, type Result, asPlayerId, err, ok } from '@playhall/game-sdk'
import { webCryptoRandomSource } from '../runtime.js'
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
  GuestClaimsSchema,
  type GuestKeyring,
  type GuestTokenRejection,
  signGuestToken,
  verifyGuestToken,
} from './guest-token.js'

/** 128 bits. Opaque, unguessable, and short enough for a 6-char-code-era URL. */
export const GUEST_ID_BYTES = 16

declare const verifiedGuest: unique symbol

/**
 * A guest this package itself established: either freshly minted from
 * `randomBytes`, or recovered from a token whose MAC verified.
 *
 * The brand cannot be produced outside this module, which is the point.
 * `issue()` used to take a bare `guestId: string`, so any handler could read a
 * gid off a request body and mint a valid token for another player's seat —
 * server-authoritative by convention only. Requiring this type makes that call
 * fail to typecheck: the only way to get one is `GuestIdentity.ref` from a
 * successful `authenticate()`, or the `guest` on its `invalid_name` rejection.
 */
export interface VerifiedGuestRef {
  /** Guest id. Stable for the life of the cookie; the player's identity. */
  readonly gid: string
  /** Session id from the same token, or minted alongside a new `gid`. */
  readonly sid: string
  readonly [verifiedGuest]: true
}

/** The one place the brand is applied. Never export this. */
function verifiedRef(gid: string, sid: string): VerifiedGuestRef {
  return { gid, sid } as unknown as VerifiedGuestRef
}

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
  /** Pass to `issue({ reuse })` to rename or renew without losing the guest. */
  readonly ref: VerifiedGuestRef
}

export interface IssuedGuestIdentity {
  readonly identity: GuestIdentity
  readonly token: string
  /** Ready-to-send `Set-Cookie` header value. */
  readonly setCookie: string
}

/**
 * Injectable so tests are deterministic. Defaults to `webCryptoRandomSource()`
 * — the package's `RandomSource` port, backed by the global Web Crypto API.
 *
 * A port rather than a direct `node:crypto` import — but *not* because this
 * package is edge-importable. It is not, and ADR-0011 §3 explains why that claim
 * cannot be made of a package at all: edge-importability is a property of an
 * entrypoint's module graph, and `src/index.ts` re-exports a subtree that reaches
 * `node:crypto` through `guest-token.ts`. The default entrypoint targets Node and
 * Cloudflare Workers, which support `node:crypto` in full (§1).
 *
 * The two reasons that do hold: entropy is an ambient capability, and a port is
 * the right shape for one — it is what makes this file testable without patching
 * a global. And `no-platform-core-node-builtins` keeps the Node-builtin list in
 * `platform-core/src` at a single named, ADR-governed entry, which is only worth
 * anything while the list stays short enough to read. Enforced by that rule, not
 * by this comment.
 */
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

/**
 * `invalid_claims` is the catch-all for an id or name that cannot be signed —
 * over 64 characters, or empty. It should be unreachable now that the only ids
 * `issue()` accepts are ones this module minted or verified, but the schema is
 * the authority on what fits in a token and a schema failure must surface as a
 * `Result`, not as a `ZodError` thrown through a signature that promises one.
 */
export type IssueGuestRejection =
  | ({ readonly kind: 'invalid_name' } & DisplayNameRejection)
  | {
      readonly kind: 'invalid_claims'
      readonly reason: 'invalid_claims'
      /** Developer-facing detail from the schema. Never key a UI off it. */
      readonly message?: string
    }

/**
 * `invalid_name` carries the `guest` whose token just verified. Without it a
 * blocklist edit would be a silent account deletion: the caller could not
 * re-issue for the same guest, so the player would lose their id, their avatar
 * and their match history rather than being asked to pick a new name.
 */
export type AuthenticateRejection =
  | ({ readonly kind: 'no_cookie' } & { reason?: undefined })
  | ({ readonly kind: 'invalid_token' } & GuestTokenRejection)
  | ({ readonly kind: 'invalid_name' } & DisplayNameRejection & {
        readonly guest: VerifiedGuestRef
      })

export interface IssueGuestOptions {
  /** Server time, ms since epoch. */
  readonly now: number
  /** What the player typed. Absent or blank means "use the suggestion". */
  readonly requestedName?: string | null
  /**
   * Reuse an existing guest — a returning player renaming themselves, or a
   * sliding-expiry renewal. Omit to mint a new guest.
   *
   * Only a `VerifiedGuestRef` is accepted, so the id provably came from a token
   * whose signature checked out. A gid off a request body does not typecheck.
   */
  readonly reuse?: VerifiedGuestRef
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
    ref: verifiedRef(claims.gid, claims.sid),
  }
}

export function createGuestIdentityService(
  config: GuestIdentityServiceConfig,
): GuestIdentityService {
  const randomBytes = config.randomBytes ?? webCryptoRandomSource().randomBytes
  const ttlSeconds = config.ttlSeconds ?? GUEST_TOKEN_TTL_SECONDS
  const cookieOptions: GuestCookieOptions = { maxAgeSeconds: ttlSeconds, ...config.cookie }

  const newId = (): string => Buffer.from(randomBytes(GUEST_ID_BYTES)).toString('base64url')

  return {
    suggestNameFor: suggestDisplayNameFor,

    issue(options) {
      const guestId = options.reuse?.gid ?? newId()
      const sessionId = options.reuse?.sid ?? newId()

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
      // Validate before signing rather than letting `signGuestToken` throw on
      // the way past: the return type promises a Result, so no caller will have
      // wrapped this in a `try` and the first bad id would be a 500.
      const claims = GuestClaimsSchema.safeParse({
        gid: guestId,
        sid: sessionId,
        nam: name.value,
        iat: issuedAt,
        exp: issuedAt + ttlSeconds,
      })
      if (!claims.success) {
        return err({
          kind: 'invalid_claims',
          reason: 'invalid_claims',
          message: claims.error.issues[0]?.message,
        })
      }

      const token = signGuestToken(claims.data, config.keyring)

      return ok({
        identity: identityFromClaims(claims.data),
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
      if (!name.ok) {
        // Carry the verified guest through the rejection: the caller must be
        // able to force a rename that keeps this guest, not mint a new one.
        return err({
          kind: 'invalid_name',
          ...name.error,
          guest: verifiedRef(verified.value.gid, verified.value.sid),
        })
      }

      return ok(identityFromClaims({ ...verified.value, nam: name.value }))
    },

    clearCookie() {
      return clearGuestCookie(cookieOptions)
    },
  }
}
