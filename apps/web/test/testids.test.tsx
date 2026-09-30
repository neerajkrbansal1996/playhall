/**
 * The platform `data-testid` registry, pinned against the M2 E2E observable
 * contract §2.
 *
 * These assertions look tautological — `testIds.roomCode === 'room-code'` — and
 * they are meant to. The contract says renaming a testid is a breaking change,
 * so the literal strings need a place where changing one fails a test rather
 * than silently un-matching a spec that is not in this repo yet. That is what
 * this file is: the diff that makes a rename visible in review.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { CreateLobbyPreview } from '@/app/dev/settings-form/create-lobby-preview'
import { normalizeSettingsForm } from '@/components/settings-form/normalize'
import { seatTestAttributes, seatTestId, testIds } from '@/lib/testids'

import {
  chessDefaultSettingsFixture,
  chessPresetsFixture,
  chessSettingsFormFixture,
} from './settings-form/fixtures'

describe('the platform testid registry', () => {
  it('matches the names the contract fixed', () => {
    expect(testIds).toEqual({
      createLobbyForm: 'create-lobby-form',
      createLobbySubmit: 'create-lobby-submit',
      roomCode: 'room-code',
      roomLink: 'room-link',
      copyRoomLink: 'copy-room-link',
      joinCodeInput: 'join-code-input',
      joinSubmit: 'join-submit',
      spectatorCount: 'spectator-count',
    })
  })

  it('names no game-specific selector', () => {
    // `chess-board`, `sq-e4` and the rest belong to `games/chess`. A game name
    // reaching `apps/web` breaks principle 1 before it breaks the boundary rule.
    for (const id of Object.values(testIds)) {
      expect(id).not.toMatch(/chess|board|\bsq-/)
    }
  })

  it('derives a seat testid from the platform seat id, not a colour union', () => {
    expect(seatTestId('w')).toBe('seat-w')
    expect(seatTestId('b')).toBe('seat-b')
    // A four-seat game gets working selectors from the same helper.
    expect(seatTestId('p3')).toBe('seat-p3')
  })

  it('always writes data-connected, in both states', () => {
    // Omitting it when false would make "disconnected" and "not rendered yet"
    // indistinguishable to a presence spec.
    expect(seatTestAttributes('w', true)).toEqual({
      'data-testid': 'seat-w',
      'data-connected': 'true',
    })
    expect(seatTestAttributes('b', false)).toEqual({
      'data-testid': 'seat-b',
      'data-connected': 'false',
    })
  })
})

describe('the create-lobby surface', () => {
  function renderPreview() {
    const normalized = normalizeSettingsForm(chessSettingsFormFixture)
    return render(
      <CreateLobbyPreview
        gameName="chess"
        form={normalized.form}
        defaultSettings={chessDefaultSettingsFixture}
        presets={chessPresetsFixture}
      />,
    )
  }

  it('carries the form and submit testids', () => {
    renderPreview()
    expect(screen.getByTestId(testIds.createLobbyForm)).toBeInTheDocument()
    expect(screen.getByTestId(testIds.createLobbySubmit)).toBeInTheDocument()
  })

  it('nests the settings fields inside the form, so a spec can scope to it', () => {
    renderPreview()
    const form = screen.getByTestId(testIds.createLobbyForm)
    // Scoping matters once the waiting room's edit-settings form shares a page
    // with a create-lobby form: same derived `setting-*` ids, different forms.
    expect(form).toContainElement(screen.getByTestId('setting-timeControl'))
    expect(form).toContainElement(screen.getByTestId('setting-takebacks'))
  })

  it('submits the settings the form is showing', async () => {
    const user = userEvent.setup()
    renderPreview()

    await user.click(screen.getByRole('radio', { name: '3+2' }))
    await user.click(screen.getByTestId(testIds.createLobbySubmit))

    // The preview echoes the submitted payload; the assertion is that the
    // submit control is wired to the form, not to a detached handler.
    expect(screen.getByText(/"timeControl": "3\+2"/)).toBeInTheDocument()
  })

  it('does not submit when a preset chip inside the form is pressed', async () => {
    const user = userEvent.setup()
    renderPreview()

    // A `<button>` inside a `<form>` defaults to `type="submit"`. Every control
    // the settings form renders must opt out, or picking a preset would create
    // the lobby. Scoped to the form because the quick-start row above it offers
    // the same presets by name and is deliberately outside.
    const form = screen.getByTestId(testIds.createLobbyForm)
    await user.click(within(form).getByRole('button', { name: /Rapid 10\+0/ }))

    expect(screen.queryByText(/"timeControl"/)).toBeNull()
  })
})
