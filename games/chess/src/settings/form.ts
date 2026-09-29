/**
 * Declarative descriptor for the chess create-lobby form.
 *
 * The platform reads this and renders the form generically: `apps/web` contains
 * no chess-specific field, no time-control list, and no knowledge that
 * `customInitialMinutes` exists. The field types live in
 * `../sdk/settings-contract.ts` — a temporary local copy of what
 * `packages/game-sdk` should export (see PER-24).
 */

import type {
  FieldVisibility,
  SelectOption,
  SettingsFormDescriptor,
} from '../sdk/settings-contract.js'
import {
  CUSTOM_INCREMENT_SECONDS,
  CUSTOM_INITIAL_MINUTES,
  TIME_CONTROL_CUSTOM,
  TIME_CONTROL_PRESETS,
  TIME_CONTROL_UNLIMITED,
  type TimeControlCategory,
} from './time-control.js'
import { CHESS_SETTINGS_DEFAULTS } from './schema.js'

const CATEGORY_LABELS: Record<TimeControlCategory, string> = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
}

const CATEGORY_ORDER: readonly TimeControlCategory[] = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
]

const OTHER_GROUP = 'Other'

const timeControlOptions: readonly SelectOption[] = [
  ...TIME_CONTROL_PRESETS.map((preset) => ({
    value: preset.id,
    label: preset.id,
    group: CATEGORY_LABELS[preset.category],
  })),
  { value: TIME_CONTROL_CUSTOM, label: 'Custom', group: OTHER_GROUP },
  { value: TIME_CONTROL_UNLIMITED, label: 'No clock', group: OTHER_GROUP },
]

const showWhenCustom: FieldVisibility = {
  field: 'timeControl',
  equals: [TIME_CONTROL_CUSTOM],
}

export const chessSettingsForm: SettingsFormDescriptor = {
  version: 1,
  fields: [
    {
      kind: 'select',
      key: 'timeControl',
      label: 'Time control',
      display: 'chips',
      options: timeControlOptions,
      groupOrder: [...CATEGORY_ORDER.map((c) => CATEGORY_LABELS[c]), OTHER_GROUP],
    },
    {
      kind: 'number',
      key: 'customInitialMinutes',
      label: 'Minutes per side',
      unit: 'min',
      min: CUSTOM_INITIAL_MINUTES.min,
      max: CUSTOM_INITIAL_MINUTES.max,
      step: CUSTOM_INITIAL_MINUTES.step,
      visibleWhen: showWhenCustom,
    },
    {
      kind: 'number',
      key: 'customIncrementSeconds',
      label: 'Increment',
      unit: 's',
      help: 'Added to your clock after each move you make.',
      min: CUSTOM_INCREMENT_SECONDS.min,
      max: CUSTOM_INCREMENT_SECONDS.max,
      step: CUSTOM_INCREMENT_SECONDS.step,
      visibleWhen: showWhenCustom,
    },
    {
      kind: 'select',
      key: 'color',
      label: 'Colour',
      display: 'chips',
      options: [
        { value: 'white', label: 'White' },
        { value: 'black', label: 'Black' },
        { value: 'random', label: 'Random' },
      ],
    },
    {
      kind: 'toggle',
      key: 'takebacks',
      label: 'Allow takebacks',
      help: 'Your opponent can ask to take back their last move.',
    },
    {
      kind: 'toggle',
      key: 'autoQueen',
      label: 'Auto-promote to queen',
      help: 'Skip the promotion picker and always promote to a queen.',
    },
  ],
}

/** Field keys the descriptor binds to, in render order. */
export function formFieldKeys(): readonly string[] {
  return chessSettingsForm.fields.map((field) => field.key)
}

/**
 * Settings keys the schema defines. A field bound to a key that is not here
 * would render a control wired to nothing, so the test suite asserts both
 * directions of this correspondence.
 */
export const CHESS_SETTINGS_KEYS: readonly string[] = Object.keys(
  CHESS_SETTINGS_DEFAULTS,
)
