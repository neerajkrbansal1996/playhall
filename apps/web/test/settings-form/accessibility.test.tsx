import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import {
  chessDefaultSettingsFixture,
  chessSettingsFormFixture,
  ticTacToeDefaultSettingsFixture,
  ticTacToeSettingsFormFixture,
} from './fixtures'
import { Harness } from './harness'

function renderChess() {
  return render(
    <Harness
      settingsForm={chessSettingsFormFixture}
      defaultSettings={chessDefaultSettingsFixture}
    />,
  )
}

describe('the chip group is a real radio group', () => {
  it('labels the group with the field label via a legend', () => {
    renderChess()

    const fieldset = document.querySelector('fieldset[data-field-key="timeControl"]')
    expect(fieldset).not.toBeNull()
    expect(fieldset?.querySelector('legend')?.textContent).toBe('Time control')
  })

  it('puts every chip in one named group, so it is one choice and not twelve', () => {
    renderChess()

    const names = new Set(
      screen
        .getAllByRole('radio', { name: /^(\d+\+\d+|Custom|No clock)$/ })
        .map((radio) => radio.getAttribute('name')),
    )

    expect(names.size).toBe(1)
  })

  it('gives the whole group one tab stop, landing on the checked chip', async () => {
    const user = userEvent.setup()
    renderChess()

    await user.tab()

    // Native radio semantics: the checked radio is the group's tab stop, and the
    // other eleven are skipped. That behaviour is why these are real inputs
    // rather than a hand-rolled roving-tabindex widget.
    expect(screen.getByRole('radio', { name: '5+0' })).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('radio', { name: '5+0' })).not.toHaveFocus()
  })

  it('moves and selects with the arrow keys', async () => {
    const user = userEvent.setup()
    renderChess()

    await user.tab()
    expect(screen.getByRole('radio', { name: '5+0' })).toHaveFocus()

    await user.keyboard('{ArrowRight}')

    const next = screen.getByRole('radio', { name: '5+3' })
    expect(next).toHaveFocus()
    expect(next).toBeChecked()

    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('radio', { name: '5+0' })).toBeChecked()
  })

  it('names each option from the descriptor label, not its value', () => {
    renderChess()

    // 'No clock', not 'unlimited'.
    expect(screen.getByRole('radio', { name: 'No clock' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'unlimited' })).not.toBeInTheDocument()
  })

  it('exposes group headings as named groups a screen reader can announce', () => {
    renderChess()

    for (const heading of ['Bullet', 'Blitz', 'Rapid', 'Classical', 'Other']) {
      expect(screen.getByRole('group', { name: heading })).toBeInTheDocument()
    }
  })

  it('keeps the chip visible to a pointer while the input carries the semantics', () => {
    renderChess()

    const radio = screen.getByRole('radio', { name: '5+0' })
    // sr-only, not display:none or hidden — a hidden input is not focusable and
    // would take the group out of the keyboard order entirely.
    expect(radio).toHaveClass('sr-only')
    expect(radio).not.toHaveAttribute('hidden')
    expect(document.querySelector(`label[for="${radio.id}"]`)).not.toBeNull()
  })
})

describe('help text is wired with aria-describedby', () => {
  it('describes a toggle with its help string', () => {
    renderChess()

    const takebacks = screen.getByRole('switch', { name: 'Allow takebacks' })
    const describedBy = takebacks.getAttribute('aria-describedby')

    expect(describedBy).not.toBeNull()
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      'Your opponent can ask to take back their last move.',
    )
  })

  it('describes a number field with its help and its unit', async () => {
    const user = userEvent.setup()
    renderChess()
    await user.click(screen.getByRole('radio', { name: 'Custom' }))

    const increment = screen.getByLabelText('Increment')
    const ids = (increment.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
    const described = ids.map((id) => document.getElementById(id)?.textContent)

    expect(described).toContain('Added to your clock after each move you make.')
    // The unit is part of the question, so it is described rather than decorative.
    expect(described).toContain('s')
  })

  it('adds no aria-describedby to a field with no help and no error', () => {
    render(
      <Harness
        settingsForm={ticTacToeSettingsFormFixture}
        defaultSettings={ticTacToeDefaultSettingsFixture}
      />,
    )

    expect(screen.getByLabelText('Who goes first')).not.toHaveAttribute('aria-describedby')
  })
})

describe('every control is reachable and named', () => {
  it('gives each visible field an accessible name and a keyboard path', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        settingsForm={ticTacToeSettingsFormFixture}
        defaultSettings={ticTacToeDefaultSettingsFixture}
      />,
    )

    await user.tab()
    expect(screen.getByLabelText('Who goes first')).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('Time per move')).toHaveFocus()
  })

  it('toggles a switch with the keyboard', async () => {
    const user = userEvent.setup()
    renderChess()

    const takebacks = screen.getByRole('switch', { name: 'Allow takebacks' })
    takebacks.focus()
    await user.keyboard(' ')

    expect(takebacks).toHaveAttribute('aria-checked', 'true')
  })

  it('announces a server error through role="alert"', () => {
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
        errors={{ timeControl: 'That time control is off for this room.' }}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('That time control is off for this room.')
  })
})
