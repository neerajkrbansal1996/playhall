/**
 * TEMPORARY local shim for the settings half of `@atrium/game-sdk`.
 *
 * Companion to `./contract.ts`. A zod schema alone is not enough for the
 * platform to render a create-lobby form: it knows `timeControl` is one of
 * thirteen strings, but not that they should render as grouped chips, that two
 * number fields only apply when `custom` is picked, or what the labels read.
 * This descriptor carries exactly that presentation metadata — and nothing
 * chess-specific, so `apps/web` renders it without importing a game.
 *
 * These types belong in `packages/game-sdk`: tic-tac-toe and Prop Hunt need the
 * same thing, and a generic form renderer cannot be written against a type that
 * lives inside one game. They are declared here only because the SDK does not
 * export them yet.
 *
 * This file is the concrete ADR request to the CTO — see PER-24. When the SDK
 * exports these, delete this file and re-point the import in
 * `../settings/form.ts`; the `chessSettingsForm` value needs no changes.
 *
 * Everything here is type-only: there is no runtime coupling to unwind.
 */

/** Show a field only while another field's value is one of `equals`. */
export interface FieldVisibility {
  readonly field: string
  readonly equals: readonly string[]
}

export interface SelectOption {
  readonly value: string
  readonly label: string
  /** Optional grouping key; the renderer may show groups as sections or tabs. */
  readonly group?: string
  readonly description?: string
}

interface BaseField {
  /** Must match a key in the game's settings schema. */
  readonly key: string
  readonly label: string
  readonly help?: string
  readonly visibleWhen?: FieldVisibility
}

export interface SelectField extends BaseField {
  readonly kind: 'select'
  readonly options: readonly SelectOption[]
  /** Hint only — `chips` degrades to a plain dropdown with no loss of function. */
  readonly display?: 'dropdown' | 'chips'
  readonly groupOrder?: readonly string[]
}

export interface NumberField extends BaseField {
  readonly kind: 'number'
  readonly min: number
  readonly max: number
  readonly step: number
  readonly unit?: string
}

export interface ToggleField extends BaseField {
  readonly kind: 'toggle'
}

export type SettingsField = SelectField | NumberField | ToggleField

/**
 * What a game module exposes so the platform can build its create-lobby form.
 * The renderer only has to understand three field kinds.
 */
export interface SettingsFormDescriptor {
  readonly version: 1
  readonly fields: readonly SettingsField[]
}
