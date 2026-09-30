import { normalizeSettingsForm, warnAboutSkippedFields } from '@/components/settings-form/normalize'
import { SettingsForm } from '@/components/settings-form/settings-form'
import { useSettingsForm } from '@/components/settings-form/use-settings-form'
import type {
  SettingsFieldErrors,
  SettingsFormPreset,
  SettingsValues,
} from '@/components/settings-form/types'

export interface HarnessProps {
  /** Raw descriptor JSON, exactly as a `GameCatalogEntry` carries it. */
  readonly settingsForm: unknown
  readonly defaultSettings: unknown
  readonly presets?: readonly SettingsFormPreset[]
  readonly errors?: SettingsFieldErrors
  readonly disabled?: boolean
  /**
   * Called on every render with the complete value map. Tests assert on the last
   * call, which is how they check that hidden fields keep their values and that
   * an option's declared type survives a round trip through the DOM.
   */
  readonly onValues?: (values: SettingsValues) => void
}

/**
 * The composition a create-lobby page will use, with nothing else in it, so a
 * test that fails has failed in the renderer rather than in a page.
 *
 * Normalizing here mirrors the real split: the descriptor is validated once,
 * where it is read, and only the validated value reaches the renderer. In the app
 * that happens in a server component; in a test it happens in the same tick.
 */
export function Harness({
  settingsForm,
  defaultSettings,
  presets = [],
  errors,
  disabled,
  onValues,
}: HarnessProps) {
  const normalized = normalizeSettingsForm(settingsForm)
  warnAboutSkippedFields(normalized)

  const settings = useSettingsForm({ defaultSettings, presets })
  onValues?.(settings.values)

  return (
    <SettingsForm
      form={normalized.form}
      values={settings.values}
      onChange={settings.setValue}
      errors={errors}
      disabled={disabled}
      presets={presets}
      activePresetId={settings.activePresetId}
      onApplyPreset={settings.applyPreset}
    />
  )
}
