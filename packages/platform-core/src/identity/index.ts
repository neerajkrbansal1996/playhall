/**
 * Guest identity (M1.2).
 *
 * v1 has no accounts. A guest is a random id in a signed, HttpOnly cookie plus
 * a display name they chose. No email, no password, no IP, no device
 * fingerprint, no third-party id — the "no personal data collected" line in the
 * brief is enforced by there being nowhere to put any.
 *
 * Read the modules in this order: `display-name` (what a player may call
 * themselves), `guest-token` (how we prove it later), `cookie` (how it travels),
 * `avatar` (how it renders), `sessions` (what happens in a second tab), and
 * `service` (the composition an HTTP handler actually calls).
 */

export {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MAX_RAW_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  DISPLAY_NAME_REJECTION_REASONS,
  NAME_CONTENT_PATTERN,
  displayNameLength,
  escapeHtml,
  sanitizeDisplayName,
  validateDisplayName,
} from './display-name.js'
export type {
  DisplayNameRejection,
  DisplayNameRejectionReason,
  ValidateDisplayNameOptions,
} from './display-name.js'

export { PROFANITY_TERMS, findProfanity, foldForProfanity, isProfane } from './profanity.js'
export type { ProfanityOptions } from './profanity.js'

export {
  ADJECTIVES,
  ANIMALS,
  FUN_NAMES_FIT,
  MAX_FUN_NAME_LENGTH,
  allFunNames,
  suggestDisplayName,
  suggestDisplayNameFor,
} from './fun-names.js'

export {
  GUEST_TOKEN_FAILURES,
  GUEST_TOKEN_VERSION,
  GuestClaimsSchema,
  MIN_SIGNING_KEY_BYTES,
  assertUsableKey,
  signGuestToken,
  unsafeDecodeGuestToken,
  verifyGuestToken,
} from './guest-token.js'
export type {
  GuestClaims,
  GuestKeyring,
  GuestTokenFailure,
  GuestTokenKey,
  GuestTokenRejection,
  VerifyGuestTokenOptions,
} from './guest-token.js'

export {
  GUEST_COOKIE_NAME,
  GUEST_TOKEN_TTL_SECONDS,
  clearGuestCookie,
  readGuestCookie,
  serializeGuestCookie,
} from './cookie.js'
export type { GuestCookieOptions } from './cookie.js'

export {
  AVATAR_PALETTE,
  avatarFor,
  contrastRatio,
  initialsFor,
  relativeLuminance,
} from './avatar.js'
export type { AvatarColor, GuestAvatar } from './avatar.js'

export {
  EMPTY_SESSION_REGISTRY,
  SESSION_SUPERSEDED_CODE,
  claimSession,
  currentSession,
  isCurrentSession,
  releaseSession,
} from './sessions.js'
export type { ClaimSessionResult, GuestSession, GuestSessionRegistry } from './sessions.js'

export { GUEST_ID_BYTES, createGuestIdentityService } from './service.js'
export type {
  AuthenticateRejection,
  GuestIdentity,
  GuestIdentityService,
  GuestIdentityServiceConfig,
  IssueGuestOptions,
  IssueGuestRejection,
  IssuedGuestIdentity,
  RandomBytes,
  VerifiedGuestRef,
} from './service.js'
