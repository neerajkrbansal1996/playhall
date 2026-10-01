/**
 * PER-235 — pasting the invite **link** into the join-code field.
 *
 * `read-room-code-input.test.ts` is the case table for the classification.
 * This file is the part the player experiences: what the field holds, what it
 * announces, what the press sends, and — the half that is easy to lose — that
 * the announcement does not mark a working field as broken.
 *
 * The old behaviour, measured on PR #111's head `aabe43d` and again here
 * before the fix: `https://host/join/ABC234` left `HTTPSP` in the field,
 * `isValidRoomCode('HTTPSP')` was true, and pressing Join sent `HTTPSP`. The
 * code was in the string the player pasted.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { JoinByCodeForm } from '@/components/room'
import { testIds } from '@/lib/testids'

const LIFTED = /took the code from that link/i
const NO_CODE_IN_LINK = /looks like a link with no room code/i
const OVERFLOW = /extra characters were not used/i

/** Click into the field and bulk-insert `text`, the paste-from-chat path. */
async function pasteInto(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByTestId(testIds.joinCodeInput))
  await user.paste(text)
}

afterEach(cleanup)

describe('an invite link pasted into the code field', () => {
  for (const raw of [
    'https://playhall.app/r/ABC234',
    'https://playhall.app/join/ABC234',
    'Join: https://playhall.app/r/ABC234',
    'playhall.app/r/ABC234',
    // The exact fixture PER-234 pinned as `kept: 'HTTPSE'` while extraction was
    // still an open question, carried over verbatim — host included — so
    // retiring that row from `join-code-prose-paste.test.tsx` moves the shape
    // here rather than dropping it. A second host also keeps the suite honest
    // about matching URL *shape* and not one brand: `playhall.app` and
    // `example.test` have different label lengths and different TLDs.
    'https://example.test/join/ABC234',
  ] as const) {
    it(`joins the room the link names for ${JSON.stringify(raw)}`, async () => {
      const user = userEvent.setup()
      const onJoin = vi.fn()
      render(<JoinByCodeForm onJoin={onJoin} />)

      await pasteInto(user, raw)
      expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('data-value', 'ABC234')

      await user.click(screen.getByTestId(testIds.joinSubmit))
      expect(onJoin).toHaveBeenCalledWith('ABC234')
    })
  }

  it('says it read the link, because six characters replaced forty', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'https://playhall.app/r/ABC234')

    const note = screen.getByRole('status')
    expect(note).toHaveTextContent(LIFTED)
    expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('aria-describedby', note.id)
  })

  it('does not mark the field invalid for a code it read correctly', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'https://playhall.app/r/ABC234')

    // The distinction the tone exists for. `aria-invalid` here would tell a
    // screen-reader user their field is wrong on the way into the right room,
    // and `role="alert"` would interrupt to say so.
    const input = screen.getByTestId(testIds.joinCodeInput)
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not report an overflow — nothing the player needed was dropped', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'https://playhall.app/r/ABC234')

    // 23 canonical characters arrived and 6 are shown, so the raw-length view
    // of "overflow" would fire. It is keyed on the reading instead: a link
    // that gave up its code lost only the link.
    expect(screen.queryByText(OVERFLOW)).not.toBeInTheDocument()
  })

  it('never sends the scheme as a code', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await pasteInto(user, 'https://playhall.app/join/ABC234')
    await user.click(screen.getByTestId(testIds.joinSubmit))

    // The regression vector itself, named rather than implied.
    expect(screen.getByTestId(testIds.joinCodeInput)).not.toHaveAttribute('data-value', 'HTTPSP')
    expect(onJoin).not.toHaveBeenCalledWith('HTTPSP')
  })
})

describe('a link with no room code in it', () => {
  it('clears the field and says what it is', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await pasteInto(user, 'https://playhall.app/play/chess')

    const input = screen.getByTestId(testIds.joinCodeInput)
    expect(input).toHaveAttribute('data-value', '')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(NO_CODE_IN_LINK)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', alert.id)
  })

  it('sends nothing when pressed, and keeps saying why', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await pasteInto(user, 'https://playhall.app/play/chess')
    await user.click(screen.getByTestId(testIds.joinSubmit))

    expect(onJoin).not.toHaveBeenCalled()
    // "A room code is 6 characters" is true of the empty field but useless:
    // the player pasted something and we need to tell them what we made of it,
    // which is why the link message outranks `tooShort`.
    expect(screen.getByRole('alert')).toHaveTextContent(NO_CODE_IN_LINK)
  })

  it('stops saying it as soon as a real code is typed over it', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await pasteInto(user, 'https://playhall.app/play/chess')
    await user.type(screen.getByTestId(testIds.joinCodeInput), 'ABC234')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    await user.click(screen.getByTestId(testIds.joinSubmit))
    expect(onJoin).toHaveBeenCalledWith('ABC234')
  })
})

describe('a server error still outranks the field', () => {
  it('shows the join outcome rather than the note about the link', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} error="That room has closed." />)

    await pasteInto(user, 'https://playhall.app/r/ABC234')

    // One slot, so the two can never stack. The room being closed is the more
    // actionable of the two.
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('That room has closed.')
    expect(screen.queryByText(LIFTED)).not.toBeInTheDocument()
  })
})

describe('the prose paths PER-234 pinned are untouched', () => {
  it('still keeps the trailing-prose code and still warns', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await pasteInto(user, 'ABC234 join me')
    await user.click(screen.getByTestId(testIds.joinSubmit))

    expect(onJoin).toHaveBeenCalledWith('ABC234')
    expect(screen.getByRole('alert')).toHaveTextContent(OVERFLOW)
  })

  it('does not mistake a slash in prose for a link', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'ABC234 and/or XYZ789')

    // Treating this as a link would clear the field and show the
    // "no room code in it" error on a paste that joins the right room.
    expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('data-value', 'ABC234')
    expect(screen.queryByText(NO_CODE_IN_LINK)).not.toBeInTheDocument()
  })
})
