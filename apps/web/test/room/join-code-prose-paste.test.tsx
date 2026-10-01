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
 * rule **exactly one distinct run of exactly six alphabet characters**
 * (`extractRoomCode`). Every row below yields `ABC234` and says nothing, because
 * `ABC234` is the only six-run present in any of them — `https://` is a
 * five-run, `join/` is `J` then `N`, `Code: ` is `C` then `DE`.
 *
 * Five things this file is really here to hold down, each in its own `describe`
 * below:
 *
 * - Extraction matches **whole runs**, never a substring. A substring search
 *   finds `ABC234` inside `ABC2345` and would silently swallow the dropped-7th
 *   character that `join-code-overflow.test.tsx` exists to report.
 * - The same code written twice — the link-*and*-code message we cause by
 *   handing every host both — is one candidate, not two ([PER-250](/PER/issues/PER-250) B1).
 * - Two *different* six-runs get their own message, not the overflow one, whose
 *   diagnosis is false for them (PER-250 B2).
 * - A six-run of prose beside a code that is not six is taken **silently**, and
 *   that hole is pinned here rather than left for support to find (PER-250 B3).
 * - The "treat `canonical.length > 6` as *not a code* and refuse the press" rule
 *   discussed on PER-197 is still **not** implemented and must not be. The
 *   trailing-prose rows are the guard: they are pastes that join the right room.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { APPROVED_NAME, isValidRoomCode } from '@playhall/shared'

import { JoinByCodeForm } from '@/components/room'
import { testIds } from '@/lib/testids'

const OVERFLOW = /extra characters were not used/i
const AMBIGUOUS = /more than one 6-character code/i

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

  it('does not guess between two different six-character runs', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<JoinByCodeForm onJoin={onJoin} />)

    // `SECRET` is six alphabet characters — no `0 1 I L O` in it — so this paste
    // carries two six-runs and nothing distinguishes them. Returning either
    // would present a coin flip as certainty, so extraction declines and the cap
    // keeps the first six.
    await pasteInto(user, 'Secret code ABC234')

    const input = screen.getByTestId(testIds.joinCodeInput)
    expect(input).toHaveAttribute('data-value', 'SECRET')

    // Still not a veto: six canonical characters is a well-formed code and the
    // server owns whether that room exists.
    await user.click(screen.getByTestId(testIds.joinSubmit))
    expect(onJoin).toHaveBeenCalledWith('SECRET')
  })
})

describe('ambiguity gets its own message, not the overflow one', () => {
  // PER-250 call 3 / B2. Both outcomes used to share one string, and for this
  // one that string's diagnosis is false: nothing was "extra", the field picked
  // the wrong one of two candidates, and "check the code you were sent" asks the
  // player to verify a value we chose rather than to supply the one we could
  // not. The two must not be interchangeable — asserting the ambiguous copy is
  // present is not enough on its own, because the overflow copy would also be
  // present if the precedence were wrong, so each case denies the other string.
  it('says which problem it has when two different six-runs arrive', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'Secret code ABC234')

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(AMBIGUOUS)
    expect(alert).not.toHaveTextContent(OVERFLOW)

    // A paste with two six-runs is always over six canonical characters too, so
    // this is a precedence assertion as much as a copy one.
    const input = screen.getByTestId(testIds.joinCodeInput)
    expect(input).toHaveAttribute('aria-describedby', alert.id)
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('keeps the overflow copy for a plain overflow', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    // One seven-run, no second candidate. Unchanged by PER-250.
    await pasteInto(user, 'Code: ABC2345')

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(OVERFLOW)
    expect(alert).not.toHaveTextContent(AMBIGUOUS)
  })

  it('clears the ambiguity note once the paste is replaced by a code', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'Secret code ABC234')
    expect(screen.getByRole('alert')).toHaveTextContent(AMBIGUOUS)

    await user.clear(screen.getByTestId(testIds.joinCodeInput))
    await user.paste('ABC234')

    expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('data-value', 'ABC234')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('yields the alert node to a server error, like the overflow note does', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} error="That room has closed." />)

    await pasteInto(user, 'Secret code ABC234')

    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent('That room has closed.')
  })
})

describe('the same code twice is one candidate, not two', () => {
  /**
   * PER-250 B1. Every lobby hands its host **both** a link and a code, so a
   * message carrying the code twice is a shape the product itself produces —
   * and counting runs rather than distinct values made it the one invite shape
   * that still lost to the cap. `was` is the measured before-dedupe outcome;
   * the first two are well-formed codes that are not the real one, and the
   * third landed the right code under a false alarm. All three were silent
   * about being wrong, or wrong about being worth saying.
   *
   * The first row reads the brand from `APPROVED_NAME` rather than spelling it:
   * the link-and-code message is ours, so the host in it is ours too, and a
   * rename that broke the rule must fail here rather than against a stand-in.
   */
  const DOUBLED = [
    {
      raw: `Here's the link https://${APPROVED_NAME.toLowerCase()}.gg/join/ABC234 — code is ABC234`,
      was: 'HEREST',
    },
    // Single-line on purpose. The two-line form of this message is pinned in
    // `room-code.test.ts`; here it would not test the dedupe at all, because
    // pasting it into an `<input>` folds the lines together and `ABC234Code`
    // becomes one seven-run, leaving only one six-run to find.
    { raw: 'https://example.test/join/ABC234 — Code: ABC234', was: 'HTTPSE' },
    { raw: 'ABC234 — https://example.test/join/ABC234', was: 'ABC234' },
  ] as const

  for (const { raw, was } of DOUBLED) {
    it(`extracts the code from ${JSON.stringify(raw)}`, async () => {
      const user = userEvent.setup()
      const onJoin = vi.fn()
      render(<JoinByCodeForm onJoin={onJoin} />)

      await pasteInto(user, raw)

      const input = screen.getByTestId(testIds.joinCodeInput)
      expect(input).toHaveAttribute('data-value', 'ABC234')
      expect(isValidRoomCode(was)).toBe(true)

      // Silent: the same code said twice is not two candidates, so there is
      // nothing to be ambiguous about and nothing the player needed was lost.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      await user.click(screen.getByTestId(testIds.joinSubmit))
      expect(onJoin).toHaveBeenCalledWith('ABC234')
    })
  }
})

describe('the family extraction is silently wrong about', () => {
  /**
   * PER-250 B3, pinned rather than fixed. A six-letter word of prose standing
   * next to a code that is **not** six is the only six-run present, so
   * extraction takes the prose confidently and the field says nothing — where
   * before PER-242 the cap landed the same wrong value but at least announced a
   * loss. For this family the residual risk is *larger*, which is why neither
   * this file nor `room-code.ts` claims otherwise any more.
   *
   * `packages/shared/test/room-code.test.ts` carries the rest of the family and
   * the measurement that rejects both candidate fixes (each costs a common
   * paste — `?utm_source=whatsapp`, and every `https://` link — to rescue a rare
   * one). This row is here because the *silence* is a component behaviour: the
   * rule alone cannot show that nothing is announced.
   */
  it('takes SECRET from "Secret code ABC2345" and says nothing', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await pasteInto(user, 'Secret code ABC2345')

    const input = screen.getByTestId(testIds.joinCodeInput)
    expect(input).toHaveAttribute('data-value', 'SECRET')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(input).not.toHaveAttribute('aria-invalid')

    await user.click(screen.getByTestId(testIds.joinSubmit))
    expect(onJoin).toHaveBeenCalledWith('SECRET')
  })
})
