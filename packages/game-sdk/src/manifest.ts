/**
 * The game manifest.
 *
 * The manifest is how the platform learns everything it needs about a game
 * without importing it: how many seats to offer, whether to show a team
 * picker, whether to offer spectating, which settings the lobby form renders,
 * whether the room needs a tick loop and a 3D-capable client. Core never
 * branches on a game id — it branches on manifest fields. That is what keeps
 * "games are plugins" true rather than aspirational.
 *
 * `settingsSchema` is a live zod schema, so it is not JSON. `toCatalogEntry`
 * produces the JSON-safe projection the lobby, the registry, the link-preview
 * renderer and analytics actually consume.
 */

import { z } from 'zod'
import type { TimerSpec } from './timers.js'
import { isSemver } from './versioning.js'
import { type Result, err, ok } from './errors.js'
import type { JsonValue } from './json.js'
import { canonicalSettingsKey, type SettingsFormDescriptor } from './settings-form.js'
import { checkSettingsForm, settingsFormDescriptorSchema } from './settings.js'

export const GAME_CATEGORIES = ['board', 'card', 'dice', 'word', 'party', 'action'] as const
export type GameCategory = (typeof GAME_CATEGORIES)[number]

export const TURN_MODELS = ['sequential', 'simultaneous', 'realtime'] as const
export type TurnModel = (typeof TURN_MODELS)[number]

export const TEAM_MODES = ['none', 'fixed', 'auto-balanced'] as const
export type TeamModeName = (typeof TEAM_MODES)[number]

export const GAME_STATUSES = ['live', 'beta', 'coming-soon', 'hidden'] as const
export type GameStatus = (typeof GAME_STATUSES)[number]

export const SUPPORTED_INPUTS = ['pointer', 'touch', 'keyboard', 'gamepad', 'motion'] as const
export type SupportedInput = (typeof SUPPORTED_INPUTS)[number]

/**
 * May a newcomer take a free seat after the match has started? (ADR-0010)
 *
 * The question is only about *seats*. Whether a newcomer may watch is already
 * declared by `supportsSpectators`, and folding the two together would give the
 * platform two flags that disagree about the same arrival.
 *
 * - `spectate_only` — no. A seat vacated mid-match still belongs to the player
 *   who left, and they may reconnect into it. This is the default a manifest
 *   that declares nothing gets.
 * - `fill_empty_seats` — yes. **Real-time turn models only.** The real-time
 *   contract has `onPlayerJoin`, so the game is told about the arrival and can
 *   initialise it. The turn-based contract has no join hook, so seating a
 *   newcomer would splice an occupant into a roster `createInitialState`
 *   already fixed, with no callback through which the game could react.
 *   `validateManifest` rejects the combination rather than downgrading it.
 */
export const LATE_JOIN_MODES = ['spectate_only', 'fill_empty_seats'] as const
export type LateJoinMode = (typeof LATE_JOIN_MODES)[number]

/**
 * How a match begins. (ADR-0010)
 *
 * - `auto_when_full` — the room starts itself once every seat is taken.
 * - `host_starts` — the host decides, however full the room is.
 *
 * Optional. A manifest that declares nothing gets `auto_when_full` iff
 * `minPlayers === maxPlayers`: such a game has exactly one playable roster, so
 * "full" and "ready to go" are the same fact and asking the host to confirm it
 * is a tap for nothing. A game that disagrees says so here.
 */
export const START_MODES = ['auto_when_full', 'host_starts'] as const
export type StartMode = (typeof START_MODES)[number]

/**
 * What a rematch rotates. (ADR-0010)
 *
 * - `none` — same seats. "New game, same people", unchanged.
 * - `seats` — every player shifts one seat, so turn order advances. This is
 *   what makes a two-player rematch fair without anyone negotiating colours.
 * - `teams` — seats are kept but teams are re-drawn from scratch, so the same
 *   group does not play the same four-versus-four every round.
 *
 * Optional. The default for a manifest that declares nothing follows `teams`:
 * `teams` for an auto-balanced game, `none` for fixed teams (whose seat-to-team
 * map is part of its rules), `seats` otherwise.
 */
export const REMATCH_ROTATIONS = ['none', 'seats', 'teams'] as const
export type RematchRotation = (typeof REMATCH_ROTATIONS)[number]

/** Slug: lowercase kebab-case. Used in URLs and in the 6-character-code flow. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const minClientSpecSchema = z.object({
  /** Real-time 3D games require WebGL2. Turn-based games leave this false. */
  webgl2: z.boolean(),
  minDeviceMemoryGb: z.number().positive().optional(),
  minDownlinkKbps: z.number().positive().optional(),
  minViewportWidthPx: z.number().int().positive().optional(),
})
export type MinClientSpec = z.infer<typeof minClientSpecSchema>

/**
 * Real-time profile. Required when `turnModel` is `realtime`, forbidden
 * otherwise. Present in M1 so the lobby, the registry and the room runner are
 * shaped for it from day one; the runner itself is M6.
 */
export const realtimeProfileSchema = z
  .object({
    /** Server simulation rate. Target is 30 Hz. */
    tickRate: z.number().int().min(1).max(120),
    /** How often a snapshot is sent down. Must not exceed `tickRate`. */
    snapshotRate: z.number().int().min(1).max(120),
    requires3D: z.boolean(),
    /** Gzipped size of the game's asset bundle, in KB. Budget lives in the ADR. */
    assetBundleSizeKb: z.number().int().nonnegative(),
    supportedInputs: z.array(z.enum(SUPPORTED_INPUTS)).min(1),
    minClientSpec: minClientSpecSchema,
  })
  .refine((profile) => profile.snapshotRate <= profile.tickRate, {
    message: 'snapshotRate must be <= tickRate',
    path: ['snapshotRate'],
  })
export type RealtimeProfile = z.infer<typeof realtimeProfileSchema>

export interface SettingsPreset<TSettings> {
  readonly id: string
  /** Display label. Product Designer owns the final copy; this is the key/default. */
  readonly label: string
  readonly description?: string
  readonly settings: TSettings
  /**
   * At most one preset may be the default the lobby opens on. Its `settings`
   * must equal `defaultSettings`, or the form would open with a preset selected
   * while showing different values.
   */
  readonly isDefault?: boolean
  /**
   * Show on the quick-start row rather than behind "More". This is the
   * "<= 2 taps to a playable lobby" affordance: a featured preset creates a
   * lobby without the form being opened at all. Distinct from `isDefault` —
   * several presets may be featured, only one may be the default.
   */
  readonly featured?: boolean
}

export interface GameManifest<TSettings = unknown> {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly shortDescription: string
  /** Path relative to the game package, resolved by the registry. */
  readonly thumbnail: string
  readonly category: GameCategory

  readonly minPlayers: number
  readonly maxPlayers: number
  readonly teams: TeamModeName
  /** Required when `teams` is `fixed`. */
  readonly teamCount?: number

  /**
   * Seating declarations (ADR-0010). All three are optional and all three have
   * a documented default, so a manifest that omits them behaves exactly as it
   * did before they existed. They are seat-level only: declaring one never
   * calls the game module.
   */
  readonly lateJoin?: LateJoinMode
  readonly startMode?: StartMode
  readonly rematchRotation?: RematchRotation

  readonly turnModel: TurnModel
  /** Required iff `turnModel === 'realtime'`. */
  readonly realtime?: RealtimeProfile

  readonly hasHiddenInformation: boolean
  readonly usesRandomness: boolean
  readonly supportsSpectators: boolean
  readonly supportsBots: boolean

  /** Validated by the platform before any settings reach the game. */
  readonly settingsSchema: z.ZodType<TSettings>
  readonly defaultSettings: TSettings
  readonly presets: readonly SettingsPreset<TSettings>[]
  /**
   * How the create-lobby form renders (ADR-0007). Presentation only: it is
   * carried in `GameCatalogEntry` as plain JSON so the shell can render a
   * complete, correct form having loaded no game code, and it grants no
   * validation power — `settingsSchema` remains the only authority.
   */
  readonly settingsForm: SettingsFormDescriptor

  /** Every timer id the game may reference from `applyAction` or `onTimer`. */
  readonly timers: readonly TimerSpec[]

  readonly status: GameStatus
  /** Semver. A match pins to this exact value for its whole life. */
  readonly version: string
  /** The SDK contract major this game was written against. */
  readonly sdkContractVersion: number
}

const timerSpecSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['turn', 'chess-clock', 'phase', 'grace', 'match', 'custom']),
  description: z.string().min(1),
  pausesOnDisconnect: z.boolean(),
})

/** Duck-typed so a game bundling its own copy of zod still validates. */
const zodSchemaLike = z.custom<z.ZodType<unknown>>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function',
  { message: 'expected a zod schema' },
)

/** Structural validation. Cross-field rules live in `validateManifest`. */
export const gameManifestSchema = z.object({
  id: z.string().min(1),
  slug: z.string().regex(SLUG_PATTERN, 'slug must be lowercase kebab-case'),
  name: z.string().min(1),
  shortDescription: z.string().min(1).max(160),
  thumbnail: z.string().min(1),
  category: z.enum(GAME_CATEGORIES),

  minPlayers: z.number().int().min(1),
  maxPlayers: z.number().int().min(1),
  teams: z.enum(TEAM_MODES),
  teamCount: z.number().int().min(2).optional(),

  lateJoin: z.enum(LATE_JOIN_MODES).optional(),
  startMode: z.enum(START_MODES).optional(),
  rematchRotation: z.enum(REMATCH_ROTATIONS).optional(),

  turnModel: z.enum(TURN_MODELS),
  realtime: realtimeProfileSchema.optional(),

  hasHiddenInformation: z.boolean(),
  usesRandomness: z.boolean(),
  supportsSpectators: z.boolean(),
  supportsBots: z.boolean(),

  settingsSchema: zodSchemaLike,
  defaultSettings: z.unknown(),
  presets: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      description: z.string().optional(),
      settings: z.unknown(),
      isDefault: z.boolean().optional(),
      featured: z.boolean().optional(),
    }),
  ),
  settingsForm: settingsFormDescriptorSchema,

  timers: z.array(timerSpecSchema),

  status: z.enum(GAME_STATUSES),
  version: z.string().refine(isSemver, 'version must be valid semver'),
  sdkContractVersion: z.number().int().min(1),
})

export interface ManifestProblem {
  readonly path: string
  readonly message: string
}

/**
 * Full manifest validation: shape, cross-field rules, and — importantly — that
 * `defaultSettings` and every preset actually satisfy `settingsSchema`. A
 * preset that fails its own schema is a lobby that 500s on a dropdown change,
 * and it is much cheaper to catch at registry load.
 */
export function validateManifest<TSettings>(
  manifest: GameManifest<TSettings>,
): Result<GameManifest<TSettings>, readonly ManifestProblem[]> {
  const problems: ManifestProblem[] = []

  const shape = gameManifestSchema.safeParse(manifest)
  if (!shape.success) {
    for (const issue of shape.error.issues) {
      problems.push({ path: issue.path.join('.') || '(root)', message: issue.message })
    }
  }

  if (manifest.maxPlayers < manifest.minPlayers) {
    problems.push({ path: 'maxPlayers', message: 'maxPlayers must be >= minPlayers' })
  }

  const isRealtime = manifest.turnModel === 'realtime'
  if (isRealtime && manifest.realtime === undefined) {
    problems.push({ path: 'realtime', message: "turnModel 'realtime' requires a realtime profile" })
  }
  if (!isRealtime && manifest.realtime !== undefined) {
    problems.push({
      path: 'realtime',
      message: "realtime profile is only valid when turnModel is 'realtime'",
    })
  }

  // ADR-0010 decision 3. A turn-based game has no join hook, so seating a
  // newcomer mid-match would put an occupant in a roster `createInitialState`
  // fixed, with no callback through which the game could initialise them.
  // Reject it here rather than downgrading it silently — a rule that resolves
  // to something the game did not ask for is the defect ADR-0010 exists to fix.
  if (manifest.lateJoin === 'fill_empty_seats' && !isRealtime) {
    problems.push({
      path: 'lateJoin',
      message:
        "lateJoin 'fill_empty_seats' requires turnModel 'realtime': the turn-based contract has no join hook",
    })
  }

  if (manifest.teams === 'fixed') {
    if (manifest.teamCount === undefined) {
      problems.push({ path: 'teamCount', message: "teams 'fixed' requires teamCount" })
    } else if (manifest.maxPlayers % manifest.teamCount !== 0) {
      problems.push({
        path: 'teamCount',
        message: 'maxPlayers must divide evenly into teamCount for fixed teams',
      })
    }
  } else if (manifest.teamCount !== undefined) {
    problems.push({ path: 'teamCount', message: "teamCount is only valid when teams is 'fixed'" })
  }

  const timerIds = new Set<string>()
  manifest.timers.forEach((timer, index) => {
    if (timerIds.has(timer.id)) {
      problems.push({ path: `timers.${index}.id`, message: `duplicate timer id '${timer.id}'` })
    }
    timerIds.add(timer.id)
  })

  const defaults = manifest.settingsSchema.safeParse(manifest.defaultSettings)
  if (!defaults.success) {
    problems.push({
      path: 'defaultSettings',
      message: `does not satisfy settingsSchema: ${defaults.error.issues.map((i) => i.message).join('; ')}`,
    })
  } else if (
    canonicalSettingsKey(defaults.data) !== canonicalSettingsKey(manifest.defaultSettings)
  ) {
    // Parsing changed it, so the manifest declares one thing and the platform
    // would persist another. Usually a missing key relying on a zod `.default()`.
    problems.push({
      path: 'defaultSettings',
      message: 'is incomplete: settingsSchema.parse returns different settings than are declared',
    })
  }

  const presetIds = new Set<string>()
  let defaultPresets = 0
  manifest.presets.forEach((preset, index) => {
    if (presetIds.has(preset.id)) {
      problems.push({ path: `presets.${index}.id`, message: `duplicate preset id '${preset.id}'` })
    }
    presetIds.add(preset.id)
    if (preset.isDefault === true) defaultPresets += 1

    const parsed = manifest.settingsSchema.safeParse(preset.settings)
    if (!parsed.success) {
      problems.push({
        path: `presets.${index}.settings`,
        message: `does not satisfy settingsSchema: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      })
      return
    }
    if (canonicalSettingsKey(parsed.data) !== canonicalSettingsKey(preset.settings)) {
      problems.push({
        path: `presets.${index}.settings`,
        message:
          'is incomplete: parsing changes the settings, so the lobby would not match the preset label',
      })
    }
    if (
      preset.isDefault === true &&
      canonicalSettingsKey(preset.settings) !== canonicalSettingsKey(manifest.defaultSettings)
    ) {
      problems.push({
        path: `presets.${index}.settings`,
        message: 'isDefault preset must have the same settings as defaultSettings',
      })
    }
  })
  if (defaultPresets > 1) {
    problems.push({ path: 'presets', message: 'at most one preset may set isDefault' })
  }

  // The descriptor against the schema it claims to render: a field bound to a
  // key that does not exist, an option the schema rejects, a conditional field
  // that can never appear. See `settings.ts` / ADR-0007.
  for (const issue of checkSettingsForm(manifest)) {
    problems.push({ path: issue.path, message: `[${issue.code}] ${issue.message}` })
  }

  return problems.length === 0 ? ok(manifest) : err(problems)
}

/**
 * The JSON-safe projection of a manifest.
 *
 * This is what crosses a network boundary: the lobby catalogue, the registry
 * index, link-preview metadata, `<HowToPlay>`. It deliberately drops
 * `settingsSchema` (a live zod object) and keeps `defaultSettings` (plain JSON).
 */
export interface GameCatalogEntry {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly shortDescription: string
  readonly thumbnail: string
  readonly category: GameCategory
  readonly minPlayers: number
  readonly maxPlayers: number
  readonly teams: TeamModeName
  readonly teamCount: number | null
  /**
   * Seating declarations (ADR-0010), `null` when the manifest declares nothing.
   * The seats layer projects these into its `SeatingPolicy` and applies the
   * documented default for a `null`; it is the only place a manifest field
   * becomes a seating rule.
   */
  readonly lateJoin: LateJoinMode | null
  readonly startMode: StartMode | null
  readonly rematchRotation: RematchRotation | null
  readonly turnModel: TurnModel
  readonly realtime: RealtimeProfile | null
  readonly hasHiddenInformation: boolean
  readonly usesRandomness: boolean
  readonly supportsSpectators: boolean
  readonly supportsBots: boolean
  readonly defaultSettings: JsonValue
  readonly presets: readonly {
    readonly id: string
    readonly label: string
    readonly description: string | null
    readonly settings: JsonValue
    readonly isDefault: boolean
    readonly featured: boolean
  }[]
  /**
   * Already JSON — this is why the descriptor is data and not a component. The
   * create-lobby page renders the whole form from this entry alone.
   */
  readonly settingsForm: SettingsFormDescriptor
  readonly timers: readonly TimerSpec[]
  readonly status: GameStatus
  readonly version: string
  readonly sdkContractVersion: number
}

export function toCatalogEntry<TSettings>(manifest: GameManifest<TSettings>): GameCatalogEntry {
  return {
    id: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    shortDescription: manifest.shortDescription,
    thumbnail: manifest.thumbnail,
    category: manifest.category,
    minPlayers: manifest.minPlayers,
    maxPlayers: manifest.maxPlayers,
    teams: manifest.teams,
    teamCount: manifest.teamCount ?? null,
    lateJoin: manifest.lateJoin ?? null,
    startMode: manifest.startMode ?? null,
    rematchRotation: manifest.rematchRotation ?? null,
    turnModel: manifest.turnModel,
    realtime: manifest.realtime ?? null,
    hasHiddenInformation: manifest.hasHiddenInformation,
    usesRandomness: manifest.usesRandomness,
    supportsSpectators: manifest.supportsSpectators,
    supportsBots: manifest.supportsBots,
    defaultSettings: manifest.defaultSettings as JsonValue,
    presets: manifest.presets.map((preset) => ({
      id: preset.id,
      label: preset.label,
      description: preset.description ?? null,
      settings: preset.settings as JsonValue,
      isDefault: preset.isDefault ?? false,
      featured: preset.featured ?? false,
    })),
    settingsForm: manifest.settingsForm,
    timers: manifest.timers,
    status: manifest.status,
    version: manifest.version,
    sdkContractVersion: manifest.sdkContractVersion,
  }
}

/** Whether a seat count is playable for this manifest. */
export function supportsPlayerCount(manifest: GameManifest<never>, count: number): boolean {
  return count >= manifest.minPlayers && count <= manifest.maxPlayers
}
