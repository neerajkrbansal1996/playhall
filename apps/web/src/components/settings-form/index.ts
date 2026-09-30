/**
 * The generic create-lobby settings form (ADR-0004, [PER-43]).
 *
 * One component tree renders **any** game's settings from the
 * `SettingsFormDescriptor` carried in `GameCatalogEntry` — plain JSON, no game
 * package imported, no game code loaded on the create-lobby path.
 *
 * Two steps, and the split between them is load-bearing:
 *
 * 1. **On the server**, where the catalogue entry is read, normalize the
 *    descriptor. `normalizeSettingsForm` lives in `./normalize` and is
 *    **deliberately absent from this entry point** — it imports zod, which
 *    measured 20.7 kB gzipped in the create-lobby client bundle against the
 *    renderer's own 5.8 kB. Re-validating 817 bytes of JSON in the browser, after
 *    `checkSettingsForm` already validated it against the game's schema at
 *    registry load, would cost 3.5× the component tree on the LCP path.
 * 2. **On the client**, render.
 *
 * ```tsx
 * // page.tsx — server component
 * import { normalizeSettingsForm, warnAboutSkippedFields } from '@/components/settings-form/normalize'
 *
 * const normalized = normalizeSettingsForm(entry.settingsForm)
 * warnAboutSkippedFields(normalized)
 * return <CreateLobby form={normalized.form} entry={entry} />
 *
 * // create-lobby.tsx — 'use client'
 * const settings = useSettingsForm({ defaultSettings: entry.defaultSettings, presets: entry.presets })
 *
 * <PresetQuickStart presets={entry.presets} defaults={settings.values} onQuickStart={create} />
 * <SettingsForm
 *   form={form}
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
export { featuredPresets, presetMatching, settingsFromPreset } from './presets'
export {
  groupOptions,
  optionForToken,
  optionToken,
  selectedOption,
  type OptionGroup,
} from './grouping'
export type { SettingsFieldErrors, SettingsFormPreset, SettingsValues } from './types'

// Types only: `verbatimModuleSyntax` erases these, so re-exporting them here does
// not pull `./normalize` — and therefore zod — into a client bundle. The functions
// stay behind an explicit `@/components/settings-form/normalize` import.
export type { NormalizedSettingsForm, SkippedField } from './normalize'
