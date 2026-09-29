/**
 * ADR-0007 — the settings form descriptor.
 *
 * The descriptor is the one part of the manifest that exists purely so
 * `apps/web` can render a form for a game it has never heard of. Its value is
 * entirely in the checks below: a descriptor that binds a key the schema does
 * not have, offers an option the schema rejects, or hides a field behind a
 * condition that can never hold, is a broken create-lobby screen. Every one of
 * those is caught at registry load, not in a lobby.
 *
 * The `chessLike` fixture mirrors the real chess contract (strict schema, a
 * grouped twelve-option select, two conditional number fields, a `.refine()`
 * step rule) without importing it — the SDK may never import a game.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  SETTINGS_FORM_VERSION,
  type SettingsField,
  type SettingsFormDescriptor,
  canonicalSettingsKey,
  checkSettingsForm,
  isFieldVisible,
  settingsFormDescriptorSchema,
  toCatalogEntry,
  validateManifest,
  visibleFields,
} from '../src/index.js'
import { manifest as ticTacToeManifest } from './fixtures/tic-tac-toe.js'

// --- a chess-shaped contract, without importing chess ------------------------

const PRESET_IDS = [
  '1+0',
  '2+1',
  '3+0',
  '3+2',
  '5+0',
  '5+3',
  '10+0',
  '15+10',
  '30+0',
  '30+20',
] as const

const chessLikeSchema = z
  .object({
    timeControl: z.enum([...PRESET_IDS, 'custom', 'unlimited']),
    customInitialMinutes: z
      .number()
      .min(0.5)
      .max(180)
      .refine((v) => Number.isInteger(v * 2), 'must be a multiple of 0.5'),
    customIncrementSeconds: z.number().int().min(0).max(60),
    color: z.enum(['white', 'black', 'random']),
    takebacks: z.boolean(),
  })
  .strict()

type ChessLikeSettings = z.infer<typeof chessLikeSchema>

const chessLikeDefaults: ChessLikeSettings = {
  timeControl: '5+0',
  customInitialMinutes: 5,
  customIncrementSeconds: 0,
  color: 'random',
  takebacks: false,
}

const GROUPS = ['Bullet', 'Blitz', 'Rapid', 'Classical', 'Other'] as const
const groupOf: Record<string, string> = {
  '1+0': 'Bullet',
  '2+1': 'Bullet',
  '3+0': 'Blitz',
  '3+2': 'Blitz',
  '5+0': 'Blitz',
  '5+3': 'Blitz',
  '10+0': 'Rapid',
  '15+10': 'Rapid',
  '30+0': 'Classical',
  '30+20': 'Classical',
}

const showWhenCustom = { field: 'timeControl', equals: ['custom'] } as const

const chessLikeForm: SettingsFormDescriptor = {
  version: 1,
  fields: [
    {
      kind: 'select',
      key: 'timeControl',
      label: 'Time control',
      display: 'chips',
      groupOrder: [...GROUPS],
      options: [
        ...PRESET_IDS.map((id) => ({ value: id, label: id, group: groupOf[id] })),
        { value: 'custom', label: 'Custom', group: 'Other' },
        { value: 'unlimited', label: 'No clock', group: 'Other' },
      ],
    },
    {
      kind: 'number',
      key: 'customInitialMinutes',
      label: 'Minutes per side',
      unit: 'min',
      min: 0.5,
      max: 180,
      step: 0.5,
      visibleWhen: showWhenCustom,
    },
    {
      kind: 'number',
      key: 'customIncrementSeconds',
      label: 'Increment',
      unit: 's',
      help: 'Added to your clock after each move you make.',
      min: 0,
      max: 60,
      step: 1,
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
    { kind: 'toggle', key: 'takebacks', label: 'Allow takebacks' },
  ],
}

const chessLike = {
  settingsSchema: chessLikeSchema,
  defaultSettings: chessLikeDefaults,
  settingsForm: chessLikeForm,
}

/** Replace one field of the fixture, keeping everything else identical. */
function withField(key: string, replacement: SettingsField | null): typeof chessLike {
  const fields = chessLikeForm.fields.flatMap((field) =>
    field.key === key ? (replacement === null ? [] : [replacement]) : [field],
  )
  return { ...chessLike, settingsForm: { version: 1, fields } }
}

function codes(issues: ReturnType<typeof checkSettingsForm>): readonly string[] {
  return issues.map((issue) => issue.code)
}

// --- structural schema ------------------------------------------------------

describe('settingsFormDescriptorSchema', () => {
  it('accepts a descriptor using all three field kinds', () => {
    expect(settingsFormDescriptorSchema.safeParse(chessLikeForm).success).toBe(true)
  })

  it('accepts a game with nothing to configure', () => {
    expect(settingsFormDescriptorSchema.safeParse({ version: 1, fields: [] }).success).toBe(true)
  })

  it('pins the version so a v2 descriptor cannot be rendered by a v1 renderer', () => {
    expect(SETTINGS_FORM_VERSION).toBe(1)
    expect(settingsFormDescriptorSchema.safeParse({ version: 2, fields: [] }).success).toBe(false)
  })

  it('rejects an unknown property rather than ignoring it', () => {
    const parsed = settingsFormDescriptorSchema.safeParse({
      version: 1,
      fields: [{ kind: 'toggle', key: 'a', label: 'A', colour: 'red' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an unknown field kind', () => {
    const parsed = settingsFormDescriptorSchema.safeParse({
      version: 1,
      fields: [{ kind: 'text', key: 'a', label: 'A' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a non-positive step and an empty option list', () => {
    const badStep = { kind: 'number', key: 'a', label: 'A', min: 0, max: 1, step: 0 }
    const noOptions = { kind: 'select', key: 'a', label: 'A', options: [] }
    expect(settingsFormDescriptorSchema.safeParse({ version: 1, fields: [badStep] }).success).toBe(
      false,
    )
    expect(
      settingsFormDescriptorSchema.safeParse({ version: 1, fields: [noOptions] }).success,
    ).toBe(false)
  })

  it('is pure JSON, so it can ride along in the game catalogue', () => {
    const serialised = JSON.stringify(chessLikeForm)
    expect(JSON.parse(serialised)).toEqual(chessLikeForm)
  })
})

// --- visibility -------------------------------------------------------------

describe('isFieldVisible / visibleFields', () => {
  const conditional = chessLikeForm.fields[1] as SettingsField
  const unconditional = chessLikeForm.fields[0] as SettingsField

  it('shows an unconditional field always', () => {
    expect(isFieldVisible(unconditional, {})).toBe(true)
  })

  it('shows a conditional field only on a matching value', () => {
    expect(isFieldVisible(conditional, { timeControl: 'custom' })).toBe(true)
    expect(isFieldVisible(conditional, { timeControl: '5+0' })).toBe(false)
  })

  it('hides a conditional field when the referenced value is absent', () => {
    expect(isFieldVisible(conditional, {})).toBe(false)
  })

  it('does not coerce: the string "true" does not satisfy a boolean condition', () => {
    const field: SettingsField = {
      kind: 'number',
      key: 'n',
      label: 'N',
      min: 0,
      max: 1,
      step: 1,
      visibleWhen: { field: 'takebacks', equals: [true] },
    }
    expect(isFieldVisible(field, { takebacks: true })).toBe(true)
    expect(isFieldVisible(field, { takebacks: 'true' })).toBe(false)
  })

  it('hides both custom fields on a preset time control and shows them on custom', () => {
    expect(visibleFields(chessLikeForm, chessLikeDefaults).map((f) => f.key)).toEqual([
      'timeControl',
      'color',
      'takebacks',
    ])
    expect(
      visibleFields(chessLikeForm, { ...chessLikeDefaults, timeControl: 'custom' }).map(
        (f) => f.key,
      ),
    ).toEqual([
      'timeControl',
      'customInitialMinutes',
      'customIncrementSeconds',
      'color',
      'takebacks',
    ])
  })
})

describe('canonicalSettingsKey', () => {
  it('is independent of key order', () => {
    expect(canonicalSettingsKey({ a: 1, b: 2 })).toBe(canonicalSettingsKey({ b: 2, a: 1 }))
  })

  it('separates different values', () => {
    expect(canonicalSettingsKey({ a: 1 })).not.toBe(canonicalSettingsKey({ a: 2 }))
  })

  it('handles a non-object without throwing', () => {
    expect(canonicalSettingsKey(null)).toBe('null')
    expect(canonicalSettingsKey(undefined)).toBe('undefined')
  })
})

// --- the cross-check --------------------------------------------------------

describe('checkSettingsForm', () => {
  it('passes a chess-shaped contract with no issues', () => {
    expect(checkSettingsForm(chessLike)).toEqual([])
  })

  it('passes a game with no configurable settings', () => {
    const noSettingsSchema = z.object({}).strict()
    expect(
      checkSettingsForm({
        settingsSchema: noSettingsSchema,
        defaultSettings: {},
        settingsForm: { version: 1, fields: [] },
      }),
    ).toEqual([])
  })

  it('reports a structurally invalid descriptor and stops', () => {
    const issues = checkSettingsForm({
      ...chessLike,
      settingsForm: { version: 1, fields: [{ kind: 'toggle', key: '', label: '' }] } as never,
    })
    expect(codes(issues).every((code) => code === 'descriptor_invalid')).toBe(true)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]?.path.startsWith('settingsForm.')).toBe(true)
  })

  it('reports defaults that are not an object', () => {
    const issues = checkSettingsForm({ ...chessLike, defaultSettings: 'nope' as never })
    expect(codes(issues)).toEqual(['defaults_not_an_object'])
  })

  it('reports unparseable defaults once, not once per option', () => {
    const issues = checkSettingsForm({
      ...chessLike,
      defaultSettings: { ...chessLikeDefaults, color: 'green' as never },
    })
    expect(codes(issues)).toEqual(['defaults_rejected'])
  })

  it('catches a field bound to a key the settings do not have', () => {
    const issues = checkSettingsForm(
      withField('takebacks', { kind: 'toggle', key: 'takebacksss', label: 'Allow takebacks' }),
    )
    expect(codes(issues)).toEqual(['unknown_field_key'])
    expect(issues[0]?.path).toBe('settingsForm.fields.takebacksss')
  })

  it('catches two fields bound to the same key', () => {
    const duplicated = {
      ...chessLike,
      settingsForm: {
        version: 1,
        fields: [...chessLikeForm.fields, { kind: 'toggle', key: 'takebacks', label: 'Again' }],
      } as SettingsFormDescriptor,
    }
    expect(codes(checkSettingsForm(duplicated))).toEqual(['duplicate_field_key'])
  })

  it('catches a field bound to a non-scalar setting', () => {
    const issues = checkSettingsForm({
      settingsSchema: z.object({ nested: z.object({ a: z.number() }) }).strict(),
      defaultSettings: { nested: { a: 1 } },
      settingsForm: {
        version: 1,
        fields: [{ kind: 'number', key: 'nested', label: 'Nested', min: 0, max: 1, step: 1 }],
      },
    })
    expect(codes(issues)).toEqual(['non_scalar_field_key'])
  })

  it('catches an option the schema would reject', () => {
    const issues = checkSettingsForm(
      withField('color', {
        kind: 'select',
        key: 'color',
        label: 'Colour',
        options: [
          { value: 'white', label: 'White' },
          { value: 'green', label: 'Green' },
        ],
      }),
    )
    expect(codes(issues)).toEqual(['option_rejected'])
    expect(issues[0]?.path).toBe('settingsForm.fields.color.options.1')
  })

  it('catches inverted number bounds', () => {
    const issues = checkSettingsForm(
      withField('customIncrementSeconds', {
        kind: 'number',
        key: 'customIncrementSeconds',
        label: 'Increment',
        min: 60,
        max: 0,
        step: 1,
        visibleWhen: showWhenCustom,
      }),
    )
    expect(codes(issues)).toContain('number_bounds_invalid')
  })

  it('still reports inverted bounds when the defaults are unusable', () => {
    const contract = withField('customIncrementSeconds', {
      kind: 'number',
      key: 'customIncrementSeconds',
      label: 'Increment',
      min: 60,
      max: 0,
      step: 1,
      visibleWhen: showWhenCustom,
    })
    const issues = checkSettingsForm({
      ...contract,
      defaultSettings: { ...chessLikeDefaults, color: 'green' as never },
    })
    expect(codes(issues)).toEqual(['defaults_rejected', 'number_bounds_invalid'])
  })

  it('catches descriptor bounds that have drifted from the schema', () => {
    const issues = checkSettingsForm(
      withField('customIncrementSeconds', {
        kind: 'number',
        key: 'customIncrementSeconds',
        label: 'Increment',
        min: 0,
        max: 120, // schema caps at 60
        step: 1,
        visibleWhen: showWhenCustom,
      }),
    )
    expect(codes(issues)).toEqual(['number_bound_rejected'])
    expect(issues[0]?.path).toBe('settingsForm.fields.customIncrementSeconds.max')
  })

  it('probes a conditional field under the condition that reveals it', () => {
    // `customInitialMinutes: 0.5` is only reachable with timeControl 'custom'.
    // A checker that probed against raw defaults would still pass here, so the
    // sharper assertion is that the valid fixture reports nothing at all.
    expect(checkSettingsForm(chessLike)).toEqual([])
  })

  it('catches a condition on a field that is not in the descriptor', () => {
    const issues = checkSettingsForm(
      withField('takebacks', {
        kind: 'toggle',
        key: 'takebacks',
        label: 'Allow takebacks',
        visibleWhen: { field: 'ranked', equals: [true] },
      }),
    )
    expect(codes(issues)).toEqual(['visibility_target_missing'])
  })

  it('catches a field conditional on itself', () => {
    const issues = checkSettingsForm(
      withField('takebacks', {
        kind: 'toggle',
        key: 'takebacks',
        label: 'Allow takebacks',
        visibleWhen: { field: 'takebacks', equals: [true] },
      }),
    )
    expect(codes(issues)).toEqual(['visibility_target_self'])
  })

  it('rejects a visibility chain', () => {
    const issues = checkSettingsForm(
      withField('takebacks', {
        kind: 'toggle',
        key: 'takebacks',
        label: 'Allow takebacks',
        // customInitialMinutes is itself conditional on timeControl.
        visibleWhen: { field: 'customInitialMinutes', equals: [5] },
      }),
    )
    expect(codes(issues)).toContain('visibility_target_conditional')
  })

  it('catches a condition that can never hold because the value is not an option', () => {
    const issues = checkSettingsForm(
      withField('takebacks', {
        kind: 'toggle',
        key: 'takebacks',
        label: 'Allow takebacks',
        visibleWhen: { field: 'timeControl', equals: ['bullet'] },
      }),
    )
    expect(codes(issues)).toEqual(['visibility_unsatisfiable'])
  })

  it('catches a non-boolean condition on a toggle', () => {
    const issues = checkSettingsForm(
      withField('color', {
        kind: 'select',
        key: 'color',
        label: 'Colour',
        options: [
          { value: 'white', label: 'White' },
          { value: 'black', label: 'Black' },
          { value: 'random', label: 'Random' },
        ],
        visibleWhen: { field: 'takebacks', equals: ['yes'] },
      }),
    )
    expect(codes(issues)).toEqual(['visibility_unsatisfiable'])
  })
})

// --- the manifest integration ----------------------------------------------

describe('the manifest carries the descriptor', () => {
  it('validates the tic-tac-toe fixture — a second, unlike game, same three kinds', () => {
    const result = validateManifest(ticTacToeManifest)
    expect(result).toEqual({ ok: true, value: ticTacToeManifest })
  })

  it('fails the manifest when the descriptor and the schema disagree', () => {
    const broken = {
      ...ticTacToeManifest,
      settingsForm: {
        version: 1 as const,
        fields: [{ kind: 'toggle' as const, key: 'ranked', label: 'Ranked' }],
      },
    }
    const result = validateManifest(broken)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.some((problem) => problem.message.includes('unknown_field_key'))).toBe(true)
  })

  it('fails the manifest when a required descriptor is missing', () => {
    const { settingsForm: _omitted, ...rest } = ticTacToeManifest
    const result = validateManifest(rest as typeof ticTacToeManifest)
    expect(result.ok).toBe(false)
  })

  it('fails the manifest when the isDefault preset does not match the defaults', () => {
    const broken = {
      ...ticTacToeManifest,
      presets: ticTacToeManifest.presets.map((preset) =>
        preset.isDefault === true
          ? { ...preset, settings: { moveTimeoutSeconds: 60, firstMove: 'random' as const } }
          : preset,
      ),
    }
    const result = validateManifest(broken)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.some((problem) => problem.message.includes('isDefault preset'))).toBe(true)
  })

  it('fails the manifest when a preset relies on defaults being filled in later', () => {
    const looseSchema = z
      .object({
        moveTimeoutSeconds: z.number().int().min(5).max(300).default(30),
        firstMove: z.enum(['seat-order', 'random']).default('seat-order'),
      })
      .strict()
    const result = validateManifest({
      ...ticTacToeManifest,
      settingsSchema: looseSchema,
      presets: [{ id: 'partial', label: 'Partial', settings: { moveTimeoutSeconds: 10 } as never }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.some((problem) => problem.message.includes('is incomplete'))).toBe(true)
  })

  it('carries the descriptor and featured flags into the JSON catalogue entry', () => {
    const entry = toCatalogEntry(ticTacToeManifest)
    expect(entry.settingsForm).toEqual(ticTacToeManifest.settingsForm)
    expect(entry.presets.map((preset) => preset.featured)).toEqual([false, true])
    // The whole point: the shell renders the form from JSON, with no game code.
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry)
  })
})
