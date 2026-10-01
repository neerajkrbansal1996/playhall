/**
 * PER-214 — pastes that carry **prose**, not just a separator.
 *
 * [PER-197](/PER/issues/PER-197) fixed the shapes by which a *correct* code
 * arrives (`abc 234`, `ABC-234`, `  abc-234  `). This file covers the shapes by
 * which a code arrives *wrapped in a sentence*, which is how a code actually
 * leaves a chat app: nobody sends six bare characters, they send
 * "join with ABC234".
 *
 * The thing that makes these shapes dangerous rather than merely untidy is the
 * room-code alphabet. `ROOM_CODE_ALPHABET` excludes `0 O 1 I L`, so prose does
 * not normalise to anything recognisable as prose — "join with " becomes
 * `JNWTH`, five perfectly ordinary code characters. Every row below lands a
 * six-character value that `isValidRoomCode` accepts, so the client-side length
 * check never fires and the press always goes through.
 *
 * Two classes, and the difference between them is the whole point:
 *
 * - **Prose before the code** — the kept six are not the code at all
 *   (`"Code: ABC234"` → `CDEABC`). The player reaches not-found holding a
 *   plausible six characters. The pasted invite link belongs here and is the
 *   most likely member of the class to actually happen
 *   (`"https://example.test/join/ABC234"` → `HTTPSE`).
 * - **Prose after the code** — the kept six *are* the code
 *   (`"ABC234 join me"` → `ABC234`). The join succeeds.
 *
 * The component cannot tell the two apart; it only knows more than six
 * canonical characters arrived. So it warns in both cases, and the second class
 * is a deliberately-accepted false alarm — the message is cheap and the
 * alternative is silence on the first class.
 *
 * That is why the "treat `canonical.length > 6` as *not a code* and refuse it"
 * rule discussed on PER-197 is **not** implemented and must not be: it would
 * refuse `"ABC234 join me"`, a paste that joins the right room today. The
 * trailing-prose cases below are the guard against that rule being written in
 * later.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isValidRoomCode } from '@playhall/shared'

import { JoinByCodeForm } from '@/components/room'
import { testIds } from '@/lib/testids'

const OVERFLOW = /extra characters were not used/i

/** Click into the field and bulk-insert `text`, the paste-from-chat path. */
async function pasteInto(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByTestId(testIds.joinCodeInput))
  await user.paste(text)
}

afterEach(cleanup)

/**
 * Prose *before* the code. `kept` is deliberately spelled out per row rather
 * than computed: the point of the case is that the value is a plausible code
 * bearing no resemblance to the one the player was sent, and a computed
 * expectation would restate the implementation instead of pinning that.
 *
 * The invite link is a member of this class and the highest-traffic one — every
 * lobby has a link as well as a code, and "tap the link text, paste it" is at
 * least as common as pasting a sentence. The host is deliberately
 * `example.test`: the product domain is an open board decision and nothing
 * under `apps/web/src` or `packages/shared/src` hard-codes one. The row pins
 * what the field does with a link *today*; whether a pasted link should have
 * its code extracted is a product decision tracked on
 * [PER-242](/PER/issues/PER-242), not something this file asserts.
 */
const LEADING_PROSE = [
  { raw: 'Code: ABC234', kept: 'CDEABC' },
  { raw: 'your code: ABC234', kept: 'YURCDE' },
  { raw: 'join with ABC234', kept: 'JNWTHA' },
  { raw: 'Room code is ABC234', kept: 'RMCDES' },
  { raw: 'ok ABC234', kept: 'KABC23' },
  { raw: 'Join my game: ABC234 - see you there', kept: 'JNMYGA' },
  { raw: 'https://example.test/join/ABC234', kept: 'HTTPSE' },
] as const

describe('a code pasted with prose in front of it', () => {
  // Hoisted out of the per-row cases below, where it operated only on the
  // table literals and so could not fail for any change to the component.
  // Stated once, as what it is: a property of the fixtures.
  it('is a table of plausible codes, none of which is the real one', () => {
    for (const { kept } of LEADING_PROSE) {
      expect(isValidRoomCode(kept)).toBe(true)
      expect(kept).not.toBe('ABC234')
    }
  })

  for (const { raw, kept } of LEADING_PROSE) {
    it(`announces the overflow for ${JSON.stringify(raw)}`, async () => {
      const user = userEvent.setup()
      render(<JoinByCodeForm onJoin={vi.fn()} />)

      await pasteInto(user, raw)

      // The kept six are a well-formed code — see the table self-check above —
      // which is why silence here was the dangerous option: nothing downstream
      // of the field can tell this is not the code the player was sent.
      const input = screen.getByTestId(testIds.joinCodeInput)
      expect(input).toHaveAttribute('data-value', kept)

      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent(OVERFLOW)
      expect(input).toHaveAttribute('aria-describedby', alert.id)
    })
  }

  it('sends the kept six rather than refusing the press', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await pasteInto(user, 'Code: ABC234')
    await user.click(screen.getByTestId(testIds.joinSubmit))

    // The server owns whether a well-formed code names a room, so the field
    // does not veto. The player lands on not-found, with the overflow message
    // still up as the account of why.
    expect(onJoin).toHaveBeenCalledWith('CDEABC')
    expect(screen.getByRole('alert')).toHaveTextContent(OVERFLOW)
  })
})

describe('a code pasted with prose after it', () => {
  // The kept six ARE the code here. Pinning the value is what stops a future
  // "canonical.length > 6 means this is not a code, refuse it" rule from
  // regressing a paste that joins the right room today.
  for (const raw of ['ABC234 join me', 'ABC234 — join now'] as const) {
    it(`still keeps the real code for ${JSON.stringify(raw)}`, async () => {
      const user = userEvent.setup()
      const onJoin = vi.fn()
      render(<JoinByCodeForm onJoin={onJoin} />)

      await pasteInto(user, raw)
      await user.click(screen.getByTestId(testIds.joinSubmit))

      expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('data-value', 'ABC234')
      expect(onJoin).toHaveBeenCalledWith('ABC234')
    })
  }

  it('warns anyway, because the field cannot know the kept six are the code', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'ABC234 join me')

    // A knowingly-accepted false alarm: `aria-invalid` and the overflow note
    // sit on a value that will join the right room. The trade is deliberate —
    // see the file comment — and this case records it so the next person to
    // read the alert on a working code finds the reason instead of a surprise.
    const input = screen.getByTestId(testIds.joinCodeInput)
    expect(screen.getByRole('alert')).toHaveTextContent(OVERFLOW)
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('prose that vanishes into the alphabet', () => {
  it('stays silent when the prose has no in-alphabet characters', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    // `L` and `O` are both excluded from `ROOM_CODE_ALPHABET`, so "Lol "
    // normalises away to nothing and exactly six canonical characters arrive.
    // Nothing was dropped, so there is nothing to announce — the same property
    // the `ABC-234` case pins, reached by a different route.
    await pasteInto(user, 'Lol ABC234')

    expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('data-value', 'ABC234')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
