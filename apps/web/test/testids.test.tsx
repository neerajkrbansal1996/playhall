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
import { Harness } from './settings-form/harness'

describe('the platform testid registry', () => {
  it('matches the names the contract fixed', () => {
    expect(testIds).toEqual({
      createLobbyForm: 'create-lobby-form',
      createLobbySubmit: 'create-lobby-submit',
      editSettingsForm: 'edit-settings-form',
      roomCode: 'room-code',
      roomLink: 'room-link',
      copyRoomLink: 'copy-room-link',
      joinCodeInput: 'join-code-input',
      joinSubmit: 'join-submit',
      spectatorCount: 'spectator-count',
    })
  })

  it('names a container for each of the two forms that can share a page', () => {
    // Not decoration: `setting-*` ids carry no form namespace, so these two
    // names are the only thing a spec can disambiguate on once the waiting
    // room's edit-settings form sits beside create-lobby ([PER-20]). Deleting
    // `editSettingsForm` as "unused" would leave that page untestable, which is
    // why it is named before the form it points at exists.
    expect(testIds.createLobbyForm).not.toBe(testIds.editSettingsForm)
    for (const id of [testIds.createLobbyForm, testIds.editSettingsForm]) {
      expect(id).toMatch(/-form$/)
      expect(id).not.toMatch(/^setting-/)
    }
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
    expect(seatTestAttributes('w', { connected: true, occupied: true })).toEqual({
      'data-testid': 'seat-w',
      'data-connected': 'true',
      'data-occupied': 'true',
    })
    expect(seatTestAttributes('b', { connected: false, occupied: true })).toEqual({
      'data-testid': 'seat-b',
      'data-connected': 'false',
      'data-occupied': 'true',
    })
  })

  it('emits all three seat attributes or none — the bundle is the contract', () => {
    // A key-set pin, not three attribute assertions. Attribute-by-attribute
    // checks keep passing when a fourth key is added or a third is dropped,
    // which is exactly how `data-occupied` came to be written inline by one
    // call site instead of living here ([PER-195](/PER/issues/PER-195)). A
    // second seat surface that spreads this bundle must be unable to ship
    // presence without the occupancy that makes presence readable.
    expect(
      Object.keys(seatTestAttributes('w', { connected: true, occupied: true })).sort(),
    ).toEqual(['data-connected', 'data-occupied', 'data-testid'])
  })

  it('takes occupancy as a named field, not a third positional boolean', () => {
    // Two adjacent booleans is a swap waiting to happen:
    // `seatTestAttributes('b', false, true)` reads as nothing at a call site,
    // and a helper whose whole job is to be the thing you cannot get wrong
    // should not have an argument order you can get wrong. `tsc --noEmit`
    // covers `test/**` in this package, so this is a live pin — revert the
    // signature to positionals and the now-unused @ts-expect-error fails
    // typecheck.
    // @ts-expect-error - occupancy is a named field; a third boolean is not the contract.
    const positional = seatTestAttributes('b', false, true)

    // The runtime value is incidental; the assertion above the line is the pin.
    expect(positional).toHaveProperty('data-testid', 'seat-b')
  })

  it('writes data-occupied for an empty seat rather than omitting it', () => {
    // Same rule as `data-connected`: an absent attribute and a false one are
    // indistinguishable to a spec, so a free seat has to say so out loud.
    expect(seatTestAttributes('b', { connected: false, occupied: false })).toEqual({
      'data-testid': 'seat-b',
      'data-connected': 'false',
      'data-occupied': 'false',
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

describe('two settings forms on one page', () => {
  /**
   * The shape [PER-20](/PER/issues/PER-20) will build: the host edits settings
   * in the waiting room while a create-lobby form is also mounted. The
   * edit-settings form does not exist yet, so this stands in the renderer with
   * the container name it will carry.
   */
  function renderBothForms() {
    const normalized = normalizeSettingsForm(chessSettingsFormFixture)
    return render(
      <>
        <CreateLobbyPreview
          gameName="chess"
          form={normalized.form}
          defaultSettings={chessDefaultSettingsFixture}
          presets={chessPresetsFixture}
        />
        <div data-testid={testIds.editSettingsForm}>
          <Harness
            settingsForm={chessSettingsFormFixture}
            defaultSettings={chessDefaultSettingsFixture}
          />
        </div>
      </>,
    )
  }

  it('emits the same setting-* id twice, which is the reason the anchor exists', () => {
    renderBothForms()

    // Measured, not hypothetical. `getByTestId` — and Playwright's strict-mode
    // locator — throws on this. If a future change ever prefixes the derived
    // ids, this test fails and `editSettingsForm`'s rationale needs rewriting
    // rather than silently rotting.
    expect(screen.getAllByTestId('setting-timeControl')).toHaveLength(2)
  })

  it('is disambiguated by scoping to each form container', () => {
    renderBothForms()

    const createLobby = screen.getByTestId(testIds.createLobbyForm)
    const editSettings = screen.getByTestId(testIds.editSettingsForm)

    // The rule the E2E contract writes down: scope to the form, then ask for
    // the field. Both sides resolve to exactly one element, and to different ones.
    const inCreate = within(createLobby).getByTestId('setting-timeControl')
    const inEdit = within(editSettings).getByTestId('setting-timeControl')
    expect(inCreate).not.toBe(inEdit)
    expect(editSettings).not.toContainElement(inCreate)
  })
})
