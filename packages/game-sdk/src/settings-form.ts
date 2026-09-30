/**
 * The create-lobby settings form descriptor — the **presentation** half of the
 * settings contract, and the half a client needs.
 *
 * Decision record: `docs/adr/0007-settings-form-descriptor.md` (PER-37).
 *
 * This module is the descriptor's shape and its three pure readers, and it is
 * split out from `./settings.ts` for one reason: **it imports nothing**. No
 * zod, no other SDK module. `./settings.ts` holds the validation half — the
 * schemas, `checkSettingsForm` — and imports this one.
 *
 * ## Why the split is load-bearing
 *
 * `visibleFields` and `canonicalSettingsKey` are the only SDK *values* the
 * create-lobby renderer runs in the browser. Reaching them through the package
 * barrel pulls `settingsFormDescriptorSchema` into the same module graph, and
 * with it zod — measured at 79.6 kB raw in the create-lobby route's client
 * chunk, to re-check ~800 bytes of JSON the server already validated against
 * the game's schema at registry load. ADR-0007 justified the whole descriptor
 * design on keeping the create-lobby path light, so paying that on an LCP path
 * would be self-defeating.
 *
 * So the client imports `@playhall/game-sdk/settings-form` and gets these
 * functions without the validator. The package is marked `sideEffects: false`,
 * so the barrel is tree-shakeable too; the subpath makes the intent explicit at
 * the import site. Either way the barrel still re-exports everything here,
 * unchanged — server code and games need not know the split exists.
 *
 * **Keep this module dependency-free.** An import added here lands in the
 * browser bundle of every create-lobby page. This is not left to discipline:
 * the `no-zod-in-pure-settings` boundary rule fails the build on an edge from
 * here to zod or to `./settings.ts`, because nothing else would go red if the
 * split were quietly reversed. Validation belongs in `./settings.ts`; a new
 * *pure* reader for this descriptor belongs here.
 */

/**
 * Descriptor schema version. Bumped only for a **breaking** change to the shape
 * below. Purely additive changes — a new optional property, a new field kind a
 * renderer is required to skip rather than choke on — keep version 1.
 *
 * Separate from `SDK_CONTRACT_VERSION` and from a game's semver on purpose: a
 * form renderer cares about this shape and nothing else.
 */
export const SETTINGS_FORM_VERSION = 1

/**
 * The only value types a lobby setting may hold.
 *
 * Settings are a **flat map of scalars**, and that is a contract rather than an
 * oversight: a nested object cannot be bound to one control, diffed in a waiting
 * room, or carried in a share link. Anything richer is game state, not a lobby
 * setting.
 */
export type SettingsValue = string | number | boolean

/** The shape a game's parsed settings must have. */
export type GameSettingsShape = Readonly<Record<string, SettingsValue>>

/**
 * Show a field only while another field's value is one of `equals`.
 *
 * One level deep, deliberately: the referenced field may not itself be
 * conditional. That keeps the renderer a single pass with no cycle detection,
 * and `checkSettingsForm` rejects a chain at registry load instead of leaving it
 * to be discovered in a lobby.
 */
export interface FieldVisibility {
  readonly field: string
  readonly equals: readonly SettingsValue[]
}

export interface SelectOption {
  /** Must be a value the game's `settingsSchema` accepts for this field. */
  readonly value: string | number
  readonly label: string
  /** Optional grouping key; the renderer may show groups as sections or tabs. */
  readonly group?: string
  readonly description?: string
}

interface BaseField {
  /** Must match a key of the game's parsed settings. */
  readonly key: string
  readonly label: string
  readonly help?: string
  readonly visibleWhen?: FieldVisibility
}

export interface SelectField extends BaseField {
  readonly kind: 'select'
  readonly options: readonly SelectOption[]
  /**
   * Hint only. A renderer that draws `chips` as a dropdown is still correct,
   * which is exactly why this is a hint and not a component name — games do not
   * get to specify platform UI.
   */
  readonly display?: 'dropdown' | 'chips'
  /**
   * Group render order. A group that appears on an option but not here renders
   * after every listed group, in first-appearance order.
   */
  readonly groupOrder?: readonly string[]
}

export interface NumberField extends BaseField {
  readonly kind: 'number'
  /** Input affordances, not validation. `settingsSchema` is the authority. */
  readonly min: number
  readonly max: number
  readonly step: number
  /** Short unit suffix shown beside the input, e.g. `min`, `s`. */
  readonly unit?: string
}

export interface ToggleField extends BaseField {
  readonly kind: 'toggle'
}

export type SettingsField = SelectField | NumberField | ToggleField

export type SettingsFieldKind = SettingsField['kind']

/**
 * Everything the platform needs to build a game's create-lobby form.
 *
 * Three field kinds is the whole renderer surface. A game that wants a fourth
 * opens an ADR, not a special case.
 */
export interface SettingsFormDescriptor {
  readonly version: typeof SETTINGS_FORM_VERSION
  /** May be empty: a game with nothing to configure is legitimate. */
  readonly fields: readonly SettingsField[]
}

/**
 * Does this field's visibility rule hold for the current values?
 *
 * Exported because the shell, the server and the conformance suite must agree on
 * one implementation. `apps/web` calls this rather than reimplementing
 * `visibleWhen`.
 */
export function isFieldVisible(
  field: SettingsField,
  values: Readonly<Record<string, unknown>>,
): boolean {
  const rule = field.visibleWhen
  if (rule === undefined) return true
  const current = values[rule.field]
  if (current === undefined) return false
  return rule.equals.some((candidate) => candidate === current)
}

/** The fields a renderer should currently show, in declaration order. */
export function visibleFields(
  form: SettingsFormDescriptor,
  values: Readonly<Record<string, unknown>>,
): readonly SettingsField[] {
  return form.fields.filter((field) => isFieldVisible(field, values))
}

/**
 * Order-independent identity for a settings object, so "these two settings are
 * the same lobby" never depends on key order. Used to catch a preset or a
 * default that changes when the schema parses it.
 */
export function canonicalSettingsKey(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'undefined'
  const record = value as Record<string, unknown>
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  )
}
