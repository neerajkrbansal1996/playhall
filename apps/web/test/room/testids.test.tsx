/**
 * The room / join / seat / presence half of the M2 E2E observable contract §2,
 * asserted against the components that emit it.
 *
 * The registry test in `test/testids.test.tsx` pins the *names*. This file pins
 * that something actually renders them, and that the proof attributes a spec
 * reads (`data-connected`, `data-value`, `data-count`) are present in **both**
 * states rather than only the interesting one.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@playhall/shared'

import { JoinByCodeForm, RoomInvite, SeatList, type SeatView } from '@/components/room'
import { seatTestId, testIds } from '@/lib/testids'

const CODE = 'ABC234'
const URL = 'https://example.test/r/ABC234'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the invite surface', () => {
  it('carries the code, link and copy testids', () => {
    render(<RoomInvite code={CODE} url={URL} />)

    expect(screen.getByTestId(testIds.roomCode)).toHaveTextContent(CODE)
    expect(screen.getByTestId(testIds.roomLink)).toHaveTextContent(URL)
    expect(screen.getByTestId(testIds.copyRoomLink)).toBeInTheDocument()
  })

  it('publishes the whole URL, not a display-truncated one', () => {
    // A spec asserting the invite target must get the target. CSS may clip it;
    // the DOM must not.
    render(<RoomInvite code={CODE} url={URL} />)
    expect(screen.getByTestId(testIds.roomLink)).toHaveAttribute('data-value', URL)
  })

  it('copies the link and reports it', async () => {
    // `userEvent.setup()` installs its own `navigator.clipboard`, so the spy
    // has to go on afterwards — stubbing the global first is silently undone.
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)

    render(<RoomInvite code={CODE} url={URL} />)

    const button = screen.getByTestId(testIds.copyRoomLink)
    expect(button).toHaveAttribute('data-copy-state', 'idle')

    await user.click(button)

    expect(writeText).toHaveBeenCalledWith(URL)
    expect(button).toHaveAttribute('data-copy-state', 'copied')
    // Confirmation reaches a screen reader, not just the tick glyph.
    expect(button).toHaveAccessibleName('Invite link copied')
  })

  it('surfaces a clipboard rejection instead of doing nothing', async () => {
    // Safari rejects outside a recognised user gesture and any browser rejects
    // on an insecure origin. A copy button that silently no-ops is a dead end
    // in the middle of the one flow the whole product depends on.
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))

    render(<RoomInvite code={CODE} url={URL} />)
    await user.click(screen.getByTestId(testIds.copyRoomLink))

    expect(screen.getByTestId(testIds.copyRoomLink)).toHaveAttribute('data-copy-state', 'failed')
    expect(screen.getByRole('alert')).toHaveTextContent(/select the link above/i)
  })

  it('spells the code for a screen reader', () => {
    render(<RoomInvite code={CODE} url={URL} />)
    // Unspelled, `ABC234` is read as a word plus "two hundred thirty-four",
    // which cannot be read back to someone on a call.
    expect(screen.getByTestId(testIds.roomCode)).toHaveAccessibleName('Room code A B C 2 3 4')
  })
})

describe('join by code', () => {
  it('carries the input and submit testids', () => {
    render(<JoinByCodeForm onJoin={vi.fn()} />)
    expect(screen.getByTestId(testIds.joinCodeInput)).toBeInTheDocument()
    expect(screen.getByTestId(testIds.joinSubmit)).toBeInTheDocument()
  })

  it('normalises as you type, so the visible value is what gets sent', async () => {
    const onJoin = vi.fn()
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={onJoin} />)

    const input = screen.getByTestId(testIds.joinCodeInput)
    await user.type(input, ' abc-234 ')

    expect(input).toHaveValue(CODE)
    expect(input).toHaveAttribute('data-value', CODE)

    await user.click(screen.getByTestId(testIds.joinSubmit))
    expect(onJoin).toHaveBeenCalledWith(CODE)
  })

  it('explains a short code rather than disabling the button', async () => {
    const onJoin = vi.fn()
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await user.type(screen.getByTestId(testIds.joinCodeInput), 'ABC')
    const submit = screen.getByTestId(testIds.joinSubmit)
    // A disabled control is the one outcome a phone user cannot diagnose:
    // nothing happens on tap and nothing is announced.
    expect(submit).toBeEnabled()

    await user.click(submit)

    expect(onJoin).not.toHaveBeenCalled()
    // The length *rule* lives in the hint, two lines up and already in this
    // input's accessible description. The message carries the one number the
    // hint cannot: how far along this particular code is.
    expect(screen.getByRole('alert')).toHaveTextContent('That code has 3 of 6 characters.')
    expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('aria-invalid', 'true')

    // A second length, because one is not enough: with a single 3-character
    // fixture, hard-coding the count to `3` keeps the suite green.
    await user.type(screen.getByTestId(testIds.joinCodeInput), 'DE')
    await user.click(submit)

    expect(onJoin).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('That code has 5 of 6 characters.')
  })

  it('asks for a code rather than specifying one when the field is empty', async () => {
    const onJoin = vi.fn()
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await user.click(screen.getByTestId(testIds.joinSubmit))

    expect(onJoin).not.toHaveBeenCalled()
    // `That code has 0 of 6 characters.` would be a true statement about a
    // field the player has not touched, and no instruction at all.
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the code from your invite.')
  })

  it('names which characters survived the cap, not the length rule again', async () => {
    const onJoin = vi.fn()
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={onJoin} />)

    const input = screen.getByTestId(testIds.joinCodeInput)
    // A 7th *canonical* character: nothing to strip, so one is really lost.
    await user.type(input, 'ABC2345')

    expect(input).toHaveValue(CODE)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Only the first 6 characters were used. Check the code you were sent.',
    )
  })

  it('keeps the overflow message across the press instead of swapping it', async () => {
    const onJoin = vi.fn()
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={onJoin} />)

    const input = screen.getByTestId(testIds.joinCodeInput)
    await user.type(input, 'ABC2345')
    await user.click(screen.getByTestId(testIds.joinSubmit))

    // `overflowed` implies the value is six canonical characters, which
    // `isValidRoomCode` accepts — so the press is a real join and `tooShort`
    // can never be set while `overflowed` is. Asserting precedence between the
    // two would pin nothing; this pins the exclusivity behaviourally.
    expect(onJoin).toHaveBeenCalledWith(CODE)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Only the first 6 characters were used. Check the code you were sent.',
    )
  })

  it('describes the field before the first keystroke', () => {
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    const input = screen.getByTestId(testIds.joinCodeInput)
    // The placeholder is not an accessible description and vanishes on the
    // first keystroke. This is the affordance that is there before it.
    expect(input).toHaveAccessibleDescription('6 characters. Codes never use O, 0, I, 1 or L.')
    // Resting state is not an error state.
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('wires a server-side error to the input for assistive technology', () => {
    render(<JoinByCodeForm onJoin={vi.fn()} error="That room has expired." />)

    const input = screen.getByTestId(testIds.joinCodeInput)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    // Composed, hint first — not a substring match. The composition *is* the
    // behaviour: a player who hits an expired room still needs the alphabet
    // rule when they retype the code, and `fieldIds()` in
    // `components/settings-form/field-shell.tsx` already orders help before
    // error for every settings field.
    expect(input).toHaveAccessibleDescription(
      '6 characters. Codes never use O, 0, I, 1 or L. That room has expired.',
    )
  })

  it('keeps the hint role-less and silent', () => {
    render(<JoinByCodeForm onJoin={vi.fn()} error="That room has expired." />)

    const input = screen.getByTestId(testIds.joinCodeInput)
    const [hintId] = (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
    const hint = document.getElementById(hintId as string)

    // The hint's copy never changes after mount, so it has nothing to announce
    // and must not compete with the message node for the announcement queue.
    //
    // Asserted on the attributes, not via `getByRole('alert')` throwing on a
    // second match: `role="status"` is a *different* role, so the ambiguity
    // check below passes happily while the field has acquired a live region.
    expect(hint).not.toBeNull()
    expect(hint).not.toHaveAttribute('role')
    expect(hint).not.toHaveAttribute('aria-live')

    // And the message node is still reachable as the field's only alert.
    expect(screen.getByRole('alert')).toHaveTextContent('That room has expired.')
  })

  it('submits on Enter from the field', async () => {
    const onJoin = vi.fn()
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await user.type(screen.getByTestId(testIds.joinCodeInput), `${CODE}{Enter}`)

    // Keyboard parity for free, and one fewer tap on a phone.
    expect(onJoin).toHaveBeenCalledWith(CODE)
  })

  it('does not fire a second join while one is in flight', async () => {
    const onJoin = vi.fn()
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={onJoin} pending />)

    await user.type(screen.getByTestId(testIds.joinCodeInput), CODE)
    await user.click(screen.getByTestId(testIds.joinSubmit))

    expect(onJoin).not.toHaveBeenCalled()
  })
})

/**
 * The hint's glyph list is a hard-coded literal in the component, so that
 * rendering it costs no bundle bytes. These pins are what make that safe: the
 * literal cannot drift from `ROOM_CODE_ALPHABET` in either direction without a
 * failure here.
 */
describe("the join-code hint's glyph list", () => {
  /** Read the hint back off the input's own `aria-describedby`, hint id first. */
  function renderHint(): string {
    render(<JoinByCodeForm onJoin={vi.fn()} />)
    const input = screen.getByTestId(testIds.joinCodeInput)
    const [hintId] = (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
    expect(hintId).toBeDefined()
    const hint = document.getElementById(hintId as string)
    expect(hint).not.toBeNull()
    return hint?.textContent ?? ''
  }

  /**
   * Parse the list out of the sentence rather than substring-searching it. A
   * naive `hint.includes(ch)` would report `C`, `E`, `S` and `6` as "named"
   * because they occur in "6 characters" and "Codes never use".
   */
  function namedGlyphs(hint: string): readonly string[] {
    const list = /never use ([^.]*)\./.exec(hint)?.[1]
    expect(list, `no glyph list found in hint: ${hint}`).toBeDefined()
    return (list as string)
      .split(/\s*,\s*|\s+or\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  }

  it('names every excluded character and no permitted one', () => {
    const named = new Set(namedGlyphs(renderHint()))

    // Two-way, over the whole plausible input domain. One direction catches a
    // hint that forbids a glyph players are allowed to type; the other catches
    // the alphabet dropping a sixth character the hint never mentions.
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
      expect(named.has(ch), `hint names ${ch}`).toBe(!ROOM_CODE_ALPHABET.includes(ch))
    }
  })

  it('names each glyph once, as a single character', () => {
    // Without this, a malformed list such as `O0, I1 or L` would still satisfy
    // the set comparison above under a looser parse.
    const named = namedGlyphs(renderHint())
    expect(named.every((glyph) => glyph.length === 1)).toBe(true)
    expect(new Set(named).size).toBe(named.length)
  })

  it('pairs each confusable with its partner, and takes its length from shared', () => {
    const hint = renderHint()

    // Order is deliberate: each excluded letter sits next to the digit it is
    // mistaken for, so the list reads as three facts rather than five.
    expect(namedGlyphs(hint)).toEqual(['O', '0', 'I', '1', 'L'])
    // The `6` is interpolated from `ROOM_CODE_LENGTH`, not typed.
    expect(hint.startsWith(`${ROOM_CODE_LENGTH} characters.`)).toBe(true)
  })
})

describe('seats and presence', () => {
  const seats: readonly SeatView[] = [
    { id: 'w', label: 'White', occupantName: 'Priya', connected: true },
    { id: 'b', label: 'Black', occupantName: 'Sam', connected: false },
  ]

  it('derives a seat testid per seat and always writes data-connected', () => {
    render(<SeatList seats={seats} spectatorCount={2} />)

    expect(screen.getByTestId(seatTestId('w'))).toHaveAttribute('data-connected', 'true')
    expect(screen.getByTestId(seatTestId('b'))).toHaveAttribute('data-connected', 'false')
  })

  it('reports an occupied seat as occupied, present or dropped', () => {
    // The helper's unit test pins `occupied: true` → `data-occupied="true"`.
    // This pins the thing only a render can see: that `SeatList` actually maps
    // `occupantName` onto that field. Without it, hard-coding the call site to
    // `occupied: false` leaves the whole suite green — the key-set pin checks
    // keys, the helper pins are called directly, and the only rendered
    // `data-occupied` assertion is on an *empty* seat, where `false` is correct.
    //
    // Both assertions read the pair, never presence alone: a dropped player is
    // `data-occupied="true"` AND `data-connected="false"`, which is the only
    // selector that does not also match an open seat.
    render(<SeatList seats={seats} spectatorCount={2} />)

    const present = screen.getByTestId(seatTestId('w'))
    expect(present).toHaveAttribute('data-occupied', 'true')
    expect(present).toHaveAttribute('data-connected', 'true')

    const dropped = screen.getByTestId(seatTestId('b'))
    expect(dropped).toHaveAttribute('data-occupied', 'true')
    expect(dropped).toHaveAttribute('data-connected', 'false')
  })

  it('reports an empty seat as disconnected and unoccupied', () => {
    render(
      <SeatList
        seats={[{ id: 'b', label: 'Black', occupantName: null, connected: false }]}
        spectatorCount={0}
      />,
    )

    const seat = screen.getByTestId(seatTestId('b'))
    expect(seat).toHaveAttribute('data-connected', 'false')
    // Without this, `[data-connected="false"]` means both "dropped" and
    // "nobody sat down", and the disconnect scenarios assert that selector.
    expect(seat).toHaveAttribute('data-occupied', 'false')
  })

  it('takes whatever seat ids the game descriptor supplies', () => {
    // No colour union anywhere: a four-seat game must work unchanged.
    render(
      <SeatList
        seats={[
          { id: 'p1', label: 'Player 1', occupantName: 'A', connected: true },
          { id: 'p4', label: 'Player 4', occupantName: null, connected: false },
        ]}
        spectatorCount={0}
      />,
    )

    expect(screen.getByTestId('seat-p1')).toBeInTheDocument()
    expect(screen.getByTestId('seat-p4')).toBeInTheDocument()
  })

  it('carries presence in text as well as in colour', () => {
    render(<SeatList seats={seats} spectatorCount={0} />)

    // The reconnecting state must survive greyscale and colour blindness.
    expect(screen.getByTestId(seatTestId('b'))).toHaveTextContent('Reconnecting…')
    expect(screen.getByTestId(seatTestId('w'))).toHaveTextContent('Ready')
  })

  it('publishes the spectator count as an attribute, not only prose', () => {
    const { rerender } = render(<SeatList seats={seats} spectatorCount={2} />)
    expect(screen.getByTestId(testIds.spectatorCount)).toHaveAttribute('data-count', '2')

    // Zero must still render: "absent" and "nobody watching" are different
    // facts, and a spec cannot wait for an element that only exists sometimes.
    rerender(<SeatList seats={seats} spectatorCount={0} />)
    expect(screen.getByTestId(testIds.spectatorCount)).toHaveAttribute('data-count', '0')
    expect(screen.getByTestId(testIds.spectatorCount)).toHaveTextContent('0 spectators')
  })

  it('escapes an occupant name rather than trusting it', () => {
    render(
      <SeatList
        seats={[
          { id: 'w', label: 'White', occupantName: '<img src=x onerror=1>', connected: true },
        ]}
        spectatorCount={0}
      />,
    )

    const seat = screen.getByTestId(seatTestId('w'))
    expect(seat.querySelector('img')).toBeNull()
    expect(seat).toHaveTextContent('<img src=x onerror=1>')
  })
})
