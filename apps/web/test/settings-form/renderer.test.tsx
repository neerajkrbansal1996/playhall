import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SettingsValues } from '@/components/settings-form/types'

import { defined } from './defined'

import {
  chessDefaultSettingsFixture,
  chessSettingsFormFixture,
  forwardCompatibleDefaultsFixture,
  forwardCompatibleFormFixture,
  numericSelectDefaultsFixture,
  numericSelectFormFixture,
  ticTacToeDefaultSettingsFixture,
  ticTacToeSettingsFormFixture,
} from './fixtures'
import { Harness } from './harness'

/** Last value map the harness rendered with. */
function tracker() {
  const seen: SettingsValues[] = []
  return {
    onValues: (values: SettingsValues) => seen.push(values),
    get last(): SettingsValues {
      return defined(seen.at(-1), 'a rendered value map')
    },
  }
}

afterEach(() => vi.restoreAllMocks())

describe('the chess descriptor', () => {
  it('renders 4 fields at the default and every label from the descriptor', () => {
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
      />,
    )

    // 6 fields declared, 2 conditional on `custom`, so 4 are visible at the
    // default `timeControl: '5+0'` — matching the ADR's measured figure.
    expect(screen.getAllByRole('group').length).toBeGreaterThan(0)
    expect(screen.getByText('Time control')).toBeInTheDocument()
    expect(screen.getByText('Colour')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Allow takebacks' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Auto-promote to queen' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Minutes per side')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Increment')).not.toBeInTheDocument()
  })

  it('draws the 12 time controls as a chip group under their 5 group headings, in order', () => {
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
      />,
    )

    const radios = screen.getAllByRole('radio', { name: /^(\d+\+\d+|Custom|No clock)$/ })
    expect(radios).toHaveLength(12)

    const headings = ['Bullet', 'Blitz', 'Rapid', 'Classical', 'Other']
    const groups = headings.map((heading) => screen.getByRole('group', { name: heading }))
    // 1+0 2+1 | 3+0 3+2 5+0 5+3 | 10+0 10+5 15+10 | 30+0 | Custom No clock
    const perGroup = [2, 4, 3, 1, 2]
    for (const [index, expected] of perGroup.entries()) {
      const group = defined(groups[index], `group ${headings[index]}`)
      expect(within(group).getAllByRole('radio')).toHaveLength(expected)
    }

    // Rendered order, not just membership.
    const rendered = Array.from(document.querySelectorAll('[role="group"]'))
      .map((node) => node.getAttribute('aria-labelledby'))
      .filter((id): id is string => id !== null)
      .map((id) => document.getElementById(id)?.textContent)
    expect(rendered.filter((text) => headings.includes(text ?? ''))).toEqual(headings)
  })

  it('opens with the default time control selected', () => {
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
      />,
    )

    expect(screen.getByRole('radio', { name: '5+0' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '1+0' })).not.toBeChecked()
  })

  it('reveals the two conditional number fields on custom and hides them again', async () => {
    const user = userEvent.setup()
    const seen = tracker()
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
        onValues={seen.onValues}
      />,
    )

    await user.click(screen.getByRole('radio', { name: 'Custom' }))

    const minutes = screen.getByLabelText('Minutes per side')
    const increment = screen.getByLabelText('Increment')
    expect(minutes).toBeInTheDocument()
    expect(increment).toBeInTheDocument()
    // Descriptor affordances reach the DOM; they are not validation.
    expect(minutes).toHaveAttribute('min', '0.5')
    expect(minutes).toHaveAttribute('max', '180')
    expect(minutes).toHaveAttribute('step', '0.5')
    expect(increment).toHaveAttribute('step', '1')
    expect(screen.getByText('min')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'No clock' }))

    expect(screen.queryByLabelText('Minutes per side')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Increment')).not.toBeInTheDocument()
    expect(seen.last.timeControl).toBe('unlimited')
  })

  it('keeps a hidden field’s value so it is still submitted', async () => {
    const user = userEvent.setup()
    const seen = tracker()
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
        onValues={seen.onValues}
      />,
    )

    await user.click(screen.getByRole('radio', { name: 'Custom' }))
    const minutes = screen.getByLabelText('Minutes per side')
    await user.clear(minutes)
    await user.type(minutes, '12')
    expect(seen.last.customInitialMinutes).toBe(12)

    // Hiding the field must not drop the value: ADR-0004 §2 requires the game's
    // schema to accept stale values of hidden fields, so the payload stays total.
    await user.click(screen.getByRole('radio', { name: '5+0' }))
    expect(screen.queryByLabelText('Minutes per side')).not.toBeInTheDocument()
    expect(seen.last).toEqual({
      ...chessDefaultSettingsFixture,
      customInitialMinutes: 12,
    })
  })

  it('toggles a switch through aria-checked, not colour', async () => {
    const user = userEvent.setup()
    const seen = tracker()
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
        onValues={seen.onValues}
      />,
    )

    const takebacks = screen.getByRole('switch', { name: 'Allow takebacks' })
    expect(takebacks).toHaveAttribute('aria-checked', 'false')

    await user.click(takebacks)

    expect(takebacks).toHaveAttribute('aria-checked', 'true')
    expect(seen.last.takebacks).toBe(true)
  })
})

describe('the tic-tac-toe descriptor', () => {
  it('renders both fields with no renderer change', () => {
    render(
      <Harness
        settingsForm={ticTacToeSettingsFormFixture}
        defaultSettings={ticTacToeDefaultSettingsFixture}
      />,
    )

    expect(screen.getByLabelText('Who goes first')).toBeInTheDocument()
    expect(screen.getByLabelText('Time per move')).toBeInTheDocument()
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
  })

  it('renders a select with no display hint as a dropdown, not chips', () => {
    render(
      <Harness
        settingsForm={ticTacToeSettingsFormFixture}
        defaultSettings={ticTacToeDefaultSettingsFixture}
      />,
    )

    const select = screen.getByLabelText('Who goes first')
    expect(select.tagName).toBe('SELECT')
    expect(within(select).getAllByRole('option')).toHaveLength(3)
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
  })

  it('submits the option value the descriptor declared', async () => {
    const user = userEvent.setup()
    const seen = tracker()
    render(
      <Harness
        settingsForm={ticTacToeSettingsFormFixture}
        defaultSettings={ticTacToeDefaultSettingsFixture}
        onValues={seen.onValues}
      />,
    )

    await user.selectOptions(screen.getByLabelText('Who goes first'), [
      screen.getByRole('option', { name: 'Guest' }),
    ])

    expect(seen.last.firstPlayer).toBe('guest')
  })
})

describe('forward compatibility', () => {
  it('skips an unknown kind, warns once in dev, and renders the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen = tracker()

    render(
      <Harness
        settingsForm={forwardCompatibleFormFixture}
        defaultSettings={forwardCompatibleDefaultsFixture}
        onValues={seen.onValues}
      />,
    )

    expect(screen.getByRole('switch', { name: 'Friendly fire' })).toBeInTheDocument()
    expect(screen.getByLabelText('Rounds')).toBeInTheDocument()
    expect(screen.queryByText('Map pool')).not.toBeInTheDocument()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(defined(warn.mock.calls[0])[0]).toContain("unsupported field kind 'multiselect'")

    // The skipped setting keeps its default, so the payload is still complete.
    expect(seen.last.mapPool).toBe('warehouse')
  })

  it('falls back to defaults with no fields on a newer descriptor version', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen = tracker()

    render(
      <Harness
        settingsForm={{ ...chessSettingsFormFixture, version: 99 }}
        defaultSettings={chessDefaultSettingsFixture}
        onValues={seen.onValues}
      />,
    )

    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(seen.last).toEqual(chessDefaultSettingsFixture)
  })
})

describe('numbers and booleans in a descriptor (ADR-0004 §3)', () => {
  it('keeps a numeric option numeric through the DOM round trip', async () => {
    const user = userEvent.setup()
    const seen = tracker()
    render(
      <Harness
        settingsForm={numericSelectFormFixture}
        defaultSettings={numericSelectDefaultsFixture}
        onValues={seen.onValues}
      />,
    )

    expect(screen.getByRole('radio', { name: '8' })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: '12' }))

    // 12, not '12' — the radio's value attribute is a token, not the payload.
    expect(seen.last.playerCount).toBe(12)
    expect(typeof seen.last.playerCount).toBe('number')
  })

  it('evaluates a visibility rule against a toggle', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        settingsForm={numericSelectFormFixture}
        defaultSettings={numericSelectDefaultsFixture}
      />,
    )

    expect(screen.queryByLabelText('Multiplier')).not.toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Damage multiplier' }))
    expect(screen.getByLabelText('Multiplier')).toBeInTheDocument()
  })
})

describe('server-returned errors', () => {
  it('shows each message against its own field and marks that control invalid', () => {
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={{ ...chessDefaultSettingsFixture, timeControl: 'custom' }}
        errors={{
          customInitialMinutes: 'Must be a multiple of 0.5 minutes.',
          takebacks: 'Takebacks are off for rated lobbies.',
        }}
      />,
    )

    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(2)

    const minutesError = alerts.find((alert) =>
      alert.textContent?.includes('multiple of 0.5 minutes'),
    )
    expect(minutesError).toBeDefined()
    const minutes = screen.getByLabelText('Minutes per side')
    expect(minutes).toHaveAttribute('aria-invalid', 'true')
    expect(minutes.getAttribute('aria-describedby')).toContain(minutesError?.id)

    const takebacksError = alerts.find((alert) => alert.textContent?.includes('rated lobbies'))
    expect(takebacksError).toBeDefined()
    const takebacks = screen.getByRole('switch', { name: 'Allow takebacks' })
    expect(takebacks).toHaveAttribute('aria-invalid', 'true')
    expect(takebacks.getAttribute('aria-describedby')).toContain(takebacksError?.id)

    // A field with no error is not marked invalid.
    expect(screen.getByLabelText('Increment')).not.toHaveAttribute('aria-invalid')
  })

  it('does not invent an error of its own when a value is outside min/max', async () => {
    const user = userEvent.setup()
    const seen = tracker()
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={{ ...chessDefaultSettingsFixture, timeControl: 'custom' }}
        onValues={seen.onValues}
      />,
    )

    const minutes = screen.getByLabelText('Minutes per side')
    await user.clear(minutes)
    await user.type(minutes, '999')

    // The server is the authority (ADR-0004 §2): the out-of-range value is kept
    // and submitted, not clamped to 180 and not rejected locally.
    expect(seen.last.customInitialMinutes).toBe(999)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('never stores NaN from a half-typed number', async () => {
    const user = userEvent.setup()
    const seen = tracker()
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={{ ...chessDefaultSettingsFixture, timeControl: 'custom' }}
        onValues={seen.onValues}
      />,
    )

    await user.clear(screen.getByLabelText('Minutes per side'))

    expect(seen.last.customInitialMinutes).toBe(5)
    expect(Number.isNaN(seen.last.customInitialMinutes)).toBe(false)
  })
})

describe('disabled', () => {
  it('disables every control for a non-host', () => {
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
        disabled
      />,
    )

    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
    for (const toggle of screen.getAllByRole('switch')) expect(toggle).toBeDisabled()
  })
})

describe('no game knowledge', () => {
  it('renders a descriptor for a game that does not exist', () => {
    // The renderer has never heard of this "game". If it needed a registry entry,
    // a slug or an id, this would fail — which is the whole point of the
    // descriptor being data (principle 1, ADR-0004).
    render(
      <Harness
        settingsForm={{
          version: 1,
          fields: [{ kind: 'toggle', key: 'nonsense', label: 'Invented on the spot' }],
        }}
        defaultSettings={{ nonsense: true }}
      />,
    )

    expect(screen.getByRole('switch', { name: 'Invented on the spot' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })
})
