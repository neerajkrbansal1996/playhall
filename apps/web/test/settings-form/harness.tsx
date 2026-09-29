import { useSettingsForm } from '@/components/settings-form/use-settings-form'
import { SettingsForm } from '@/components/settings-form/settings-form'
import type {
  SettingsFieldErrors,
  SettingsFormPreset,
  SettingsValues,
} from '@/components/settings-form/types'

export interface HarnessProps {
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
 */
export function Harness({
  settingsForm,
  defaultSettings,
  presets = [],
  errors,
  disabled,
  onValues,
}: HarnessProps) {
  const settings = useSettingsForm({ settingsForm, defaultSettings, presets })
  onValues?.(settings.values)

  return (
    <SettingsForm
      form={settings.form}
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
