/**
 * The game registry.
 *
 * This is the seam that makes "games are plugins" true. `platform-core` gets
 * **no** exception to the platform-never-imports-a-game rule (ADR-0002 §3):
 * it does not import a game, does not name one, and does not know how many
 * exist. It receives a list of `GameRegistration`s — each a slug and a
 * `() => import(...)` thunk — from the composition root, whose registry
 * module is *generated* by `tools/generate-games-registry.mjs`, not
 * hand-written.
 *
 * The landing grid, `/games`, the sitemap and the per-game feature flags all
 * read from here. None of them may enumerate `games/*` themselves; if a game
 * is invisible in one of those four places and visible in another, that is a
 * bug this registry exists to make impossible.
 *
 * ### Why loading is eager on the server and lazy on the client
 *
 * The catalogue needs a manifest, and a manifest is live code (it carries a
 * zod `settingsSchema`). So the registry imports every game module once, at
 * server start, and keeps the JSON-safe `GameCatalogEntry` projections.
 * That costs a few milliseconds of server startup and buys settings
 * validation without a round trip.
 *
 * The client never does this. It receives `GameCatalogEntry` JSON and imports
 * a game's *client* module dynamically when a player actually opens that
 * game, which is what keeps the promise that adding a game adds zero bytes to
 * other bundles.
 */

import {
  type AnyGameModule,
  type GameCatalogEntry,
  type GameManifest,
  toCatalogEntry,
  validateManifest,
} from '@playhall/game-sdk'
import type { FeatureFlags } from '../flags.js'

export interface GameRegistration {
  /** Must equal the module's `manifest.slug`; checked at load. */
  readonly slug: string
  /** Dynamic import of the game's entry point. Never a static import. */
  readonly load: () => Promise<{ readonly default: AnyGameModule }>
}

export interface RegistryProblem {
  readonly slug: string
  readonly message: string
}

export class RegistryLoadError extends Error {
  constructor(readonly problems: readonly RegistryProblem[]) {
    super(
      `game registry failed to load:\n- ${problems.map((p) => `${p.slug}: ${p.message}`).join('\n- ')}`,
    )
    this.name = 'RegistryLoadError'
  }
}

export interface ListOptions {
  /** Include games the feature flags hide. Admin/debug surfaces only. */
  readonly includeFlagged?: boolean
  /** Include `hidden` and `coming-soon` manifests. Default: `coming-soon` only. */
  readonly includeHidden?: boolean
}

export interface GameRegistry {
  /** Visible catalogue, sorted by name. Safe to serialise to a client. */
  list(options?: ListOptions): readonly GameCatalogEntry[]
  entry(slug: string): GameCatalogEntry | null
  entryById(gameId: string): GameCatalogEntry | null
  /** The live module. Server-side only — it holds zod schemas and reducers. */
  module(slug: string): AnyGameModule | null
  /** True when the game exists, is not hidden, and its flag is on. */
  isPlayable(slug: string): boolean
  /** Problems found at load. Empty on a clean load. */
  readonly problems: readonly RegistryProblem[]
}

/** A game is offered to players only in these statuses. */
const PLAYABLE_STATUSES = new Set(['live', 'beta'])
/** Listed (possibly as "coming soon") in these. `hidden` is never listed. */
const LISTABLE_STATUSES = new Set(['live', 'beta', 'coming-soon'])

export interface CreateRegistryOptions {
  readonly registrations: readonly GameRegistration[]
  readonly flags: FeatureFlags
  /**
   * When true (the default) a broken game aborts startup. Set false to boot
   * with the healthy games and surface the rest through `problems` — the
   * right trade for a production fleet where one bad game should not take the
   * lobby down with it.
   */
  readonly strict?: boolean
}

export async function createGameRegistry(options: CreateRegistryOptions): Promise<GameRegistry> {
  const { registrations, flags, strict = true } = options
  const modules = new Map<string, AnyGameModule>()
  const entries = new Map<string, GameCatalogEntry>()
  const byId = new Map<string, string>()
  const problems: RegistryProblem[] = []

  const loaded = await Promise.all(
    registrations.map(async (registration) => {
      try {
        return { registration, module: (await registration.load()).default, error: null }
      } catch (cause) {
        return {
          registration,
          module: null,
          error: cause instanceof Error ? cause.message : String(cause),
        }
      }
    }),
  )

  for (const { registration, module, error } of loaded) {
    const { slug } = registration
    if (module === null) {
      problems.push({ slug, message: `failed to import: ${error}` })
      continue
    }

    const manifest = module.manifest as GameManifest<unknown>

    if (manifest.slug !== slug) {
      problems.push({
        slug,
        message: `registration slug '${slug}' does not match manifest slug '${manifest.slug}'`,
      })
      continue
    }
    if (entries.has(slug)) {
      problems.push({ slug, message: `duplicate slug '${slug}'` })
      continue
    }
    if (byId.has(manifest.id)) {
      problems.push({
        slug,
        message: `game id '${manifest.id}' is already registered by '${byId.get(manifest.id)}'`,
      })
      continue
    }

    // `defineTurnBasedGame` already validated this at import time. Re-checking
    // here costs microseconds and catches a module that was hand-assembled,
    // or built against a different SDK copy, before it reaches a player.
    const validated = validateManifest(manifest)
    if (!validated.ok) {
      problems.push({
        slug,
        message: `invalid manifest: ${validated.error.map((p) => `${p.path} ${p.message}`).join('; ')}`,
      })
      continue
    }

    modules.set(slug, module)
    entries.set(slug, toCatalogEntry(manifest))
    byId.set(manifest.id, slug)
  }

  if (strict && problems.length > 0) throw new RegistryLoadError(problems)

  function visible(entry: GameCatalogEntry, options?: ListOptions): boolean {
    const statuses = options?.includeHidden === true ? null : LISTABLE_STATUSES
    if (statuses !== null && !statuses.has(entry.status)) return false
    if (options?.includeFlagged !== true && !flags.isGameEnabled(entry.slug)) return false
    return true
  }

  return {
    list(options?: ListOptions): readonly GameCatalogEntry[] {
      return [...entries.values()]
        .filter((entry) => visible(entry, options))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    entry: (slug) => entries.get(slug) ?? null,
    entryById: (gameId) => {
      const slug = byId.get(gameId)
      return slug === undefined ? null : (entries.get(slug) ?? null)
    },
    module: (slug) => modules.get(slug) ?? null,
    isPlayable: (slug) => {
      const entry = entries.get(slug)
      if (!entry) return false
      return PLAYABLE_STATUSES.has(entry.status) && flags.isGameEnabled(slug)
    },
    problems,
  }
}
