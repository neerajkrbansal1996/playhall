/**
 * The `setting-<formFieldKey>` test contract (M2 E2E observable contract §2).
 *
 * The point of these tests is not that chess's six fields have testids today —
 * it is that a field **cannot** be rendered without one. Rev 2 of the contract
 * hand-named four of chess's six settings and silently lost `takebacks` and
 * `autoQueen`; the renderer derives the ids from the descriptor instead, and the
 * coverage test below fails the moment a rendered field has no testid, whatever
 * game or field kind added it.
 *
 * Nothing here imports a game package — the descriptors are the same inert
 * fixtures the rest of the suite uses, for the boundary reason written down in
 * `fixtures.ts`.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { fieldTestAttributes } from '@/components/settings-form/field-shell'

import {
  chessDefaultSettingsFixture,
  chessSettingsFormFixture,
  ticTacToeDefaultSettingsFixture,
  ticTacToeSettingsFormFixture,
} from './fixtures'
import { Harness } from './harness'

/** Every field the renderer drew, as `key -> data-value` (undefined when absent). */
function renderedFields(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const el of document.querySelectorAll('[data-slot="settings-field"]')) {
    const key = el.getAttribute('data-field-key')
    if (key === null) throw new Error('a settings field rendered without data-field-key')
    out[key] = el.getAttribute('data-value') ?? undefined
  }
  return out
}

/** Testids the renderer emitted, in DOM order. */
function renderedTestIds(): string[] {
  return [...document.querySelectorAll('[data-slot="settings-field"]')].map((el) => {
    const id = el.getAttribute('data-testid')
    if (id === null) throw new Error('a settings field rendered without data-testid')
    return id
  })
}

describe('a two-field descriptor', () => {
  it('derives one testid per field, from the descriptor key alone', () => {
    render(
      <Harness
        settingsForm={ticTacToeSettingsFormFixture}
        defaultSettings={ticTacToeDefaultSettingsFixture}
      />,
    )

    // The whole set, not a subset: an extra testid is as much a contract break
    // as a missing one, because a spec would then match two elements.
    expect(renderedTestIds()).toEqual(['setting-firstPlayer', 'setting-moveTimeoutSeconds'])
  })

  it('publishes each committed value as data-value, typed as the player sees it', () => {
    render(
      <Harness
        settingsForm={ticTacToeSettingsFormFixture}
        defaultSettings={ticTacToeDefaultSettingsFixture}
      />,
    )

    expect(renderedFields()).toEqual({
      firstPlayer: 'random',
      // A number arrives as its decimal form, not a token: the proof-selector
      // rule asks a spec to assert `0.5`, not `n:0.5`.
      moveTimeoutSeconds: '30',
    })
  })
})

describe('coverage — a field cannot ship untestable', () => {
  it('gives every rendered field of the chess descriptor a testid', () => {
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
      />,
    )

    const keys = Object.keys(renderedFields())
    expect(keys.length).toBeGreaterThan(0)
    // Derived, so this holds for a seventh field nobody has written yet.
    expect(renderedTestIds()).toEqual(keys.map((key) => `setting-${key}`))
  })

  it('covers the two toggles rev 2 of the contract lost', () => {
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
      />,
    )

    // `takebacks` and `autoQueen` are the reason the naming rule exists. They
    // are also the one kind that opts out of `FieldShell`'s layout, so they are
    // the likeliest field to drift out of the contract.
    expect(screen.getByTestId('setting-takebacks')).toHaveAttribute('data-value', 'false')
    expect(screen.getByTestId('setting-autoQueen')).toHaveAttribute('data-value', 'false')
  })
})

describe('data-value tracks the committed value', () => {
  it('follows a select change, and the fields it reveals arrive with testids', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
      />,
    )

    expect(screen.getByTestId('setting-timeControl')).toHaveAttribute('data-value', '5+0')
    expect(screen.queryByTestId('setting-customInitialMinutes')).toBeNull()

    await user.click(screen.getByRole('radio', { name: 'Custom' }))

    // This is the contract's proof selector: the spec asserts the form reached
    // `custom` before it measures anything downstream of that choice.
    expect(screen.getByTestId('setting-timeControl')).toHaveAttribute('data-value', 'custom')
    expect(screen.getByTestId('setting-customInitialMinutes')).toHaveAttribute('data-value', '5')
    expect(screen.getByTestId('setting-customIncrementSeconds')).toHaveAttribute('data-value', '0')
  })

  it('follows a toggle', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
      />,
    )

    await user.click(screen.getByRole('switch', { name: 'Allow takebacks' }))

    expect(screen.getByTestId('setting-takebacks')).toHaveAttribute('data-value', 'true')
    // The other toggle must not move with it — a shared helper that read the
    // wrong value would still pass a single-field assertion.
    expect(screen.getByTestId('setting-autoQueen')).toHaveAttribute('data-value', 'false')
  })

  it('reports the committed number while a half-typed draft is on screen', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        settingsForm={ticTacToeSettingsFormFixture}
        defaultSettings={ticTacToeDefaultSettingsFixture}
      />,
    )

    const input = screen.getByRole('spinbutton', { name: /Time per move/ })
    await user.clear(input)

    // `NumberField` keeps an unparseable draft on screen without committing it.
    // `data-value` must show what would be *submitted*, otherwise a spec would
    // prove a state the server is never going to be asked for.
    expect(input).toHaveValue(null)
    expect(screen.getByTestId('setting-moveTimeoutSeconds')).toHaveAttribute('data-value', '30')
  })
})

describe('fieldTestAttributes', () => {
  it('omits data-value when the form has no committed value for the field', () => {
    expect(fieldTestAttributes('firstPlayer', undefined)).toEqual({
      'data-testid': 'setting-firstPlayer',
      'data-field-key': 'firstPlayer',
      // Absent, not the string "undefined": React drops an undefined attribute,
      // so `:not([data-value])` is a selector a spec can rely on.
      'data-value': undefined,
    })
  })

  it('serialises each SettingsValue kind', () => {
    expect(fieldTestAttributes('k', 'custom')['data-value']).toBe('custom')
    expect(fieldTestAttributes('k', 0.5)['data-value']).toBe('0.5')
    expect(fieldTestAttributes('k', true)['data-value']).toBe('true')
    expect(fieldTestAttributes('k', false)['data-value']).toBe('false')
    // Not a `SettingsValue`, but `NumberField` can hold one transiently and an
    // attribute reading "NaN" would be a spec that passes on garbage.
    expect(fieldTestAttributes('k', Number.NaN)['data-value']).toBeUndefined()
  })
})
