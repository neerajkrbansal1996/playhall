'use client'

import { visibleFields, type SettingsValue } from '@atrium/game-sdk'
import type { SettingsFormDescriptor } from '@atrium/game-sdk'

import { cn } from '@/lib/utils'

import { PresetPicker } from './preset-picker'
import { SettingsFieldRow } from './settings-field'
import type { SettingsFieldErrors, SettingsFormPreset, SettingsValues } from './types'

export interface SettingsFormProps {
  /**
   * A descriptor that has already been through `normalizeSettingsForm` — use
   * `useSettingsForm`, which does that and hands this straight back.
   */
  readonly form: SettingsFormDescriptor
  readonly values: SettingsValues
  readonly onChange: (key: string, value: SettingsValue) => void
  /** Field-keyed messages the server returned. Never populated locally. */
  readonly errors?: SettingsFieldErrors
  /** True for a non-host, or once the match has started. */
  readonly disabled?: boolean
  readonly presets?: readonly SettingsFormPreset[]
  readonly activePresetId?: string | null
  readonly onApplyPreset?: (presetId: string) => void
  /**
   * Namespace for every generated id. Distinct per form instance so create-lobby
   * and the waiting room's edit-settings can be on one page.
   */
  readonly idPrefix?: string
  readonly className?: string
}

/**
 * The generic create-lobby settings form. One component tree, every game.
 *
 * Three things it deliberately does not do:
 *
 * - **It does not validate.** `min` / `max` / `step` are affordances on the
 *   inputs; `errors` comes back from the server. ADR-0004 §2 makes
 *   `settingsSchema` the only authority, and a client that pre-judged a value
 *   would be asserting a result it does not own.
 * - **It does not strip hidden fields.** `visibleFields` decides what to *draw*;
 *   `values` still carries every setting, and the caller submits all of them. A
 *   game's schema is required to accept stale values of hidden fields, so
 *   stripping would only trade a documented case for an undocumented one.
 * - **It does not know any game.** No id, no slug, no branch. The whole reason
 *   the descriptor exists (ADR-0004, principle 1) is that this file never grows
 *   a chess clause.
 */
export function SettingsForm({
  form,
  values,
  onChange,
  errors = {},
  disabled = false,
  presets = [],
  activePresetId = null,
  onApplyPreset,
  idPrefix = 'settings',
  className,
}: SettingsFormProps) {
  const shown = visibleFields(form, values)

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      {presets.length > 0 && onApplyPreset !== undefined ? (
        <PresetPicker
          presets={presets}
          activePresetId={activePresetId}
          onApplyPreset={onApplyPreset}
          disabled={disabled}
          idPrefix={idPrefix}
        />
      ) : null}

      {shown.map((field) => (
        <SettingsFieldRow
          key={field.key}
          field={field}
          value={values[field.key]}
          onChange={(next) => onChange(field.key, next)}
          error={errors[field.key]}
          disabled={disabled}
          idPrefix={idPrefix}
        />
      ))}
    </div>
  )
}
