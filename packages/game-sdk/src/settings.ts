/**
 * The create-lobby settings form descriptor.
 *
 * Decision record: `docs/adr/0007-settings-form-descriptor.md` (PER-37).
 *
 * A game's `settingsSchema` is the **authority**: zod, `.strict()`, parsed
 * server-side before a lobby exists. It says `timeControl` is one of twelve
 * strings. What it cannot say is that those strings group into Bullet / Blitz /
 * Rapid / Classical, that two number fields only apply when `custom` is picked,
 * what the labels read, or that one of them steps in halves. Without somewhere
 * to put that, it ends up in `apps/web` — and the second game has to add a
 * branch there, which breaks principle 1.
 *
 * So the manifest carries a second, *presentation-only* value: this descriptor.
 * Three field kinds, one visibility rule, no components, no callbacks, pure
 * JSON — so it rides along in `GameCatalogEntry` and the create-lobby page
 * renders a complete form having loaded **zero bytes of game code**.
 *
 * Presentation-only is load-bearing. The descriptor grants no validation power:
 * hiding a field does not stop that field arriving, and `min` here does not make
 * a smaller value invalid. Only `settingsSchema` decides that, only on the
 * server. A game's schema must therefore accept every value combination
 * reachable through its own descriptor, including stale values of hidden fields.
 */

import { z } from 'zod'
import type { ZodType } from 'zod'

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

const settingsValueSchema = z.union([z.string(), z.number(), z.boolean()])

const fieldVisibilitySchema = z
  .object({
    field: z.string().min(1),
    equals: z.array(settingsValueSchema).min(1),
  })
  .strict()

const baseFieldShape = {
  key: z.string().min(1),
  label: z.string().min(1),
  help: z.string().min(1).optional(),
  visibleWhen: fieldVisibilitySchema.optional(),
}

const selectOptionSchema = z
  .object({
    value: z.union([z.string(), z.number()]),
    label: z.string().min(1),
    group: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
  })
  .strict()

const selectFieldSchema = z
  .object({
    ...baseFieldShape,
    kind: z.literal('select'),
    options: z.array(selectOptionSchema).min(1),
    display: z.enum(['dropdown', 'chips']).optional(),
    groupOrder: z.array(z.string().min(1)).optional(),
  })
  .strict()

const numberFieldSchema = z
  .object({
    ...baseFieldShape,
    kind: z.literal('number'),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive(),
    unit: z.string().min(1).optional(),
  })
  .strict()

const toggleFieldSchema = z.object({ ...baseFieldShape, kind: z.literal('toggle') }).strict()

export const settingsFieldSchema = z.discriminatedUnion('kind', [
  selectFieldSchema,
  numberFieldSchema,
  toggleFieldSchema,
])

/**
 * Structural validation of a descriptor. Shape only — the checks that need the
 * game's schema live in `checkSettingsForm`.
 */
export const settingsFormDescriptorSchema = z
  .object({
    version: z.literal(SETTINGS_FORM_VERSION),
    fields: z.array(settingsFieldSchema),
  })
  .strict()

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

export type SettingsFormIssueCode =
  | 'descriptor_invalid'
  | 'defaults_not_an_object'
  | 'defaults_rejected'
  | 'duplicate_field_key'
  | 'unknown_field_key'
  | 'non_scalar_field_key'
  | 'number_bounds_invalid'
  | 'number_bound_rejected'
  | 'option_rejected'
  | 'visibility_target_missing'
  | 'visibility_target_self'
  | 'visibility_target_conditional'
  | 'visibility_unsatisfiable'

export interface SettingsFormIssue {
  readonly code: SettingsFormIssueCode
  /** Dotted path into the manifest, e.g. `settingsForm.fields.timeControl`. */
  readonly path: string
  readonly message: string
}

/**
 * The slice of a manifest `checkSettingsForm` needs. Declared structurally so
 * this module stays below `manifest.ts` in the import graph.
 */
export interface SettingsContract<TSettings> {
  readonly settingsForm: SettingsFormDescriptor
  readonly settingsSchema: ZodType<TSettings>
  readonly defaultSettings: TSettings
}

function issuesToMessage(issues: readonly z.ZodIssue[]): string {
  return issues
    .map((issue) => [issue.path.join('.'), issue.message].filter(Boolean).join(' '))
    .join('; ')
}

/**
 * Cross-check a descriptor against the schema and defaults it claims to render.
 *
 * Every issue returned here is a bug that would otherwise ship as a control
 * wired to nothing, a chip that always fails to submit, or a conditional field
 * that can never appear. `validateManifest` runs this at registry load and the
 * conformance testkit fails the build on a non-empty result.
 *
 * Pure: no I/O, no clock, no randomness. Safe to call at module load.
 */
export function checkSettingsForm<TSettings>(
  contract: SettingsContract<TSettings>,
): readonly SettingsFormIssue[] {
  const issues: SettingsFormIssue[] = []
  const add = (code: SettingsFormIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }

  const structural = settingsFormDescriptorSchema.safeParse(contract.settingsForm)
  if (!structural.success) {
    for (const issue of structural.error.issues) {
      add(
        'descriptor_invalid',
        ['settingsForm', ...issue.path.map(String)].join('.'),
        issue.message,
      )
    }
    // Everything below indexes into fields whose shape is not trustworthy.
    return issues
  }

  const { settingsSchema: schema, settingsForm: form } = contract

  if (typeof contract.defaultSettings !== 'object' || contract.defaultSettings === null) {
    add(
      'defaults_not_an_object',
      'defaultSettings',
      'Settings must be a flat object of string, number and boolean values.',
    )
    return issues
  }
  const defaults = contract.defaultSettings as Record<string, unknown>

  // Every value probe below starts from the defaults, so unparseable defaults
  // would turn one bug into one failure per option. Report it once and skip the
  // probes; the structural checks below still run.
  const defaultsParse = schema.safeParse(defaults)
  if (!defaultsParse.success) {
    add(
      'defaults_rejected',
      'defaultSettings',
      `does not satisfy settingsSchema, so the descriptor cannot be checked against it: ${issuesToMessage(defaultsParse.error.issues)}`,
    )
  }

  const fieldsByKey = new Map<string, SettingsField>()
  for (const field of form.fields) {
    if (!fieldsByKey.has(field.key)) fieldsByKey.set(field.key, field)
  }

  const seenKeys = new Set<string>()
  for (const field of form.fields) {
    const at = `settingsForm.fields.${field.key}`

    if (seenKeys.has(field.key)) {
      add('duplicate_field_key', at, `Two fields bind to '${field.key}'.`)
      continue
    }
    seenKeys.add(field.key)

    if (!Object.prototype.hasOwnProperty.call(defaults, field.key)) {
      add(
        'unknown_field_key',
        at,
        `'${field.key}' is not a key of this game's settings, so the control would be wired to nothing.`,
      )
      continue
    }

    const currentDefault = defaults[field.key]
    if (
      typeof currentDefault !== 'string' &&
      typeof currentDefault !== 'number' &&
      typeof currentDefault !== 'boolean'
    ) {
      add(
        'non_scalar_field_key',
        at,
        `'${field.key}' is not a scalar; a form field can only bind a string, number or boolean.`,
      )
      continue
    }

    checkVisibility(field, fieldsByKey, add)

    const base: Record<string, unknown> = { ...defaults }
    const rule = field.visibleWhen
    // Probe a conditional field under the condition that reveals it, or a
    // cross-field rule in the schema would reject every probe we send.
    if (rule !== undefined && rule.equals.length > 0) base[rule.field] = rule.equals[0]

    // A base the schema already rejects cannot tell us anything about this
    // field's own values. The visibility checks above have named the cause.
    const canProbe = defaultsParse.success && schema.safeParse(base).success
    if (!canProbe) {
      if (field.kind === 'number' && !(field.min <= field.max)) {
        add('number_bounds_invalid', at, `min (${field.min}) must not exceed max (${field.max}).`)
      }
      continue
    }

    if (field.kind === 'select') {
      for (const [index, option] of field.options.entries()) {
        const probe = schema.safeParse({ ...base, [field.key]: option.value })
        if (!probe.success) {
          add(
            'option_rejected',
            `${at}.options.${index}`,
            `settingsSchema rejects '${String(option.value)}', so this option could never be submitted: ${issuesToMessage(probe.error.issues)}`,
          )
        }
      }
    }

    if (field.kind === 'number') {
      if (!(field.min <= field.max)) {
        add('number_bounds_invalid', at, `min (${field.min}) must not exceed max (${field.max}).`)
      }
      for (const [name, bound] of [
        ['min', field.min],
        ['max', field.max],
      ] as const) {
        const probe = schema.safeParse({ ...base, [field.key]: bound })
        if (!probe.success) {
          add(
            'number_bound_rejected',
            `${at}.${name}`,
            `settingsSchema rejects ${name} (${bound}); the descriptor's bounds have drifted from the schema's: ${issuesToMessage(probe.error.issues)}`,
          )
        }
      }
    }
  }

  return issues
}

function checkVisibility(
  field: SettingsField,
  fieldsByKey: ReadonlyMap<string, SettingsField>,
  add: (code: SettingsFormIssueCode, path: string, message: string) => void,
): void {
  const rule = field.visibleWhen
  if (rule === undefined) return
  const at = `settingsForm.fields.${field.key}.visibleWhen`

  if (rule.field === field.key) {
    add('visibility_target_self', at, 'A field cannot be conditional on itself.')
    return
  }

  const target = fieldsByKey.get(rule.field)
  if (target === undefined) {
    add(
      'visibility_target_missing',
      at,
      `'${rule.field}' is not a field in this descriptor, so the condition can never be evaluated.`,
    )
    return
  }

  if (target.visibleWhen !== undefined) {
    add(
      'visibility_target_conditional',
      at,
      `'${rule.field}' is itself conditional; visibility chains are not supported.`,
    )
  }

  if (target.kind === 'select') {
    const optionValues = new Set<SettingsValue>(target.options.map((option) => option.value))
    for (const [index, candidate] of rule.equals.entries()) {
      if (!optionValues.has(candidate)) {
        add(
          'visibility_unsatisfiable',
          `${at}.equals.${index}`,
          `'${String(candidate)}' is not an option of '${rule.field}', so this field could never appear.`,
        )
      }
    }
    return
  }

  if (target.kind === 'toggle') {
    for (const [index, candidate] of rule.equals.entries()) {
      if (typeof candidate !== 'boolean') {
        add(
          'visibility_unsatisfiable',
          `${at}.equals.${index}`,
          `'${rule.field}' is a toggle, so it can only equal true or false.`,
        )
      }
    }
  }
}
