'use client'

import { Check } from 'lucide-react'

import { cn } from '@/lib/utils'

import type { SettingsFormPreset } from './types'

export interface PresetPickerProps {
  readonly presets: readonly SettingsFormPreset[]
  readonly activePresetId: string | null
  readonly onApplyPreset: (presetId: string) => void
  readonly disabled: boolean
  readonly idPrefix: string
}

/**
 * Every preset, inside the form — the "More" half of the quick-start row.
 *
 * Not a radio group, because the selection is not a value the form submits: a
 * preset is a shortcut that writes several fields, and it stops being "selected"
 * the moment a field is edited away from it. `aria-pressed` says exactly that —
 * these are toggle buttons reflecting whether the current values happen to equal
 * a preset — where `aria-checked` would promise a persistent choice the form
 * does not have.
 */
export function PresetPicker({
  presets,
  activePresetId,
  onApplyPreset,
  disabled,
  idPrefix,
}: PresetPickerProps) {
  const headingId = `${idPrefix}-presets-heading`

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3
        id={headingId}
        className="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
      >
        Presets
      </h3>
      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => {
          const active = preset.id === activePresetId
          return (
            <button
              key={preset.id}
              type="button"
              aria-pressed={active}
              disabled={disabled}
              title={preset.description ?? undefined}
              onClick={() => onApplyPreset(preset.id)}
              className={cn(
                'inline-flex h-11 items-center gap-1.5 rounded-md border px-3.5 text-sm',
                'font-medium transition-colors',
                'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
                active
                  ? 'border-primary bg-primary text-primary-foreground font-semibold'
                  : 'bg-background hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {active ? <Check aria-hidden="true" className="size-4" /> : null}
              {preset.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}
