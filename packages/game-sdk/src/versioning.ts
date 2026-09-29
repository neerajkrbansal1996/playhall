/**
 * Versioning and version pinning.
 *
 * The rule: **a match in progress stays on the module version it started on.**
 * A deploy must never change the rules under a live game. The registry
 * therefore keeps every version that any live match is pinned to, and resolves
 * a match's module by exact version — not by "latest", not by semver range.
 *
 * `migrateState` exists for the other case: bringing a *persisted, not running*
 * match (or a stored replay) forward after a restart. It is never called
 * mid-match.
 */

import { type Result, err, ok } from './errors.js'

/** The version of this SDK package. */
export const SDK_VERSION = '0.1.0'

/**
 * Contract major. Bumped only when a server or client contract changes shape
 * in a way that breaks existing games. A game declares the contract it was
 * written against; the registry refuses to load a mismatch rather than failing
 * at the first `applyAction`.
 *
 * After M2 a bump also needs an SDK ADR and board approval.
 */
export const SDK_CONTRACT_VERSION = 1

export interface Semver {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease?: string
  readonly build?: string
}

/** Official semver.org regex. */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export function parseSemver(value: string): Semver | null {
  const match = SEMVER_PATTERN.exec(value)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] === undefined ? {} : { prerelease: match[4] }),
    ...(match[5] === undefined ? {} : { build: match[5] }),
  }
}

export function isSemver(value: string): boolean {
  return SEMVER_PATTERN.test(value)
}

/** Negative if `a < b`, zero if equal, positive if `a > b`. Ignores build metadata. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  // A prerelease sorts before its release: 1.0.0-rc.1 < 1.0.0.
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/** What a match stores so it can be resumed on exactly the module it began on. */
export interface VersionPin {
  readonly gameId: string
  /** Exact module version. Never a range. */
  readonly version: string
  readonly sdkContractVersion: number
}

export type VersionPinFailure =
  | { readonly code: 'version_mismatch'; readonly pinned: string; readonly available: string }
  | { readonly code: 'contract_mismatch'; readonly pinned: number; readonly available: number }
  | { readonly code: 'game_mismatch'; readonly pinned: string; readonly available: string }

/**
 * Resolves whether a loaded module may serve a pinned match.
 *
 * Exact-match only. Accepting a patch bump would mean a bug fix that changes
 * a legal-move set silently rewrites an in-flight game, and the client's
 * optimistic state would diverge from the server's with no way to tell.
 */
export function checkVersionPin(
  pin: VersionPin,
  available: { readonly gameId: string; readonly version: string; readonly sdkContractVersion: number },
): Result<void, VersionPinFailure> {
  if (pin.gameId !== available.gameId) {
    return err({ code: 'game_mismatch', pinned: pin.gameId, available: available.gameId })
  }
  if (pin.sdkContractVersion !== available.sdkContractVersion) {
    return err({
      code: 'contract_mismatch',
      pinned: pin.sdkContractVersion,
      available: available.sdkContractVersion,
    })
  }
  if (pin.version !== available.version) {
    return err({ code: 'version_mismatch', pinned: pin.version, available: available.version })
  }
  return ok(undefined)
}

/**
 * Whether this SDK build can load a game written against `contractVersion`.
 * Contract majors are not backwards compatible by definition.
 */
export function isContractSupported(contractVersion: number): boolean {
  return contractVersion === SDK_CONTRACT_VERSION
}
