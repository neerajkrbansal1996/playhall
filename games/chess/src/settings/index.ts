/**
 * Chess lobby settings: schema, defaults, presets, and the form descriptor the
 * platform renders from.
 *
 * Nothing in here imports from the platform. The only third-party dependency is
 * `zod`.
 */

export {
  TIME_CONTROL_PRESET_IDS,
  TIME_CONTROL_PRESETS,
  TIME_CONTROL_CUSTOM,
  TIME_CONTROL_UNLIMITED,
  CUSTOM_INITIAL_MINUTES,
  CUSTOM_INCREMENT_SECONDS,
  categoryFor,
  estimatedDurationSeconds,
  getTimeControlPreset,
  isTimeControlPresetId,
  type TimeControlCategory,
  type TimeControlPreset,
  type TimeControlPresetId,
  type TimeControlSelection,
} from './time-control.js'

export {
  CHESS_SETTINGS_DEFAULTS,
  chessSettingsSchema,
  colorPreferenceSchema,
  timeControlSelectionSchema,
  defaultChessSettings,
  describeTimeControl,
  hasClock,
  resolveTimeControl,
  type ChessSettings,
  type ChessSettingsInput,
  type ColorPreference,
  type ResolvedTimeControl,
} from './schema.js'

export { CHESS_SETTINGS_KEYS, chessSettingsForm, formFieldKeys } from './form.js'

/**
 * ADR-0007 descriptor types, straight from the SDK.
 *
 * These used to come through `../sdk/contract.js`, which was the local shim
 * standing in for the SDK. The shim is gone ([PER-103](/PER/issues/PER-103));
 * this re-export is here only so a consumer of the settings module does not
 * have to import the SDK separately to type the descriptor it just read.
 */
export type {
  FieldVisibility,
  NumberField,
  SelectField,
  SelectOption,
  SettingsField,
  SettingsFormDescriptor,
  ToggleField,
} from '@playhall/game-sdk'

export {
  CHESS_SETTINGS_PRESETS,
  featuredChessSettingsPresets,
  getChessSettingsPreset,
  type ChessSettingsPreset,
} from './presets.js'

export { assignColors, resolveHostColor, type Rng } from './color.js'
