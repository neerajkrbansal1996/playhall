/**
 * PER-214 / PER-242 — pastes that carry **prose**, not just a separator.
 *
 * [PER-197](/PER/issues/PER-197) fixed the shapes by which a *correct* code
 * arrives (`abc 234`, `ABC-234`, `  abc-234  `). This file covers the shapes by
 * which a code arrives *wrapped in a sentence*, which is how a code actually
 * leaves a chat app: nobody sends six bare characters, they send
 * "join with ABC234".
 *
 * The thing that made these shapes dangerous rather than merely untidy is the
 * room-code alphabet. `ROOM_CODE_ALPHABET` excludes `0 O 1 I L`, so prose does
 * not normalise to anything recognisable as prose — "join with " becomes
 * `JNWTH`, five perfectly ordinary code characters. Under "normalise, then cap"
 * every row below landed a six-character value that `isValidRoomCode` accepts,
 * so no length check could fire; and where the prose came *first*, the kept six
 * were not the code (`"Code: ABC234"` → `CDEABC`,
 * `"https://example.test/join/ABC234"` → `HTTPSE`). The player was told
 * characters had been dropped and could not be told the ones kept were wrong.
 *
 * [PER-242](/PER/issues/PER-242) settled that: the field now extracts, with the
 * rule **exactly one run of exactly six alphabet characters**
 * (`extractRoomCode`). Every row below yields `ABC234` and says nothing, because
 * `ABC234` is the only six-run present in any of them — `https://` is a
 * five-run, `join/` is `J` then `N`, `Code: ` is `C` then `DE`.
 *
 * Three things this file is really here to hold down, each in its own `describe`
 * below:
 *
 * - Extraction matches **whole runs**, never a substring. A substring search
 *   finds `ABC234` inside `ABC2345` and would silently swallow the dropped-7th
 *   character that `join-code-overflow.test.tsx` exists to report.
 * - Extraction does **not** guess between two six-runs, and the cap's
 *   announcement still fires for everything extraction declines.
 * - The "treat `canonical.length > 6` as *not a code* and refuse the press" rule
 *   discussed on PER-197 is still **not** implemented and must not be. The
 *   trailing-prose rows are the guard: they are pastes that join the right room.
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
 * `kept` is what "normalise, then cap" used to leave in the field. It is kept
 * from the red version of this table rather than deleted: it is measured, not
 * predicted, and it is what makes a regression message name the severity — a
 * plausible six-character code bearing no resemblance to the one the player was
 * sent — instead of only the mismatch.
 *
 * The invite link is a member of this class and the highest-traffic one: every
 * lobby has a link as well as a code, and "tap the link text, paste it" is at
 * least as common as pasting a sentence. The host is deliberately
 * `example.test`. The product domain is an open board decision, nothing under
 * `apps/web/src` or `packages/shared/src` hard-codes one, and `extractRoomCode`
 * does not parse URLs at all — so no row here depends on which host the link
 * carries, and the scheme-stripped form a chat app produces is the same case.
 */
const LEADING_PROSE = [
  { raw: 'Code: ABC234', was: 'CDEABC' },
  { raw: 'your code: ABC234', was: 'YURCDE' },
  { raw: 'join with ABC234', was: 'JNWTHA' },
  { raw: 'Room code is ABC234', was: 'RMCDES' },
  { raw: 'ok ABC234', was: 'KABC23' },
  { raw: 'Join my game: ABC234 - see you there', was: 'JNMYGA' },
  { raw: 'https://example.test/join/ABC234', was: 'HTTPSE' },
  { raw: 'example.test/join/ABC234', was: 'EXAMPE' },
] as const

describe('a code pasted with prose in front of it', () => {
  // A property of the fixtures, stated once: every `was` is a well-formed code
  // and none of them is the real one. That is what made silence the dangerous
  // option before extraction — nothing downstream of the field could tell.
  it('is a table of plausible codes, none of which is the real one', () => {
    for (const { was } of LEADING_PROSE) {
      expect(isValidRoomCode(was)).toBe(true)
      expect(was).not.toBe('ABC234')
    }
  })

  for (const { raw } of LEADING_PROSE) {
    it(`extracts the code from ${JSON.stringify(raw)}`, async () => {
      const user = userEvent.setup()
      const onJoin = vi.fn()
      render(<JoinByCodeForm onJoin={onJoin} />)

      await pasteInto(user, raw)

      const input = screen.getByTestId(testIds.joinCodeInput)
      expect(input).toHaveAttribute('data-value', 'ABC234')

      // Nothing the player needed was dropped, so there is nothing to
      // announce — and the overflow copy ("check the code you were sent") would
      // be actively wrong next to the code they were in fact sent.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(input).not.toHaveAttribute('aria-invalid')

      await user.click(screen.getByTestId(testIds.joinSubmit))
      expect(onJoin).toHaveBeenCalledWith('ABC234')
    })
  }
})

describe('a code pasted with prose after it', () => {
  // These joined the right room even before extraction — the kept six already
  // were the code — but they did it while showing an overflow alert and
  // `aria-invalid`, a knowingly-accepted false alarm. Extraction removes the
  // alarm; the value must not move.
  for (const raw of ['ABC234 join me', 'ABC234 — join now'] as const) {
    it(`keeps the real code and no longer warns for ${JSON.stringify(raw)}`, async () => {
      const user = userEvent.setup()
      const onJoin = vi.fn()
      render(<JoinByCodeForm onJoin={onJoin} />)

      await pasteInto(user, raw)
      await user.click(screen.getByTestId(testIds.joinSubmit))

      expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('data-value', 'ABC234')
      expect(onJoin).toHaveBeenCalledWith('ABC234')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  }
})

describe('prose that vanishes into the alphabet', () => {
  it('stays silent when the prose has no in-alphabet characters', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    // `L` and `O` are both excluded from `ROOM_CODE_ALPHABET`, so "Lol "
    // normalises away to nothing and exactly six canonical characters arrive.
    // This row reaches the silent outcome without extraction having to decline
    // or accept anything, so it still passes if `extractRoomCode` is deleted —
    // which is why it is not the guard for any of the behaviour above.
    await pasteInto(user, 'Lol ABC234')

    expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('data-value', 'ABC234')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('what extraction deliberately declines', () => {
  it('does not rescue a seven-character code out of prose', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    // `ABC2345` is one seven-run, not a six-run, so extraction declines and the
    // cap runs on the whole normalised string — the pre-PER-242 outcome,
    // overflow note included.
    //
    // This is the case that fails loudly if extraction is ever rewritten as a
    // substring search: that version finds `ABC234` inside `ABC2345`, returns
    // it, suppresses the alert, and reports a typo as a success. The matching
    // case in `join-code-overflow.test.tsx` covers the same hole for a bare
    // `ABC2345` with no prose around it.
    await pasteInto(user, 'Code: ABC2345')

    const input = screen.getByTestId(testIds.joinCodeInput)
    expect(input).toHaveAttribute('data-value', 'CDEABC')
    expect(screen.getByRole('alert')).toHaveTextContent(OVERFLOW)
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('does not guess between two six-character runs', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<JoinByCodeForm onJoin={onJoin} />)

    // `SECRET` is six alphabet characters — no `0 1 I L O` in it — so this paste
    // carries two six-runs and nothing distinguishes them. Returning either
    // would present a coin flip as certainty, so extraction declines and the cap
    // keeps the first six and says it dropped something.
    await pasteInto(user, 'Secret code ABC234')

    const input = screen.getByTestId(testIds.joinCodeInput)
    expect(input).toHaveAttribute('data-value', 'SECRET')
    expect(screen.getByRole('alert')).toHaveTextContent(OVERFLOW)

    // Still not a veto: six canonical characters is a well-formed code and the
    // server owns whether that room exists.
    await user.click(screen.getByTestId(testIds.joinSubmit))
    expect(onJoin).toHaveBeenCalledWith('SECRET')
  })
})
