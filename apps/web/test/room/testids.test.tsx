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
    expect(screen.getByRole('alert')).toHaveTextContent('A room code is 6 characters.')
    expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('aria-invalid', 'true')
  })

  it('wires a server-side error to the input for assistive technology', () => {
    render(<JoinByCodeForm onJoin={vi.fn()} error="That room has expired." />)

    const input = screen.getByTestId(testIds.joinCodeInput)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('That room has expired.')
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
