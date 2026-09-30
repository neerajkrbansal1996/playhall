'use client'

import type { SettingsField, SettingsValue } from '@playhall/game-sdk'

import { ChipGroupField } from './chip-group-field'
import { DropdownSelectField } from './dropdown-select-field'
import { NumberField } from './number-field'
import { ToggleField } from './toggle-field'

export interface SettingsFieldRowProps {
  readonly field: SettingsField
  readonly value: unknown
  readonly onChange: (value: SettingsValue) => void
  readonly error?: string
  readonly disabled: boolean
  readonly idPrefix: string
}

/**
 * Dispatch on `kind`. This switch is the entire renderer surface ADR-0004 §1
 * promises: three kinds, and a game that wants a fourth opens an ADR.
 *
 * Nothing here knows a game id. If a `gameId === '…'` ever appears below this
 * line, principle 1 has been broken and the dependency-boundary job should not
 * be the thing that catches it.
 */
export function SettingsFieldRow({ field, ...rest }: SettingsFieldRowProps) {
  switch (field.kind) {
    case 'select':
      return field.display === 'chips' ? (
        <ChipGroupField field={field} {...rest} />
      ) : (
        <DropdownSelectField field={field} {...rest} />
      )
    case 'number':
      return <NumberField field={field} {...rest} />
    case 'toggle':
      return <ToggleField field={field} {...rest} />
    default:
      // Unreachable for a field that came through `normalizeSettingsForm`, which
      // drops an unknown kind before it reaches this switch. Exhaustiveness here
      // is what makes adding a kind a compile error rather than a blank row.
      return null
  }
}
