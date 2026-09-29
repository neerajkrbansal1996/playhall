import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { PresetQuickStart } from '@/components/settings-form/preset-quick-start'
import { featuredPresets, presetMatching } from '@/components/settings-form/presets'
import type { SettingsFormPreset } from '@/components/settings-form/types'

import { defined } from './defined'
import {
  chessDefaultSettingsFixture,
  chessPresetsFixture,
  chessSettingsFormFixture,
} from './fixtures'
import { Harness } from './harness'

const presets = chessPresetsFixture as readonly SettingsFormPreset[]

describe('the quick-start row', () => {
  it('offers exactly the featured presets', () => {
    render(
      <PresetQuickStart
        presets={presets}
        defaults={chessDefaultSettingsFixture}
        onQuickStart={() => {}}
      />,
    )

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(4)
    expect(buttons.map((button) => button.textContent)).toEqual([
      expect.stringContaining('Blitz 3+2'),
      expect.stringContaining('Blitz 5+0'),
      expect.stringContaining('Rapid 10+0'),
      expect.stringContaining('No clock'),
    ])
    expect(screen.queryByRole('button', { name: /Bullet/ })).not.toBeInTheDocument()
  })

  it('creates a lobby in one tap, with settings complete', async () => {
    const user = userEvent.setup()
    const onQuickStart = vi.fn()
    render(
      <PresetQuickStart
        presets={presets}
        defaults={chessDefaultSettingsFixture}
        onQuickStart={onQuickStart}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Rapid 10\+0/ }))

    // One call, one tap, and a payload with nothing left to fill in — this is the
    // "<= 2 taps to a playable lobby" claim, asserted.
    expect(onQuickStart).toHaveBeenCalledTimes(1)
    const [settings, preset] = defined(onQuickStart.mock.calls[0], 'the quick-start call')
    expect(settings).toEqual({ ...chessDefaultSettingsFixture, timeControl: '10+0' })
    expect(preset.id).toBe('rapid-10-0')
  })

  it('renders nothing when no preset is featured', () => {
    const { container } = render(
      <PresetQuickStart
        presets={presets.map((preset) => ({ ...preset, featured: false }))}
        defaults={chessDefaultSettingsFixture}
        onQuickStart={() => {}}
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('locks the row and marks the tapped preset busy while a create is in flight', () => {
    render(
      <PresetQuickStart
        presets={presets}
        defaults={chessDefaultSettingsFixture}
        onQuickStart={() => {}}
        pendingPresetId="blitz-5-0"
      />,
    )

    expect(screen.getByRole('button', { name: /Blitz 5\+0/ })).toHaveAttribute('aria-busy', 'true')
    // Every button locks, so a double tap cannot open two lobbies.
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
  })

  it('has an accessible name for the row itself', () => {
    render(
      <PresetQuickStart
        presets={presets}
        defaults={chessDefaultSettingsFixture}
        onQuickStart={() => {}}
      />,
    )

    expect(screen.getByRole('region', { name: 'Quick start' })).toBeInTheDocument()
  })
})

describe('presets inside the form', () => {
  it('opens on the isDefault preset', () => {
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
        presets={presets}
      />,
    )

    expect(screen.getByRole('button', { name: /Blitz 5\+0/, pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Bullet/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('applies a preset to the fields', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
        presets={presets}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Bullet/ }))

    expect(screen.getByRole('radio', { name: '1+0' })).toBeChecked()
    expect(screen.getByRole('button', { name: /Bullet/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('deselects every preset once a field is edited away from one', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        settingsForm={chessSettingsFormFixture}
        defaultSettings={chessDefaultSettingsFixture}
        presets={presets}
      />,
    )

    await user.click(screen.getByRole('switch', { name: 'Allow takebacks' }))

    // No chess preset enables takebacks, so nothing is "the preset" any more.
    for (const preset of presets) {
      expect(
        screen.getByRole('button', { name: new RegExp(preset.label.replace('+', '\\+')) }),
      ).toHaveAttribute('aria-pressed', 'false')
    }
  })
})

describe('preset helpers', () => {
  it('matches a preset regardless of key order', () => {
    const reordered = {
      autoQueen: false,
      takebacks: false,
      color: 'random',
      customIncrementSeconds: 0,
      customInitialMinutes: 5,
      timeControl: '1+0',
    }

    expect(presetMatching(presets, reordered, chessDefaultSettingsFixture)?.id).toBe('bullet-1-0')
  })

  it('matches a preset that names only the key it changes', () => {
    const sparse: readonly SettingsFormPreset[] = [
      { id: 'sparse', label: 'Sparse', settings: { timeControl: '3+0' } },
    ]

    expect(
      presetMatching(
        sparse,
        { ...chessDefaultSettingsFixture, timeControl: '3+0' },
        chessDefaultSettingsFixture,
      )?.id,
    ).toBe('sparse')
  })

  it('returns undefined for settings no preset describes', () => {
    expect(
      presetMatching(
        presets,
        { ...chessDefaultSettingsFixture, takebacks: true },
        chessDefaultSettingsFixture,
      ),
    ).toBeUndefined()
  })

  it('counts 4 of chess’s 6 presets as featured', () => {
    expect(featuredPresets(presets)).toHaveLength(4)
    expect(presets).toHaveLength(6)
  })
})
