import type { SettingsValue } from '@atrium/game-sdk'

/**
 * A preset as it arrives in `GameCatalogEntry.presets` — plain JSON, so
 * `settings` is `unknown` rather than a game's `TSettings`. The renderer never
 * needs the narrower type: it copies the settings into form state and submits
 * them, and the server parses them with the game's schema.
 */
export interface SettingsFormPreset {
  readonly id: string
  readonly label: string
  readonly description?: string | null
  readonly settings: unknown
  readonly isDefault?: boolean
  readonly featured?: boolean
}

/**
 * Server-returned validation messages, keyed by settings field.
 *
 * The client never populates this from its own opinion of `min` / `max` /
 * `step`: ADR-0004 §2 makes `settingsSchema` the only authority, so these are
 * the messages the create-lobby request came back with.
 */
export type SettingsFieldErrors = Readonly<Record<string, string>>

export type SettingsValues = Readonly<Record<string, SettingsValue>>
