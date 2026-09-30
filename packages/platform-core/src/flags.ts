/**
 * Feature flags.
 *
 * "Unfinished work ships behind feature flags" is a standard, so the flag
 * store has to be boring and total: a fixed set of known keys, a default for
 * each, and an override layer. An unknown key is a programming error, not a
 * silently-false flag — a typo that quietly disables a feature is the exact
 * failure a flag system is supposed to prevent.
 *
 * Per-game flags are the other half. The registry asks `isGameEnabled(slug)`
 * before a game reaches the landing grid, `/games` or the sitemap, so a game
 * can be merged, deployed and exercised in staging before anyone can see it.
 */

export const PLATFORM_FLAGS = {
  /**
   * Lists public rooms on the landing page. Off until the abuse story is
   * built: a public list is a directory of strangers to join, which needs
   * reporting and moderation first. Rooms stay private by default regardless.
   */
  publicRoomListing: false,
  /** Lets a finished room start a rematch without re-inviting. */
  rematch: true,
  /** Bot occupants for empty seats. Interface only in M1. */
  botSeats: false,
  /** Spectator view with redaction. */
  spectating: true,
} as const

export type PlatformFlagName = keyof typeof PLATFORM_FLAGS

export interface FeatureFlags {
  isEnabled(flag: PlatformFlagName): boolean
  /** Per-game visibility. Unknown slugs default to enabled. */
  isGameEnabled(slug: string): boolean
  /** The resolved set, for the `/api/flags` payload and for debugging. */
  snapshot(): Readonly<Record<PlatformFlagName, boolean>>
}

export interface FeatureFlagOverrides {
  readonly platform?: Partial<Record<PlatformFlagName, boolean>>
  /** Slug -> enabled. Absent slug means enabled. */
  readonly games?: Readonly<Record<string, boolean>>
}

export function createFeatureFlags(overrides: FeatureFlagOverrides = {}): FeatureFlags {
  const platform: Record<PlatformFlagName, boolean> = { ...PLATFORM_FLAGS }
  for (const [key, value] of Object.entries(overrides.platform ?? {})) {
    if (!(key in PLATFORM_FLAGS)) throw new RangeError(`unknown platform flag '${key}'`)
    platform[key as PlatformFlagName] = value
  }
  const games = { ...(overrides.games ?? {}) }

  return {
    isEnabled: (flag) => {
      if (!(flag in platform)) throw new RangeError(`unknown platform flag '${flag}'`)
      return platform[flag]
    },
    isGameEnabled: (slug) => games[slug] ?? true,
    snapshot: () => Object.freeze({ ...platform }),
  }
}

/**
 * Reads overrides from an environment-style record.
 *
 * `PLAYHALL_FLAG_PUBLIC_ROOM_LISTING=1` and `PLAYHALL_GAME_TIC_TAC_TOE=0`. Env is
 * the only override channel in v1 — a remote flag service is a paid vendor,
 * which is board-gated (PER-2).
 */
export function flagOverridesFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): FeatureFlagOverrides {
  const platform: Partial<Record<PlatformFlagName, boolean>> = {}
  const games: Record<string, boolean> = {}

  for (const flag of Object.keys(PLATFORM_FLAGS) as PlatformFlagName[]) {
    const value = env[`PLAYHALL_FLAG_${toScreamingSnake(flag)}`]
    if (value !== undefined) platform[flag] = isTruthy(value)
  }

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('PLAYHALL_GAME_') || value === undefined) continue
    games[toSlug(key.slice('PLAYHALL_GAME_'.length))] = isTruthy(value)
  }

  return { platform, games }
}

function toScreamingSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

function toSlug(value: string): string {
  return value.toLowerCase().replace(/_/g, '-')
}

function isTruthy(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes'
}
