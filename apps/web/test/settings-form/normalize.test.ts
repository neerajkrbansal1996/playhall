import { describe, expect, it } from 'vitest'

import { describeSkippedField, normalizeSettingsForm } from '@/components/settings-form/normalize'

import { defined } from './defined'
import {
  chessSettingsFormFixture,
  forwardCompatibleFormFixture,
  ticTacToeSettingsFormFixture,
} from './fixtures'

describe('normalizeSettingsForm', () => {
  it('keeps every field of the chess descriptor, in declaration order', () => {
    const { form, skipped, unsupportedVersion } = normalizeSettingsForm(chessSettingsFormFixture)

    expect(unsupportedVersion).toBeNull()
    expect(skipped).toEqual([])
    expect(form.fields.map((field) => field.key)).toEqual([
      'timeControl',
      'customInitialMinutes',
      'customIncrementSeconds',
      'color',
      'takebacks',
      'autoQueen',
    ])
  })

  it('keeps both tic-tac-toe fields', () => {
    const { form, skipped } = normalizeSettingsForm(ticTacToeSettingsFormFixture)

    expect(skipped).toEqual([])
    expect(form.fields.map((field) => field.key)).toEqual(['firstPlayer', 'moveTimeoutSeconds'])
  })

  it('skips an unknown kind and keeps the fields around it', () => {
    const { form, skipped } = normalizeSettingsForm(forwardCompatibleFormFixture)

    expect(form.fields.map((field) => field.key)).toEqual(['friendlyFire', 'rounds'])
    expect(skipped).toEqual([
      { key: 'mapPool', index: 1, kind: 'multiselect', reason: 'unknown_kind' },
    ])
  })

  it('distinguishes an unknown kind from a malformed field of a known kind', () => {
    const { form, skipped } = normalizeSettingsForm({
      version: 1,
      fields: [
        // Known kind, but `min`/`max`/`step` are required.
        { kind: 'number', key: 'rounds', label: 'Rounds' },
        { kind: 'toggle', key: 'ok', label: 'Fine' },
      ],
    })

    expect(form.fields.map((field) => field.key)).toEqual(['ok'])
    expect(skipped[0]).toMatchObject({ key: 'rounds', kind: 'number', reason: 'invalid_field' })
  })

  it('reports a skipped field with no usable key by its index', () => {
    const { skipped } = normalizeSettingsForm({ version: 1, fields: [42] })

    expect(skipped).toEqual([{ key: null, index: 0, kind: null, reason: 'invalid_field' }])
    expect(describeSkippedField(defined(skipped[0]))).toContain('fields[0]')
  })

  it('renders no fields for a descriptor version it was not written against', () => {
    const { form, unsupportedVersion } = normalizeSettingsForm({
      ...chessSettingsFormFixture,
      version: 2,
    })

    // A major bump may have changed what the existing kinds mean, so deferring
    // to `defaultSettings` beats guessing.
    expect(form.fields).toEqual([])
    expect(unsupportedVersion).toBe(2)
  })

  it('survives junk instead of a descriptor', () => {
    for (const junk of [null, undefined, 'nope', 7, [], { version: 1 }, { fields: 'no' }]) {
      const { form, unsupportedVersion } = normalizeSettingsForm(junk)
      expect(form.fields).toEqual([])
      expect(unsupportedVersion).toBeNull()
    }
  })

  it('keeps the first of two fields bound to the same key', () => {
    const { form, skipped } = normalizeSettingsForm({
      version: 1,
      fields: [
        { kind: 'toggle', key: 'dup', label: 'First' },
        { kind: 'toggle', key: 'dup', label: 'Second' },
      ],
    })

    expect(form.fields).toHaveLength(1)
    expect(defined(form.fields[0]).label).toBe('First')
    expect(skipped[0]).toMatchObject({ key: 'dup', reason: 'invalid_field' })
  })

  it('round-trips through JSON without loss, which is what the wire does to it', () => {
    const viaWire = JSON.parse(JSON.stringify(chessSettingsFormFixture))

    expect(normalizeSettingsForm(viaWire).form).toEqual(
      normalizeSettingsForm(chessSettingsFormFixture).form,
    )
  })
})
