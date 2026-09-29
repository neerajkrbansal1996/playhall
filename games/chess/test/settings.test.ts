import { describe, expect, it } from 'vitest'

import { asSeatId } from '../src/sdk/contract.js'
import {
  CHESS_SETTINGS_DEFAULTS,
  CHESS_SETTINGS_KEYS,
  CHESS_SETTINGS_PRESETS,
  CUSTOM_INCREMENT_SECONDS,
  CUSTOM_INITIAL_MINUTES,
  TIME_CONTROL_PRESETS,
  TIME_CONTROL_PRESET_IDS,
  categoryFor,
  chessSettingsForm,
  chessSettingsSchema,
  defaultChessSettings,
  describeTimeControl,
  featuredChessSettingsPresets,
  formFieldKeys,
  getChessSettingsPreset,
  getTimeControlPreset,
  isTimeControlPresetId,
  hasClock,
  assignColors,
  resolveHostColor,
  resolveTimeControl,
  type ChessSettings,
} from '../src/settings/index.js'

/** Parse a partial settings object, filling the rest from defaults. */
function parse(input: unknown): ChessSettings {
  return chessSettingsSchema.parse(input)
}

function settings(overrides: Partial<ChessSettings> = {}): ChessSettings {
  return parse(overrides)
}

describe('time control presets', () => {
  it('offers exactly the ten presets the spec lists, in order', () => {
    expect(TIME_CONTROL_PRESET_IDS).toEqual([
      '1+0',
      '2+1',
      '3+0',
      '3+2',
      '5+0',
      '5+3',
      '10+0',
      '10+5',
      '15+10',
      '30+0',
    ])
  })

  it.each([
    ['1+0', 1, 0],
    ['2+1', 2, 1],
    ['3+0', 3, 0],
    ['3+2', 3, 2],
    ['5+0', 5, 0],
    ['5+3', 5, 3],
    ['10+0', 10, 0],
    ['10+5', 10, 5],
    ['15+10', 15, 10],
    ['30+0', 30, 0],
  ])('parses %s as %i minutes + %i seconds', (id, minutes, increment) => {
    const preset = TIME_CONTROL_PRESETS.find((p) => p.id === id)
    expect(preset).toBeDefined()
    expect(preset?.initialMinutes).toBe(minutes)
    expect(preset?.incrementSeconds).toBe(increment)
  })

  it.each([
    ['1+0', 'bullet'],
    ['2+1', 'bullet'],
    ['3+0', 'blitz'],
    ['3+2', 'blitz'],
    ['5+0', 'blitz'],
    ['5+3', 'blitz'],
    ['10+0', 'rapid'],
    ['10+5', 'rapid'],
    ['15+10', 'rapid'],
    ['30+0', 'classical'],
  ])('categorises %s as %s', (id, category) => {
    expect(TIME_CONTROL_PRESETS.find((p) => p.id === id)?.category).toBe(category)
  })

  it('recognises preset ids and rejects anything else', () => {
    expect(isTimeControlPresetId('3+2')).toBe(true)
    expect(isTimeControlPresetId('7+7')).toBe(false)
    expect(isTimeControlPresetId('custom')).toBe(false)
    expect(isTimeControlPresetId(undefined)).toBe(false)
    expect(isTimeControlPresetId(32)).toBe(false)
  })

  it('throws rather than guessing when handed an id that skipped the schema', () => {
    expect(() =>
      getTimeControlPreset('7+7' as unknown as (typeof TIME_CONTROL_PRESET_IDS)[number]),
    ).toThrow(/Unknown chess time control preset/)
  })

  it('categorises a custom control with the same base + 40 x increment rule', () => {
    // 2+1 is 160s (bullet) but 2+2 is 200s (blitz) — the boundary is real.
    expect(categoryFor(2, 1)).toBe('bullet')
    expect(categoryFor(2, 2)).toBe('blitz')
    expect(categoryFor(0.5, 0)).toBe('bullet')
    expect(categoryFor(180, 60)).toBe('classical')
  })
})

describe('defaults', () => {
  it('parses an empty object into a complete settings object', () => {
    expect(defaultChessSettings()).toEqual({
      timeControl: '5+0',
      customInitialMinutes: 5,
      customIncrementSeconds: 0,
      color: 'random',
      takebacks: false,
      autoQueen: false,
    })
  })

  it('defaults takebacks to off, as the spec requires', () => {
    expect(defaultChessSettings().takebacks).toBe(false)
    expect(CHESS_SETTINGS_DEFAULTS.takebacks).toBe(false)
  })

  it('defaults to showing the promotion picker so under-promotion stays possible', () => {
    expect(defaultChessSettings().autoQueen).toBe(false)
  })
})

describe('schema rejects invalid input', () => {
  it('rejects an unknown time control', () => {
    expect(() => parse({ timeControl: '7+7' })).toThrow()
    expect(() => parse({ timeControl: 'blitz' })).toThrow()
  })

  it('rejects an unknown colour', () => {
    expect(() => parse({ color: 'green' })).toThrow()
  })

  it('rejects unknown keys — a modified client is not forward compatible', () => {
    expect(() => parse({ timeControl: '5+0', ratingFloor: 1500 })).toThrow()
  })

  it('rejects non-boolean takebacks and autoQueen', () => {
    expect(() => parse({ takebacks: 'yes' })).toThrow()
    expect(() => parse({ autoQueen: 1 })).toThrow()
  })
})

describe('custom time control bounds', () => {
  const custom = (customInitialMinutes: unknown, customIncrementSeconds: unknown) => () =>
    parse({ timeControl: 'custom', customInitialMinutes, customIncrementSeconds })

  it('accepts the exact lower and upper bounds', () => {
    expect(custom(CUSTOM_INITIAL_MINUTES.min, CUSTOM_INCREMENT_SECONDS.min)()).toMatchObject({
      customInitialMinutes: 0.5,
      customIncrementSeconds: 0,
    })
    expect(custom(CUSTOM_INITIAL_MINUTES.max, CUSTOM_INCREMENT_SECONDS.max)()).toMatchObject({
      customInitialMinutes: 180,
      customIncrementSeconds: 60,
    })
  })

  it.each([0.25, 0.4, 0, -5, 180.5, 181, 1000])('rejects %p minutes', (minutes) => {
    expect(custom(minutes, 0)).toThrow()
  })

  it.each([1.3, 2.75, 10.1])('rejects %p minutes (not a half-minute step)', (minutes) => {
    expect(custom(minutes, 0)).toThrow()
  })

  it.each([0.5, 1, 1.5, 2, 90, 179.5, 180])('accepts %p minutes', (minutes) => {
    expect(custom(minutes, 0)).not.toThrow()
  })

  it.each([-1, 61, 100, 1.5, 0.5])('rejects %p seconds of increment', (inc) => {
    expect(custom(5, inc)).toThrow()
  })

  it.each([0, 1, 30, 59, 60])('accepts %p seconds of increment', (inc) => {
    expect(custom(5, inc)).not.toThrow()
  })

  it.each([NaN, Infinity, -Infinity, '5', null])('rejects %p as a minute value', (minutes) => {
    expect(custom(minutes, 0)).toThrow()
  })
})

describe('resolveTimeControl', () => {
  it.each([
    ['1+0', 60_000, 0],
    ['2+1', 120_000, 1_000],
    ['3+2', 180_000, 2_000],
    ['5+3', 300_000, 3_000],
    ['10+5', 600_000, 5_000],
    ['15+10', 900_000, 10_000],
    ['30+0', 1_800_000, 0],
  ])('resolves %s to %i ms + %i ms', (timeControl, initialMs, incrementMs) => {
    expect(resolveTimeControl(settings({ timeControl } as Partial<ChessSettings>))).toEqual({
      initialMs,
      incrementMs,
    })
  })

  it('resolves a custom control from its own fields', () => {
    expect(
      resolveTimeControl(
        settings({
          timeControl: 'custom',
          customInitialMinutes: 0.5,
          customIncrementSeconds: 7,
        }),
      ),
    ).toEqual({ initialMs: 30_000, incrementMs: 7_000 })
  })

  it('returns null for "No clock" rather than a very large number', () => {
    const unlimited = settings({ timeControl: 'unlimited' })
    expect(resolveTimeControl(unlimited)).toBeNull()
    expect(hasClock(unlimited)).toBe(false)
  })

  it('ignores the custom fields when a preset is selected', () => {
    const s = settings({
      timeControl: '3+2',
      customInitialMinutes: 180,
      customIncrementSeconds: 60,
    })
    expect(resolveTimeControl(s)).toEqual({ initialMs: 180_000, incrementMs: 2_000 })
  })

  it('produces whole milliseconds for every reachable custom value', () => {
    for (let minutes = 0.5; minutes <= 180; minutes += 0.5) {
      const ms = resolveTimeControl(
        settings({ timeControl: 'custom', customInitialMinutes: minutes }),
      )?.initialMs
      expect(Number.isInteger(ms)).toBe(true)
    }
  })
})

describe('describeTimeControl', () => {
  it('describes presets, custom values, and no clock', () => {
    expect(describeTimeControl(settings({ timeControl: '15+10' }))).toBe('15+10')
    expect(
      describeTimeControl(
        settings({
          timeControl: 'custom',
          customInitialMinutes: 0.5,
          customIncrementSeconds: 2,
        }),
      ),
    ).toBe('0.5+2')
    expect(describeTimeControl(settings({ timeControl: 'unlimited' }))).toBe('No clock')
  })
})

describe('colour assignment', () => {
  const explodingRng = () => {
    throw new Error('rng must not be used for an explicit colour')
  }

  it('honours an explicit colour choice and never touches the rng', () => {
    expect(resolveHostColor('white', explodingRng)).toBe('w')
    expect(resolveHostColor('black', explodingRng)).toBe('b')
  })

  it('resolves random from the seeded rng, both ways', () => {
    expect(resolveHostColor('random', () => 0)).toBe('w')
    expect(resolveHostColor('random', () => 0.499)).toBe('w')
    expect(resolveHostColor('random', () => 0.5)).toBe('b')
    expect(resolveHostColor('random', () => 0.999)).toBe('b')
  })

  it('seats the host and guest on opposite colours', () => {
    expect(
      assignColors('white', asSeatId('seat-host'), asSeatId('seat-guest'), explodingRng),
    ).toEqual({
      w: asSeatId('seat-host'),
      b: asSeatId('seat-guest'),
    })
    expect(
      assignColors('black', asSeatId('seat-host'), asSeatId('seat-guest'), explodingRng),
    ).toEqual({
      w: asSeatId('seat-guest'),
      b: asSeatId('seat-host'),
    })
    expect(
      assignColors('random', asSeatId('seat-host'), asSeatId('seat-guest'), () => 0.9),
    ).toEqual({
      w: asSeatId('seat-guest'),
      b: asSeatId('seat-host'),
    })
  })

  it('is deterministic for a given seed sequence — a replay cannot diverge', () => {
    const sequence = [0.1, 0.9, 0.4, 0.6]
    const run = () => {
      let i = 0
      const rng = () => sequence[i++]!
      return sequence.map(() => resolveHostColor('random', rng))
    }
    expect(run()).toEqual(run())
    expect(run()).toEqual(['w', 'b', 'w', 'b'])
  })
})

describe('lobby presets', () => {
  it('every preset parses against the schema', () => {
    for (const preset of CHESS_SETTINGS_PRESETS) {
      expect(() => chessSettingsSchema.parse(preset.settings)).not.toThrow()
    }
  })

  it('has unique ids and can look them up', () => {
    const ids = CHESS_SETTINGS_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(getChessSettingsPreset('blitz-3-2')?.settings.timeControl).toBe('3+2')
    expect(getChessSettingsPreset('nope')).toBeUndefined()
  })

  it('offers a small featured set for the quick-start row', () => {
    const featured = featuredChessSettingsPresets()
    expect(featured.length).toBeGreaterThan(0)
    expect(featured.length).toBeLessThanOrEqual(4)
  })

  it('keeps the spec defaults (takebacks off) in every preset', () => {
    for (const preset of CHESS_SETTINGS_PRESETS) {
      expect(preset.settings.takebacks).toBe(false)
    }
  })
})

describe('form descriptor', () => {
  it('binds every field to a real settings key', () => {
    for (const key of formFieldKeys()) {
      expect(CHESS_SETTINGS_KEYS).toContain(key)
    }
  })

  it('renders a control for every settings key — nothing is unreachable', () => {
    const keys = formFieldKeys()
    for (const key of CHESS_SETTINGS_KEYS) {
      expect(keys).toContain(key)
    }
  })

  it('offers every time control the schema accepts, and nothing it does not', () => {
    const field = chessSettingsForm.fields.find((f) => f.key === 'timeControl')
    expect(field?.kind).toBe('select')
    const values = field?.kind === 'select' ? field.options.map((o) => o.value) : []
    expect(values).toEqual([...TIME_CONTROL_PRESET_IDS, 'custom', 'unlimited'])
    for (const value of values) {
      expect(() => parse({ timeControl: value })).not.toThrow()
    }
  })

  it('offers every colour the schema accepts', () => {
    const field = chessSettingsForm.fields.find((f) => f.key === 'color')
    const values = field?.kind === 'select' ? field.options.map((o) => o.value) : []
    expect(values).toEqual(['white', 'black', 'random'])
  })

  it('hides the custom number fields unless custom is selected', () => {
    for (const key of ['customInitialMinutes', 'customIncrementSeconds']) {
      const field = chessSettingsForm.fields.find((f) => f.key === key)
      expect(field?.visibleWhen).toEqual({ field: 'timeControl', equals: ['custom'] })
    }
  })

  it('states number bounds that match the schema exactly', () => {
    const minutes = chessSettingsForm.fields.find((f) => f.key === 'customInitialMinutes')
    expect(minutes?.kind).toBe('number')
    if (minutes?.kind === 'number') {
      expect(minutes.min).toBe(CUSTOM_INITIAL_MINUTES.min)
      expect(minutes.max).toBe(CUSTOM_INITIAL_MINUTES.max)
      expect(minutes.step).toBe(CUSTOM_INITIAL_MINUTES.step)
    }

    const increment = chessSettingsForm.fields.find((f) => f.key === 'customIncrementSeconds')
    if (increment?.kind === 'number') {
      expect(increment.min).toBe(CUSTOM_INCREMENT_SECONDS.min)
      expect(increment.max).toBe(CUSTOM_INCREMENT_SECONDS.max)
      expect(increment.step).toBe(CUSTOM_INCREMENT_SECONDS.step)
    }
  })

  it('references only field kinds a generic renderer understands', () => {
    for (const field of chessSettingsForm.fields) {
      expect(['select', 'number', 'toggle']).toContain(field.kind)
    }
  })

  it('declares a group order that covers every option group', () => {
    const field = chessSettingsForm.fields.find((f) => f.key === 'timeControl')
    if (field?.kind !== 'select') throw new Error('expected a select field')
    const groups = new Set(field.options.map((o) => o.group).filter(Boolean))
    for (const group of groups) {
      expect(field.groupOrder).toContain(group)
    }
  })
})
