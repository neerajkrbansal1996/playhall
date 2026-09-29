'use client'

import { ChevronDown } from 'lucide-react'
import type { SelectField, SettingsValue } from '@atrium/game-sdk'

import { cn } from '@/lib/utils'

import { FieldShell, fieldIds } from './field-shell'
import { groupOptions, optionForToken, optionToken, selectedOption } from './grouping'

export interface DropdownSelectFieldProps {
  readonly field: SelectField
  readonly value: unknown
  readonly onChange: (value: SettingsValue) => void
  readonly error?: string
  readonly disabled: boolean
  readonly idPrefix: string
}

/**
 * `display: 'dropdown'`, and the default when `display` is absent.
 *
 * A native `<select>`, which on a phone opens the platform picker — a better
 * long-list experience than any custom listbox, and free keyboard and
 * screen-reader support. `option.group` maps onto `<optgroup>`, the exact
 * primitive the descriptor's grouping was describing.
 */
export function DropdownSelectField({
  field,
  value,
  onChange,
  error,
  disabled,
  idPrefix,
}: DropdownSelectFieldProps) {
  const ids = fieldIds(idPrefix, field.key, field.help, error)
  const groups = groupOptions(field)
  const current = selectedOption(field, value)

  return (
    <FieldShell
      idPrefix={idPrefix}
      fieldKey={field.key}
      label={field.label}
      help={field.help}
      error={error}
      as="div"
    >
      <div className="relative">
        <select
          id={ids.controlId}
          // A value the descriptor does not offer (a stale share link, a preset
          // from an older game version) must not be silently coerced to the first
          // option — `''` shows nothing selected and leaves the stored value
          // alone for the server to rule on.
          value={current === undefined ? '' : optionToken(current.value)}
          disabled={disabled}
          aria-describedby={ids.describedBy}
          aria-invalid={ids.hasError || undefined}
          onChange={(event) => {
            const option = optionForToken(field, event.target.value)
            if (option !== undefined) onChange(option.value)
          }}
          className={cn(
            'h-11 w-full appearance-none rounded-md border px-3 pr-9 text-sm',
            'bg-background focus-visible:border-ring focus-visible:ring-ring/50',
            'focus-visible:ring-[3px] focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            ids.hasError && 'border-destructive',
          )}
        >
          {current === undefined ? <option value="" /> : null}
          {groups.map((group) =>
            group.group === null ? (
              group.options.map((option) => (
                <option key={optionToken(option.value)} value={optionToken(option.value)}>
                  {option.label}
                </option>
              ))
            ) : (
              <optgroup key={group.group} label={group.group}>
                {group.options.map((option) => (
                  <option key={optionToken(option.value)} value={optionToken(option.value)}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ),
          )}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2"
        />
      </div>
    </FieldShell>
  )
}
