/**
 * PER-214 — a 7th *canonical* character in the join-code field.
 *
 * `JoinByCodeForm` caps its value with
 * `normalizeRoomCode(value).slice(0, ROOM_CODE_LENGTH)`. The `.slice` is at the
 * call site, not inside `normalizeRoomCode`, so a helper-level unit test pins
 * nothing — every case here drives the component through real input events.
 *
 * The pair that matters is cases 1/2 against case 3: seven *canonical*
 * characters lose one and must say so, while seven *raw* characters that
 * normalise to exactly six (`ABC-234`, the [PER-197](/PER/issues/PER-197)
 * shape) must stay silent. A naive `rawValue.length > ROOM_CODE_LENGTH` check
 * passes 1/2 and fails 3.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { JoinByCodeForm } from '@/components/room'
import { testIds } from '@/lib/testids'

const OVERFLOW = /extra characters were not used/i

/** Click into the field and bulk-insert `text`, the paste-from-chat path. */
async function pasteInto(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByTestId(testIds.joinCodeInput))
  await user.paste(text)
}

describe('a 7th canonical character in the join-code field', () => {
  it('keeps six characters and announces the drop on paste', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'ABC2345')

    const input = screen.getByTestId(testIds.joinCodeInput)
    expect(input).toHaveAttribute('data-value', 'ABC234')

    // Reuses the one `role="alert"` node the component already has, rather than
    // a second announcement mechanism.
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(OVERFLOW)
    // The message is wired to the field, not merely rendered near it.
    expect(input).toHaveAttribute('aria-describedby', alert.id)
    // Deliberate: the six characters are well-formed, but they are not what the
    // player supplied, which is what `aria-invalid` tells them to look at.
    // Without this the attribute is covered for `error` and `tooShort` only, and
    // narrowing it to those two triggers passes the whole suite.
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('announces the drop on the typed path too, not only on paste', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    // Keystroke by keystroke the value never exceeds six until the 7th press,
    // which is a different code path through `onChange` than a bulk insert.
    await user.type(screen.getByTestId(testIds.joinCodeInput), 'ABC2345')

    expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('data-value', 'ABC234')
    expect(screen.getByRole('alert')).toHaveTextContent(OVERFLOW)
  })

  it('stays silent for seven raw characters that normalise to six', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    // `ABC-234` is seven characters inserted and six canonical ones — nothing
    // was lost, so there is nothing to announce. Counting raw length here would
    // shout at every player who pastes a hyphenated code from a chat message.
    await pasteInto(user, 'ABC-234')

    expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('data-value', 'ABC234')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears the announcement once the value is back within six', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'ABC2345')
    expect(screen.getByRole('alert')).toHaveTextContent(OVERFLOW)

    await user.type(screen.getByTestId(testIds.joinCodeInput), '{backspace}')

    expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('data-value', 'ABC23')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('still joins with the six characters it kept, and keeps the message up', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await pasteInto(user, 'ABC2345')
    await user.click(screen.getByTestId(testIds.joinSubmit))

    // Six canonical characters is a well-formed code and the server is the
    // authority on whether that room exists, so the overflow does not veto the
    // press. The message stays up as the only account of the dropped character.
    expect(onJoin).toHaveBeenCalledWith('ABC234')
    expect(screen.getByRole('alert')).toHaveTextContent(OVERFLOW)
  })

  it('yields the alert node to a server error', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} error="That room has closed." />)

    await pasteInto(user, 'ABC2345')

    // One node, one message: the server's outcome is more actionable than our
    // note about the input, and two alerts in the same slot is not a thing.
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent('That room has closed.')
    expect(alerts[0]).not.toHaveTextContent(OVERFLOW)
  })
})
