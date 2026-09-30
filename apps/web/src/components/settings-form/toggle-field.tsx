'use client'

import { AlertCircle, Check, X } from 'lucide-react'
import type { SettingsValue, ToggleField as ToggleFieldDescriptor } from '@playhall/game-sdk'

import { cn } from '@/lib/utils'

import { fieldIds } from './field-shell'

export interface ToggleFieldProps {
  readonly field: ToggleFieldDescriptor
  readonly value: unknown
  readonly onChange: (value: SettingsValue) => void
  readonly error?: string
  readonly disabled: boolean
  readonly idPrefix: string
}

/**
 * `kind: 'toggle'` — a `role="switch"` button.
 *
 * This is the one field kind that does not use `FieldShell`'s vertical layout:
 * a switch reads as "label on the left, control on the right" and the label has
 * to be the switch's accessible name rather than a `<label for>` above it. The
 * help and error markup below is therefore duplicated deliberately, and still
 * uses `fieldIds` so the `aria-describedby` ids match every other field.
 *
 * On / off is carried by a tick, a cross and the knob's position as well as the
 * track colour — "never rely on colour alone" applies to a switch more than
 * anything else on the form, since the two states are otherwise identical shapes.
 */
export function ToggleField({
  field,
  value,
  onChange,
  error,
  disabled,
  idPrefix,
}: ToggleFieldProps) {
  const ids = fieldIds(idPrefix, field.key, field.help, error)
  const checked = value === true

  return (
    <div
      data-slot="settings-field"
      data-field-key={field.key}
      className="flex min-w-0 flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-4">
        <span id={ids.labelId} className="text-sm font-medium">
          {field.label}
        </span>
        <button
          type="button"
          role="switch"
          id={ids.controlId}
          aria-checked={checked}
          aria-labelledby={ids.labelId}
          aria-describedby={ids.describedBy}
          aria-invalid={ids.hasError || undefined}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className={cn(
            // 44px hit area via the padding on the row; the track itself is the
            // conventional 28px so it does not dominate a dense form.
            'focus-visible:ring-ring/50 relative inline-flex h-7 w-12 shrink-0 items-center',
            'rounded-full border transition-colors focus-visible:ring-[3px]',
            'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
            checked ? 'border-primary bg-primary' : 'bg-muted border-border',
          )}
        >
          <span
            className={cn(
              'bg-background flex size-5 items-center justify-center rounded-full shadow-sm',
              'transition-transform',
              checked ? 'translate-x-6' : 'translate-x-1',
            )}
          >
            {checked ? (
              <Check aria-hidden="true" className="text-primary size-3" />
            ) : (
              <X aria-hidden="true" className="text-muted-foreground size-3" />
            )}
          </span>
        </button>
      </div>

      {field.help !== undefined && field.help.length > 0 ? (
        <p id={`${ids.controlId}-help`} className="text-muted-foreground text-xs">
          {field.help}
        </p>
      ) : null}

      {error !== undefined && error.length > 0 ? (
        <p
          id={`${ids.controlId}-error`}
          role="alert"
          className="text-destructive flex items-start gap-1.5 text-xs font-medium"
        >
          <AlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  )
}
