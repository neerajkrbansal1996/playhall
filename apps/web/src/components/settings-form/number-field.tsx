'use client'

import { useState } from 'react'
import type { NumberField as NumberFieldDescriptor, SettingsValue } from '@playhall/game-sdk'

import { cn } from '@/lib/utils'

import { FieldShell, fieldIds } from './field-shell'

export interface NumberFieldProps {
  readonly field: NumberFieldDescriptor
  readonly value: unknown
  readonly onChange: (value: SettingsValue) => void
  readonly error?: string
  readonly disabled: boolean
  readonly idPrefix: string
}

/**
 * `kind: 'number'` — a native number input with the descriptor's affordances.
 *
 * `min` / `max` / `step` go on the element because they make the control usable
 * (steppers land on halves for chess's minutes, the phone shows a numeric
 * keypad). They are **not** enforced here, and the value is not clamped:
 * ADR-0004 §2 is explicit that a value inside them can still be rejected and a
 * value outside them is rejected by `settingsSchema` on the server. Clamping
 * would mean the client had decided a value was legal, and would hide the
 * server's message behind a number the player never typed.
 *
 * The one thing we do refuse to *store* is a non-number: an empty or half-typed
 * input ('', '-', '1.') leaves the committed value untouched, so the field never
 * submits `NaN`. That is why the element needs a draft string alongside the
 * committed number. A controlled input that simply dropped an unparseable change
 * would snap back to the old digits on every keystroke — the player could not
 * clear the box to retype, and "5" then "999" would read as "5999".
 */
export function NumberField({
  field,
  value,
  onChange,
  error,
  disabled,
  idPrefix,
}: NumberFieldProps) {
  const ids = fieldIds(idPrefix, field.key, field.help, error)
  const unitId = field.unit === undefined ? undefined : `${ids.controlId}-unit`
  // The unit is part of the question ("Minutes per side — min"), so it belongs in
  // the accessible description rather than being decoration a screen reader drops.
  const describedBy = [ids.describedBy, unitId].filter(Boolean).join(' ') || undefined

  // `from` records the committed value the draft was typed against. Once the
  // committed value moves on its own — a preset applied, another player's edit
  // arriving in the waiting room — the draft is stale and the real value wins.
  const [draft, setDraft] = useState<{ raw: string; from: SettingsValue | undefined } | null>(null)
  const committed = typeof value === 'number' ? String(value) : ''
  const shown = draft !== null && draft.from === value ? draft.raw : committed

  return (
    <FieldShell
      idPrefix={idPrefix}
      fieldKey={field.key}
      label={field.label}
      help={field.help}
      error={error}
      as="div"
    >
      <div className="flex items-center gap-2">
        <input
          id={ids.controlId}
          type="number"
          inputMode="decimal"
          value={shown}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={ids.hasError || undefined}
          onChange={(event) => {
            const raw = event.target.value
            const next = Number(raw)
            if (raw.trim() === '' || Number.isNaN(next)) {
              // Keep the box showing what was typed; leave the payload alone.
              setDraft({ raw, from: value as SettingsValue | undefined })
              return
            }
            setDraft({ raw, from: next })
            onChange(next)
          }}
          // On the way out, show the committed number: '007' and '1.' become
          // 7 and 1, which is what will actually be submitted.
          onBlur={() => setDraft(null)}
          className={cn(
            'h-11 w-full min-w-0 rounded-md border px-3 text-sm',
            'bg-background focus-visible:border-ring focus-visible:ring-ring/50',
            'focus-visible:ring-[3px] focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            ids.hasError && 'border-destructive',
          )}
        />
        {field.unit === undefined ? null : (
          <span id={unitId} className="text-muted-foreground shrink-0 text-sm">
            {field.unit}
          </span>
        )}
      </div>
    </FieldShell>
  )
}
