/**
 * The generic create-lobby settings form (ADR-0004, [PER-43]).
 *
 * One component tree renders **any** game's settings from the
 * `SettingsFormDescriptor` carried in `GameCatalogEntry` — plain JSON, no game
 * package imported, no game code loaded on the create-lobby path.
 *
 * Typical use:
 *
 * ```tsx
 * const settings = useSettingsForm({
 *   settingsForm: entry.settingsForm,
 *   defaultSettings: entry.defaultSettings,
 *   presets: entry.presets,
 * })
 *
 * <PresetQuickStart presets={entry.presets} defaults={settings.values} onQuickStart={create} />
 * <SettingsForm
 *   form={settings.form}
 *   values={settings.values}
 *   onChange={settings.setValue}
 *   errors={serverErrors}
 *   presets={entry.presets}
 *   activePresetId={settings.activePresetId}
 *   onApplyPreset={settings.applyPreset}
 * />
 * ```
 */

export { SettingsForm, type SettingsFormProps } from './settings-form'
export { SettingsFieldRow, type SettingsFieldRowProps } from './settings-field'
export { PresetQuickStart, type PresetQuickStartProps } from './preset-quick-start'
export { PresetPicker, type PresetPickerProps } from './preset-picker'
export { useSettingsForm } from './use-settings-form'
export type { UseSettingsFormOptions, UseSettingsFormResult } from './use-settings-form'
export {
  describeSkippedField,
  normalizeSettingsForm,
  type NormalizedSettingsForm,
  type SkippedField,
} from './normalize'
export { featuredPresets, presetMatching, settingsFromPreset } from './presets'
export {
  groupOptions,
  optionForToken,
  optionToken,
  selectedOption,
  type OptionGroup,
} from './grouping'
export type { SettingsFieldErrors, SettingsFormPreset, SettingsValues } from './types'
