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
  formatTimeControl,
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

export type {
  FieldVisibility,
  NumberField,
  SelectField,
  SelectOption,
  SettingsField,
  SettingsFormDescriptor,
  ToggleField,
} from '../sdk/settings-contract.js'

export {
  CHESS_SETTINGS_PRESETS,
  featuredChessSettingsPresets,
  getChessSettingsPreset,
  type ChessSettingsPreset,
} from './presets.js'

export { assignColors, resolveHostColor, type Rng } from './color.js'
