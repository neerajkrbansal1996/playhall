import type { SelectField } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'

import { groupOptions, optionForToken, optionToken } from '@/components/settings-form/grouping'

import { defined } from './defined'

function selectField(partial: Omit<SelectField, 'kind' | 'key' | 'label'>): SelectField {
  return { kind: 'select', key: 'field', label: 'Field', ...partial }
}

describe('groupOptions', () => {
  it('orders groups by groupOrder', () => {
    const groups = groupOptions(
      selectField({
        options: [
          { value: 'a', label: 'A', group: 'Second' },
          { value: 'b', label: 'B', group: 'First' },
        ],
        groupOrder: ['First', 'Second'],
      }),
    )

    expect(groups.map((group) => group.group)).toEqual(['First', 'Second'])
    expect(defined(groups[0]).options.map((option) => option.value)).toEqual(['b'])
  })

  it('puts a group missing from groupOrder last, in first-appearance order', () => {
    const groups = groupOptions(
      selectField({
        options: [
          { value: 'a', label: 'A', group: 'Zulu' },
          { value: 'b', label: 'B', group: 'Listed' },
          { value: 'c', label: 'C', group: 'Alpha' },
        ],
        groupOrder: ['Listed'],
      }),
    )

    // Not alphabetical, and not declaration order overall: listed first, then the
    // unlisted groups in the order their first option appeared.
    expect(groups.map((group) => group.group)).toEqual(['Listed', 'Zulu', 'Alpha'])
  })

  it('ignores a groupOrder entry no option uses rather than drawing an empty heading', () => {
    const groups = groupOptions(
      selectField({
        options: [{ value: 'a', label: 'A', group: 'Real' }],
        groupOrder: ['Ghost', 'Real'],
      }),
    )

    expect(groups.map((group) => group.group)).toEqual(['Real'])
  })

  it('collapses to a single ungrouped bucket when no option has a group', () => {
    const groups = groupOptions(
      selectField({
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      }),
    )

    expect(groups).toEqual([
      {
        group: null,
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
    ])
  })

  it('groups the chess time controls the way the descriptor asks', () => {
    const groups = groupOptions(
      selectField({
        options: [
          { value: '1+0', label: '1+0', group: 'Bullet' },
          { value: '3+0', label: '3+0', group: 'Blitz' },
          { value: 'custom', label: 'Custom', group: 'Other' },
          { value: '10+0', label: '10+0', group: 'Rapid' },
          { value: '30+0', label: '30+0', group: 'Classical' },
        ],
        groupOrder: ['Bullet', 'Blitz', 'Rapid', 'Classical', 'Other'],
      }),
    )

    expect(groups.map((group) => group.group)).toEqual([
      'Bullet',
      'Blitz',
      'Rapid',
      'Classical',
      'Other',
    ])
  })
})

describe('optionToken', () => {
  it('keeps the number 5 and the string "5" apart', () => {
    // Without the type prefix these collide in one radio group and the wrong
    // value is submitted.
    expect(optionToken(5)).not.toBe(optionToken('5'))
  })

  it('resolves a token back to the option with its declared type intact', () => {
    const field = selectField({
      options: [
        { value: 4, label: 'Four' },
        { value: '4', label: 'Four, as text' },
      ],
    })

    expect(optionForToken(field, optionToken(4))?.value).toBe(4)
    expect(optionForToken(field, optionToken('4'))?.value).toBe('4')
    expect(optionForToken(field, 'not-a-token')).toBeUndefined()
  })
})
