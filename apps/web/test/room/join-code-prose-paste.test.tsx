/**
 * Pastes that carry **prose**, not just a separator.
 *
 * Provenance, because the file arrives on `main` detached from the branch it was
 * written on: [PER-234](/PER/issues/PER-234) wrote it against
 * [PER-214](/PER/issues/PER-214)'s overflow announcement and it merged into
 * `per-214/join-code-overflow`, never into `main`. That branch was closed
 * unmerged as superseded, so the behaviour these cases exercise reached `main`
 * via [PER-221](/PER/issues/PER-221) instead, with different message copy.
 * [PER-267](/PER/issues/PER-267) is the re-landing, and
 * [PER-268](/PER/issues/PER-268) rebased [PER-242](/PER/issues/PER-242)'s
 * extraction onto it. The shapes below are PER-234's; the copy is PER-221's; the
 * expectations are PER-242's.
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
 * `JNWTH`, five perfectly ordinary code characters. Every `capWouldKeep` value
 * below is a six-character value that `isValidRoomCode` accepts, so the
 * client-side length check never fires and the press always goes through.
 *
 * ## What changed, and why the old expectations are kept as a column
 *
 * PER-234 wrote these rows against "normalise, then cap", under which the kept
 * six were *not the code* for every leading-prose shape — `"Code: ABC234"` →
 * `CDEABC` — and the field's only defence was to announce that it had dropped
 * something. PER-242 put `extractRoomCode` in front of the cap, so the same
 * pastes now yield `ABC234` and say nothing.
 *
 * The old values are still in the table, as `capWouldKeep`, for two reasons that
 * are both about this file's ability to fail:
 *
 * - They are the **regression target**. Asserting only `data-value === 'ABC234'`
 *   passes if extraction silently stops working *and* the paste happens to be a
 *   bare code. Asserting `not.toBe(capWouldKeep)` as well pins that the thing
 *   under test actually ran: if extraction is removed, every row lands its
 *   `capWouldKeep` value and fails on that assertion specifically.
 * - The self-check below pins that each one is a **valid code**, which is the
 *   fact that made the pre-PER-242 behaviour dangerous rather than merely
 *   untidy, and the reason the bug survived to PER-242 at all. Delete the column
 *   and the next reader cannot tell why extraction was worth building.
 *
 * ## The trailing-prose class is still here, doing a different job
 *
 * `"ABC234 join me"` kept the right code before PER-242 and keeps it now. What
 * changed is that it is no longer warned about — it was a knowingly-accepted
 * false alarm, and extraction removes it. The rows survive because they still
 * guard the thing PER-234 built them to guard: the "treat `canonical.length > 6`
 * as *not a code* and refuse it" rule discussed on PER-197 is **not**
 * implemented and must not be, because it would refuse a paste that joins the
 * right room.
 *
 * [PER-277](/PER/issues/PER-277) is close enough to that rule to be worth telling
 * apart from it. It does empty the field for some over-long input, but only after
 * extraction has already declined — so `"ABC234 join me"` never reaches it — and
 * only when more than one character would be dropped *and* the six kept are
 * stitched out of more than the first run. `ABC2345` fails both tests and keeps
 * PER-214's announcement. One row in this file does reach it, for a reason worth
 * reading: see `'Code: ABC2345'` below.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ROOM_CODE_LENGTH, isValidRoomCode } from '@playhall/shared'

import { JoinByCodeForm } from '@/components/room'
import { testIds } from '@/lib/testids'

/**
 * The overflow message, matched on the clause that tells it apart from the
 * field's other messages rather than in full.
 *
 * `testids.test.tsx` pins the complete literal once, as the copy decision it
 * is. The subject of *this* file is which paste shapes reach that message, so
 * restating the whole sentence in ten places would make a copy edit touch ten
 * assertions that are not about copy — while pinning it no harder, because the
 * single assertion over there fails first either way.
 *
 * What the clause still has to do is separate overflow from everything else the
 * one `role="alert"` node carries, so a regression that swaps one message for
 * another cannot slip through: a server `error`, `Enter the code from your
 * invite.`, `That code has N of 6 characters.` and the ambiguity note all fail
 * this pattern. The length is interpolated rather than typed so that a change to
 * `ROOM_CODE_LENGTH` cannot leave the assertion matching a stale number.
 */
const OVERFLOW = new RegExp(`only the first ${ROOM_CODE_LENGTH} characters were used`, 'i')

/** Click into the field and bulk-insert `text`, the paste-from-chat path. */
async function pasteInto(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByTestId(testIds.joinCodeInput))
  await user.paste(text)
}

/**
 * The ids naming the input's accessible description, in order.
 *
 * Read as a list, not compared against one id: [PER-221](/PER/issues/PER-221)
 * put a permanent hint in front of the message, so `aria-describedby` holds two
 * ids whenever there is a message and
 * `toHaveAttribute('aria-describedby', alert.id)` — what this file asserted
 * when it was written against PER-214 — now fails on *correct* wiring.
 */
function describedByIds(input: HTMLElement): readonly string[] {
  return (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id.length > 0)
}

/**
 * Membership *and* position for the message node's id.
 *
 * The length is half the assertion: with only `ids.includes(alert.id)`, a
 * regression that dropped the hint out of the description would still pass. The
 * message being last is the platform's help-then-error order, which `fieldIds()`
 * in `components/settings-form/field-shell.tsx` sets for every settings field —
 * a `toContain` would accept the two reversed.
 */
function expectDescribedByHintThen(input: HTMLElement, alert: HTMLElement) {
  const ids = describedByIds(input)
  expect(ids).toHaveLength(2)
  expect(ids[1]).toBe(alert.id)
}

afterEach(cleanup)

/**
 * Prose *before* the code. `capWouldKeep` is deliberately spelled out per row
 * rather than computed: the point of the column is that "normalise, then cap"
 * produced a plausible code bearing no resemblance to the one the player was
 * sent, and a computed expectation would restate the implementation instead of
 * pinning that.
 *
 * The invite link is a member of this class and the highest-traffic one — every
 * lobby has a link as well as a code, and "tap the link text, paste it" is at
 * least as common as pasting a sentence. The host is deliberately
 * `example.test`: the product domain is an open board decision and nothing
 * under `apps/web/src` or `packages/shared/src` hard-codes one. Extraction
 * reaches the link without knowing any of that, because `:` and `/` are run
 * boundaries like any other non-alphabet character.
 */
const LEADING_PROSE = [
  { raw: 'Code: ABC234', capWouldKeep: 'CDEABC' },
  { raw: 'your code: ABC234', capWouldKeep: 'YURCDE' },
  { raw: 'join with ABC234', capWouldKeep: 'JNWTHA' },
  { raw: 'Room code is ABC234', capWouldKeep: 'RMCDES' },
  { raw: 'ok ABC234', capWouldKeep: 'KABC23' },
  { raw: 'Join my game: ABC234 - see you there', capWouldKeep: 'JNMYGA' },
  { raw: 'https://example.test/join/ABC234', capWouldKeep: 'HTTPSE' },
] as const

describe('a code pasted with prose in front of it', () => {
  // Hoisted out of the per-row cases below, where it operated only on the
  // table literals and so could not fail for any change to the component.
  // Stated once, as what it is: a property of the fixtures, and the reason the
  // pre-PER-242 silence was dangerous.
  it('is a table of plausible codes, none of which is the real one', () => {
    for (const { capWouldKeep } of LEADING_PROSE) {
      expect(isValidRoomCode(capWouldKeep)).toBe(true)
      expect(capWouldKeep).not.toBe('ABC234')
    }
  })

  for (const { raw, capWouldKeep } of LEADING_PROSE) {
    it(`extracts the code from ${JSON.stringify(raw)}`, async () => {
      const user = userEvent.setup()
      render(<JoinByCodeForm onJoin={vi.fn()} />)

      await pasteInto(user, raw)

      const input = screen.getByTestId(testIds.joinCodeInput)
      expect(input).toHaveAttribute('data-value', 'ABC234')
      // The row's whole reason for existing: the cap's answer was a valid code
      // for a different room. If extraction regresses, this is the assertion
      // that names what went wrong rather than just reporting a mismatch.
      expect(input).not.toHaveAttribute('data-value', capWouldKeep)

      // Nothing the player needed was dropped, so the field says nothing. The
      // hint is still the sole description — one id, not two.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(input).not.toHaveAttribute('aria-invalid')
      expect(describedByIds(input)).toHaveLength(1)
    })
  }

  it('sends the extracted code, not the six the cap would have kept', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await pasteInto(user, 'Code: ABC234')
    await user.click(screen.getByTestId(testIds.joinSubmit))

    expect(onJoin).toHaveBeenCalledWith('ABC234')
    expect(onJoin).not.toHaveBeenCalledWith('CDEABC')
  })
})

describe('a code pasted with prose after it', () => {
  // The kept six ARE the code here, before PER-242 and after it. Pinning the
  // value is what stops a future "canonical.length > 6 means this is not a
  // code, refuse it" rule from regressing a paste that joins the right room.
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

  it('no longer warns, because extraction knows the kept six are the code', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'ABC234 join me')

    // This was PER-234's "knowingly-accepted false alarm": `aria-invalid` and
    // the overflow note sat on a value that joins the right room, because the
    // field could not tell this class from the leading-prose one. Extraction
    // can, so the alarm is gone. Retained as a case because a regression here
    // would be invisible — the value is correct either way.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId(testIds.joinCodeInput)).not.toHaveAttribute('aria-invalid')
  })
})

describe('prose that vanishes into the alphabet', () => {
  it('stays silent when the prose has no in-alphabet characters', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    // `L` and `O` are both excluded from `ROOM_CODE_ALPHABET`, so "Lol "
    // normalises away to nothing and exactly six canonical characters arrive.
    // Nothing was dropped, so there is nothing to announce — the same property
    // the `ABC-234` case pins, reached by a different route. Note this row does
    // not exercise extraction: it passed before PER-242 and passes after.
    await pasteInto(user, 'Lol ABC234')

    expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('data-value', 'ABC234')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('what extraction declines, and whether the cap can salvage it', () => {
  it('does not rescue a seven-character code out of prose', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    // `ABC2345` is one seven-run, not a six-run, so extraction declines. This
    // pairing is the reason the rule matches *whole runs* instead of searching
    // for a six-character substring, which would have found `ABC234` inside
    // `ABC2345` and swallowed exactly the loss PER-214 exists to report.
    //
    // What the field then says changed with [PER-277](/PER/issues/PER-277), and
    // the reason is a fact this case asserted without naming: the cap's answer
    // here was never `ABC234`. `CODE:` contributes `C` and `DE`, so the six kept
    // were `CDEABC` — stitched out of the prose, and nothing to do with the typo
    // the player made. That is the codeless-link family wearing prose, so it gets
    // that family's treatment: the field empties and says there was no code in
    // the paste, rather than claiming six characters of the player's code
    // survived. The row is kept, with `capWouldKeep` spelled out, because it is
    // the one shape in this file that reaches the new branch.
    await pasteInto(user, 'Code: ABC2345')

    const input = screen.getByTestId(testIds.joinCodeInput)
    const alert = screen.getByRole('alert')
    expect(input).toHaveAttribute('data-value', '')
    expect(input).not.toHaveAttribute('data-value', 'CDEABC')
    expect(alert).toHaveTextContent('No room code in that paste.')
    expect(alert).not.toHaveTextContent(OVERFLOW)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expectDescribedByHintThen(input, alert)
  })

  it('still announces a plain over-long paste', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'ABC2345')

    expect(screen.getByTestId(testIds.joinCodeInput)).toHaveAttribute('data-value', 'ABC234')
    expect(screen.getByRole('alert')).toHaveTextContent(OVERFLOW)
  })
})

/**
 * The family extraction is silently wrong about, pinned so it is found by
 * reading the tests rather than rediscovered in support.
 *
 * A six-run can be the wrong six: a word of prose that happens to be six
 * alphabet characters long, standing next to a code that is *not* six. The prose
 * is then the only six-run present, so extraction accepts it confidently and the
 * field says nothing — where before PER-242 the cap landed the same value and at
 * least announced a loss. For this family the risk is **larger** than the one it
 * replaces, not smaller.
 *
 * `room-code.test.ts` carries the measurement that rejects both candidate fixes
 * ("decline when any run is longer than six" throws away
 * `?utm_source=whatsapp`; "decline when some other run is near code length"
 * throws away every `https://` link). This case is the component-level record
 * that the hole is known and accepted, not missed.
 */
describe('the family extraction is silently wrong about', () => {
  it('takes SECRET from "Secret code ABC2345" and says nothing', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'Secret code ABC2345')

    const input = screen.getByTestId(testIds.joinCodeInput)
    expect(input).toHaveAttribute('data-value', 'SECRET')
    // The loss: before PER-242 this said "only the first 6 characters were
    // used", which was at least a signal. Now it is silent.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
