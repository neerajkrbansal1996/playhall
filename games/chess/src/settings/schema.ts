/**
 * The chess lobby settings schema.
 *
 * This is the single source of truth for what a chess lobby can be configured
 * to be. The platform validates create-lobby input against it server-side and
 * auto-generates the form from the descriptor in `./form.ts`. `apps/web` must
 * not contain a chess-specific field anywhere.
 */

import { z } from 'zod'

import {
  CUSTOM_INCREMENT_SECONDS,
  CUSTOM_INITIAL_MINUTES,
  TIME_CONTROL_CUSTOM,
  TIME_CONTROL_PRESET_IDS,
  TIME_CONTROL_UNLIMITED,
  getTimeControlPreset,
  isTimeControlPresetId,
} from './time-control.js'

/** Everything the time-control picker can be set to. */
export const timeControlSelectionSchema = z.enum([
  ...TIME_CONTROL_PRESET_IDS,
  TIME_CONTROL_CUSTOM,
  TIME_CONTROL_UNLIMITED,
] as const)

export const colorPreferenceSchema = z.enum(['white', 'black', 'random'])
export type ColorPreference = z.infer<typeof colorPreferenceSchema>

function isMultipleOf(value: number, step: number): boolean {
  // Both 0.5 and 1 are exact in binary floating point, so this stays exact for
  // every value the bounds admit.
  const quotient = value / step
  return Number.isInteger(Number(quotient.toFixed(6)))
}

const customInitialMinutesSchema = z
  .number()
  .min(CUSTOM_INITIAL_MINUTES.min, {
    message: `Must be at least ${CUSTOM_INITIAL_MINUTES.min} minutes`,
  })
  .max(CUSTOM_INITIAL_MINUTES.max, {
    message: `Must be at most ${CUSTOM_INITIAL_MINUTES.max} minutes`,
  })
  .refine((v) => isMultipleOf(v, CUSTOM_INITIAL_MINUTES.step), {
    message: `Must be a multiple of ${CUSTOM_INITIAL_MINUTES.step} minutes`,
  })

const customIncrementSecondsSchema = z
  .number()
  .int({ message: 'Must be a whole number of seconds' })
  .min(CUSTOM_INCREMENT_SECONDS.min, {
    message: `Must be at least ${CUSTOM_INCREMENT_SECONDS.min} seconds`,
  })
  .max(CUSTOM_INCREMENT_SECONDS.max, {
    message: `Must be at most ${CUSTOM_INCREMENT_SECONDS.max} seconds`,
  })

export const CHESS_SETTINGS_DEFAULTS = {
  timeControl: '5+0',
  customInitialMinutes: 5,
  customIncrementSeconds: 0,
  /** Colour preference of the player who opened the lobby. */
  color: 'random',
  /** Spec: default off. */
  takebacks: false,
  /**
   * Client-side convenience only. When false the promotion picker is shown.
   * Defaults to false so under-promotion is never silently taken away — the
   * server always requires an explicit promotion piece regardless of this flag.
   */
  autoQueen: false,
} as const

/**
 * `.strict()` matters: the server is authoritative, and an unknown key in a
 * create-lobby payload is a modified client, not a forward-compatible one.
 */
export const chessSettingsSchema = z
  .object({
    timeControl: timeControlSelectionSchema.default(CHESS_SETTINGS_DEFAULTS.timeControl),
    customInitialMinutes: customInitialMinutesSchema.default(
      CHESS_SETTINGS_DEFAULTS.customInitialMinutes,
    ),
    customIncrementSeconds: customIncrementSecondsSchema.default(
      CHESS_SETTINGS_DEFAULTS.customIncrementSeconds,
    ),
    color: colorPreferenceSchema.default(CHESS_SETTINGS_DEFAULTS.color),
    takebacks: z.boolean().default(CHESS_SETTINGS_DEFAULTS.takebacks),
    autoQueen: z.boolean().default(CHESS_SETTINGS_DEFAULTS.autoQueen),
  })
  .strict()

/** Parsed, fully-populated settings. This is what the game module receives. */
export type ChessSettings = z.infer<typeof chessSettingsSchema>

/** What a client may send: every field optional, defaults fill the rest. */
export type ChessSettingsInput = z.input<typeof chessSettingsSchema>

/** Defaults as a parsed object, for `getDefaultSettings()` on the game module. */
export function defaultChessSettings(): ChessSettings {
  return chessSettingsSchema.parse({})
}

export interface ResolvedTimeControl {
  /** Starting time per player, in milliseconds. */
  readonly initialMs: number
  /** Added to the mover's clock after each of their moves, in milliseconds. */
  readonly incrementMs: number
}

/**
 * Collapse the picker state into the two numbers the platform clock needs.
 * Returns `null` for "No clock" — the caller must then not request a clock at
 * all rather than requesting an infinite one.
 */
export function resolveTimeControl(settings: ChessSettings): ResolvedTimeControl | null {
  if (settings.timeControl === TIME_CONTROL_UNLIMITED) return null

  if (settings.timeControl === TIME_CONTROL_CUSTOM) {
    return {
      initialMs: Math.round(settings.customInitialMinutes * 60_000),
      incrementMs: settings.customIncrementSeconds * 1_000,
    }
  }

  const preset = getTimeControlPreset(settings.timeControl)
  return {
    initialMs: Math.round(preset.initialMinutes * 60_000),
    incrementMs: preset.incrementSeconds * 1_000,
  }
}

/** `3+2`, `0.5+0`, or `No clock` — used for lobby titles and share previews. */
export function describeTimeControl(settings: ChessSettings): string {
  if (settings.timeControl === TIME_CONTROL_UNLIMITED) return 'No clock'
  if (settings.timeControl === TIME_CONTROL_CUSTOM) {
    return `${settings.customInitialMinutes}+${settings.customIncrementSeconds}`
  }
  return settings.timeControl
}

export function hasClock(settings: ChessSettings): boolean {
  return resolveTimeControl(settings) !== null
}

export { isTimeControlPresetId }
