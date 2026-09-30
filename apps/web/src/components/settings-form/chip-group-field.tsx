'use client'

import { Check } from 'lucide-react'
import type { SelectField, SettingsValue } from '@playhall/game-sdk'

import { cn } from '@/lib/utils'

import { FieldShell, fieldIds } from './field-shell'
import { groupOptions, optionForToken, optionToken } from './grouping'

export interface ChipGroupFieldProps {
  readonly field: SelectField
  readonly value: unknown
  readonly onChange: (value: SettingsValue) => void
  readonly error?: string
  readonly disabled: boolean
  readonly idPrefix: string
}

/**
 * `display: 'chips'` — a radio group drawn as tappable chips.
 *
 * These are **native `<input type="radio">` elements**, visually hidden behind
 * their own `<label>`. That is a deliberate choice over a `role="radiogroup"` /
 * `role="radio"` widget with a roving tabindex: native radios already give
 * arrow-key navigation, one tab stop for the whole group, correct
 * "3 of 12"-style position announcements, forced-colours support and form
 * semantics, in every browser on our support matrix. The hand-rolled version
 * would be more code whose only new feature is bugs.
 *
 * Grouped options (chess's Bullet / Blitz / Rapid / Classical / Other) become
 * `role="group"` sections with their own heading. All the radios keep one `name`,
 * so the groups are visual and semantic structure, not twelve separate choices.
 */
export function ChipGroupField({
  field,
  value,
  onChange,
  error,
  disabled,
  idPrefix,
}: ChipGroupFieldProps) {
  const ids = fieldIds(idPrefix, field.key, field.help, error)
  const groups = groupOptions(field)

  function handleChange(token: string): void {
    const option = optionForToken(field, token)
    // Preserve the declared type: the descriptor's value goes back out, never a
    // re-parsed copy of the DOM string.
    if (option !== undefined) onChange(option.value)
  }

  return (
    <FieldShell
      idPrefix={idPrefix}
      fieldKey={field.key}
      value={value}
      label={field.label}
      help={field.help}
      error={error}
      as="fieldset"
    >
      <div className="flex flex-col gap-3">
        {groups.map((group) => {
          const headingId =
            group.group === null ? undefined : `${ids.controlId}-group-${group.group}`
          return (
            <div
              key={group.group ?? '__ungrouped__'}
              role={group.group === null ? undefined : 'group'}
              aria-labelledby={headingId}
              className="flex flex-col gap-1.5"
            >
              {group.group === null ? null : (
                <span
                  id={headingId}
                  className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide"
                >
                  {group.group}
                </span>
              )}
              <div className="flex flex-wrap gap-2">
                {group.options.map((option) => {
                  const token = optionToken(option.value)
                  const checked = option.value === value
                  const optionId = `${ids.controlId}-${token}`
                  return (
                    <div key={token} className="contents">
                      <input
                        type="radio"
                        id={optionId}
                        name={ids.controlId}
                        value={token}
                        checked={checked}
                        disabled={disabled}
                        aria-describedby={ids.describedBy}
                        aria-invalid={ids.hasError || undefined}
                        onChange={() => handleChange(token)}
                        className="peer sr-only"
                      />
                      <label
                        htmlFor={optionId}
                        title={option.description}
                        className={cn(
                          // 44px tall: mobile-first, and the WCAG 2.1 target size.
                          'inline-flex h-11 cursor-pointer select-none items-center gap-1.5',
                          'rounded-md border px-3.5 text-sm font-medium transition-colors',
                          'peer-focus-visible:ring-ring/50 peer-focus-visible:ring-[3px]',
                          'peer-focus-visible:border-ring peer-focus-visible:outline-none',
                          'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
                          checked
                            ? // Selection is carried by the tick, the weight and the
                              // border as well as the fill — never colour alone.
                              'border-primary bg-primary text-primary-foreground font-semibold'
                            : 'bg-background hover:bg-accent hover:text-accent-foreground',
                        )}
                      >
                        {checked ? <Check aria-hidden="true" className="size-4" /> : null}
                        {option.label}
                      </label>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </FieldShell>
  )
}
