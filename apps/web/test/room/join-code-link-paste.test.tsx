/**
 * Pasting an **invite link** into the join-by-code field.
 *
 * The companion to `join-code-prose-paste.test.tsx`, which covers a code wrapped
 * in a sentence. This file covers the share artifact: every lobby hands its host
 * a link *and* a code, so "tap the link text, paste it" is the most likely paste
 * there is, and before [PER-242](/PER/issues/PER-242) it was the one that failed
 * worst — `https://example.test/join/ABC234` left `HTTPSE` in the field, a
 * well-formed code for a different room.
 *
 * ## Provenance, and why this file is not a `readRoomCodeInput` suite
 *
 * The corpus is [PER-235](/PER/issues/PER-235)'s, from PR #130, which read the
 * input **as a URL**: a `URL_IN_TEXT` regex, a scheme branch, a schemeless
 * branch with an `[a-z]{2,}` last-label rule, host-dropping, fragment
 * stripping, a path-segment scan and a query fallback. The
 * [PER-242 ruling](/PER/issues/PER-242) declined that mechanism in favour of
 * "exactly one *distinct* run of exactly six alphabet characters — no URL
 * parsing, no host, no domain constant", because the product name and domain are
 * an open board decision and a rule keyed on URL shape has to be re-litigated
 * when they land.
 *
 * [PER-268](/PER/issues/PER-268) closed #130 and brought its corpus here rather
 * than closing it as redundant, because a closed PR is where coverage goes to die
 * quietly. Every row below was **measured** against the ruled rule, not assumed:
 * the shapes #130 needed a dedicated branch for — schemeless, `www.`, an
 * IP-literal host with a port, a fragment, a trailing full stop, parentheses,
 * surrounding whitespace — all fall out of run-splitting for free, because `:`
 * `/` `.` `#` `?` `=` and space are every one of them a run boundary.
 *
 * Two rows did *not* survive the mechanism swap, and both are pinned below as
 * what they are rather than deleted: the ambiguous-query family, which this
 * branch fixes differently, and the codeless link, which PER-242 did not fix at
 * all and [PER-277](/PER/issues/PER-277) fixes without reading a URL — see that
 * block for the rule and for the two candidate rules it rejects.
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ROOM_CODE_LENGTH, isValidRoomCode } from '@playhall/shared'

import { JoinByCodeForm } from '@/components/room'
import { testIds } from '@/lib/testids'

const OVERFLOW = new RegExp(`only the first ${ROOM_CODE_LENGTH} characters were used`, 'i')
const AMBIGUOUS = new RegExp(`more than one ${ROOM_CODE_LENGTH}-character code`, 'i')
/**
 * Not interpolated, unlike the two above, because the point of this copy is that
 * it does **not** restate the length — the hint above the field already gives it
 * ([PER-225](/PER/issues/PER-225)). `testids.test.tsx` pins the literal in full,
 * as the copy decision it is.
 */
const NO_ROOM_CODE = /no room code in that paste/i

async function pasteInto(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByTestId(testIds.joinCodeInput))
  await user.paste(text)
}

function field() {
  return screen.getByTestId(testIds.joinCodeInput)
}

afterEach(cleanup)

/**
 * The hosts here are deliberately mixed — `playhall.app`, `example.test`,
 * `staging.playhall.app`, `127.0.0.1:3000`. The rule reads none of them, so the
 * variety is the assertion: a row that passes for `playhall.app` and fails for
 * `example.test` would mean a domain had been hard-coded somewhere, which
 * `brand.ts` and the open naming decision forbid.
 *
 * `/r/` and `/join/` are both present for the same reason. `/r/[code]` is the
 * universal room link in the routing spec and is not built yet; the rule is
 * keyed on neither.
 */
const LINKS_YIELDING_THE_CODE = [
  'https://playhall.app/r/ABC234',
  'https://playhall.app/join/ABC234',
  'http://playhall.app/r/ABC234',
  // Lower-cased by a chat app that normalises URLs.
  'https://playhall.app/r/abc234',
  // Schemeless, the form a chat app shows after it strips `https://`. #130
  // needed an `[a-z]{2,}` last-label rule to reach this; run-splitting does not
  // know it is a URL at all.
  'playhall.app/r/ABC234',
  'www.playhall.app/r/ABC234',
  'https://staging.playhall.app/r/ABC234',
  // A campaign parameter survives because `WHATSAPP` is an eight-run, not a
  // six-run. This is the row that rules out "decline when any run is longer than
  // six" as a fix for the SECRET family — see `room-code-extract.test.ts`.
  'https://playhall.app/r/ABC234?utm_source=whatsapp',
  'https://playhall.app/r/ABC234#seat=w',
  'https://playhall.app/r/ABC234/',
  'playhall.app/r/ABC234#x',
  'playhall.app/r/ABC234?utm_source=whatsapp',
  // A schemed IP-literal host with a port: the dev-server and LAN-invite shape.
  // `127` is `27` to the alphabet (`1` is excluded) and `3000` is `3`, so no run
  // here comes near six.
  'http://127.0.0.1:3000/r/ABC234',
  // The shapes a chat app actually delivers: a sentence around the link, the
  // full stop that ends it glued to the last segment, and the brackets and
  // whitespace a double-tap selection picks up on a phone.
  'Join: https://playhall.app/r/ABC234',
  'come play https://playhall.app/r/ABC234 now',
  'Priya invited you — https://playhall.app/r/ABC234.',
  '(https://playhall.app/r/ABC234)',
  '  https://playhall.app/r/ABC234  ',
  // The code as a query value rather than a path segment. #130 needed an
  // explicit query fallback for this; here it is just another run.
  'https://playhall.app/join?code=ABC234',
  'https://example.test/r/ABC234',
] as const

describe('an invite link gives up its code', () => {
  for (const raw of LINKS_YIELDING_THE_CODE) {
    it(`extracts ABC234 from ${JSON.stringify(raw)}`, async () => {
      const user = userEvent.setup()
      const onJoin = vi.fn()
      render(<JoinByCodeForm onJoin={onJoin} />)

      await pasteInto(user, raw)

      expect(field()).toHaveAttribute('data-value', 'ABC234')
      // Silent: nothing the player needed was dropped, so the overflow note
      // would be a false alarm on the product's primary share artifact.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(field()).not.toHaveAttribute('aria-invalid')

      await user.click(screen.getByTestId(testIds.joinSubmit))
      expect(onJoin).toHaveBeenCalledWith('ABC234')
    })
  }

  it('reads no domain, which is what keeps the naming decision open', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    // A host nobody will ever ship. If any part of the pipeline grew a domain
    // constant or a host allowlist, this is the row that fails while every
    // `playhall.app` row above keeps passing.
    await pasteInto(user, 'https://zzz.invalid/r/ABC234')

    expect(field()).toHaveAttribute('data-value', 'ABC234')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('treats the link-plus-code message a host sends as one candidate', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    // The shape the product itself causes, by handing every host both a link and
    // a code. Counting *runs* would see two candidates and fall to the cap; the
    // rule counts distinct runs, so the same code said twice is one candidate.
    await pasteInto(user, "here's the link https://playhall.app/r/ABC234 — code is ABC234")

    expect(field()).toHaveAttribute('data-value', 'ABC234')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

/**
 * A link carrying a **second** six-character value — a `?ref=`, a share token, a
 * campaign id. [PER-250](/PER/issues/PER-250)'s ambiguity outcome, reached by the
 * shape that makes it matter rather than by a synthetic two-code string.
 *
 * #130 resolved this by reading the path before the query, which is only
 * available to a rule that knows what a path is. The ruled rule cannot order the
 * candidates, so it declines to choose and says so — but it shows `codes[0]`
 * rather than the cap's answer, which here is `HTTPSP`: scheme noise, not a
 * candidate at all, and not a value the player has ever seen. The two mechanisms
 * therefore agree on the value and differ only in whether the field admits it
 * could not choose.
 */
describe('a link with a second six-character value in the query', () => {
  const AMBIGUOUS_LINKS = [
    'https://playhall.app/r/ABC234?ref=XYZ789',
    'https://example.test/r/ABC234?ref=XYZ789',
  ] as const

  for (const raw of AMBIGUOUS_LINKS) {
    it(`shows the path's code and says it could not choose for ${JSON.stringify(raw)}`, async () => {
      const user = userEvent.setup()
      render(<JoinByCodeForm onJoin={vi.fn()} />)

      await pasteInto(user, raw)

      expect(field()).toHaveAttribute('data-value', 'ABC234')
      // The regression this file exists to prevent: the cap's answer is a
      // well-formed code with no relationship to anything pasted. If the
      // ambiguous branch is removed and this falls through to the cap, the
      // value becomes `HTTPSP` and this assertion names why that is wrong.
      expect(field()).not.toHaveAttribute('data-value', 'HTTPSP')

      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent(AMBIGUOUS)
      // Not the overflow copy. "Check the code you were sent" asks the player to
      // verify a value we picked; the right instruction is to supply the one we
      // could not pick.
      expect(alert).not.toHaveTextContent(OVERFLOW)
      expect(field()).toHaveAttribute('aria-invalid', 'true')
    })
  }

  it('is not ambiguous when the query repeats the same code', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'https://playhall.app/r/ABC234?s=ABC234')

    expect(field()).toHaveAttribute('data-value', 'ABC234')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears the ambiguity note once the paste is replaced by a code', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'https://playhall.app/r/ABC234?ref=XYZ789')
    expect(screen.getByRole('alert')).toHaveTextContent(AMBIGUOUS)

    await user.clear(field())
    await user.paste('ABC234')

    expect(field()).toHaveAttribute('data-value', 'ABC234')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('yields the alert node to a server error, like the overflow note does', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} error="That room has closed." />)

    await pasteInto(user, 'https://playhall.app/r/ABC234?ref=XYZ789')

    // One message slot, and an actual join outcome outranks our note about the
    // input. Pinned here as well as for overflow because the ambiguity branch
    // was added after that ordering was established.
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('That room has closed.')
    expect(alert).not.toHaveTextContent(AMBIGUOUS)
  })
})

/**
 * A link with **no room code in it** empties the field
 * ([PER-277](/PER/issues/PER-277)).
 *
 * No six-run means no candidate, so extraction declines and the caller's
 * fallback — normalise, then keep six — runs on the whole URL. For a schemed
 * link that is always the scheme plus one character, whatever the host, because
 * `HTTPS` is a five-run: `HTTPSP`. A value `isValidRoomCode` accepts, so nothing
 * downstream could tell it was not a code, and not a thing the player ever saw.
 *
 * This was never the silent-wrong-value class PER-242 fixed — the overflow note
 * fired, so the field said *something*. The defect was what it said. "Only the
 * first 6 characters were used. Check the code you were sent." is a true sentence
 * that does not describe what happened: nothing they were sent was used, and
 * there is no code in that link to check.
 *
 * ## Why this is not the URL parsing the ruling declined
 *
 * #130 cleared the field for this family by reading the input as a URL, which
 * the [PER-242 ruling](/PER/issues/PER-242) declined: the product name and
 * domain are an open board decision and a rule keyed on URL shape must be
 * re-litigated when they land. `capWouldKeepNoise` asks a different question —
 * **was more than one character discarded, and are the six kept stitched out of
 * more than the first run?** — and so reads no scheme, no host and no path. It
 * reaches `www.playhall.app`, which has neither a scheme nor a slash, and it
 * reaches `Code: ABC2345`, which is not a link at all.
 *
 * Both of PER-277's own ideas were measured over this corpus and lost. "Clear
 * when there is no run of 4-6 characters" misses **every** row below, because
 * `HTTPS` is a five-run and `PLAYHALL` shatters into `P` + `AYHA` on its two
 * `L`s. "Clear when the input contains `://`" misses `www.playhall.app`. The
 * scoring is in `packages/shared/test/room-code-extract.test.ts`, which also pins
 * the rows the rule must *not* fire on — `ABC2345`, `ABC23456`, `ABC-2345` — each
 * of which exists to defend one of the two clauses.
 */
describe('a link with no room code in it', () => {
  /**
   * `capKeeps` is what the field used to hold, kept as a column for the same
   * reason `join-code-prose-paste.test.tsx` keeps its `capWouldKeep`: it is the
   * regression target. Asserting an empty field alone would pass if the whole
   * paste path broke; asserting the field is *not* this specific valid-looking
   * code is what fails loudly when the fallback starts running again.
   */
  const NO_CODE = [
    { raw: 'https://playhall.app', capKeeps: 'HTTPSP' },
    { raw: 'https://playhall.app/', capKeeps: 'HTTPSP' },
    { raw: 'https://playhall.app/play/chess', capKeeps: 'HTTPSP' },
    { raw: 'https://playhall.app/r/ABC23', capKeeps: 'HTTPSP' },
    { raw: 'https://playhall.app/r/ABC2345', capKeeps: 'HTTPSP' },
    { raw: 'www.playhall.app', capKeeps: 'WWWPAY' },
    { raw: 'https://example.com/some/article', capKeeps: 'HTTPSE' },
  ] as const

  it('is a table of values that all pass the length check', () => {
    // The property that made this family a real defect rather than cosmetic,
    // asserted on the fixtures once instead of restated per row. It is also why
    // the column cannot be replaced by `expect(field()).toHaveValue('')`: these
    // are the values a regression would show, and they look fine.
    for (const { capKeeps } of NO_CODE) expect(isValidRoomCode(capKeeps)).toBe(true)
  })

  for (const { raw, capKeeps } of NO_CODE) {
    it(`empties the field rather than keeping ${capKeeps} for ${JSON.stringify(raw)}`, async () => {
      const user = userEvent.setup()
      render(<JoinByCodeForm onJoin={vi.fn()} />)

      await pasteInto(user, raw)

      expect(field()).toHaveAttribute('data-value', '')
      expect(field()).not.toHaveAttribute('data-value', capKeeps)

      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent(NO_ROOM_CODE)
      // Not the overflow copy, which is the whole point of the ticket: it asks
      // the player to check a value we assembled out of the scheme.
      expect(alert).not.toHaveTextContent(OVERFLOW)
      expect(field()).toHaveAttribute('aria-invalid', 'true')
    })
  }

  it('does not read a short host as the code either', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    // #130 had a dedicated case for a host short enough to normalise to six
    // characters, because its host-dropping `slice(1)` was the thing under test.
    // Here the host is not special, so the only claim worth pinning is the
    // negative one: the field does not end up holding the host.
    await pasteInto(user, 'https://ab2.cde/play/chess')

    expect(field()).not.toHaveAttribute('data-value', 'AB2CDE')
    expect(field()).toHaveAttribute('data-value', '')
    expect(screen.getByRole('alert')).toHaveTextContent(NO_ROOM_CODE)
  })

  it('refuses the press instead of sending six characters of the URL', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<JoinByCodeForm onJoin={onJoin} />)

    await pasteInto(user, 'https://playhall.app/play/chess')
    await user.click(screen.getByTestId(testIds.joinSubmit))

    // The behaviour change with the most product weight. Before this the press
    // sent `HTTPSP` and spent a round trip landing on the friendly not-found
    // page; an empty value fails `isValidRoomCode`, so there is nothing to ask
    // the server about. Contrast the overflow case, where six canonical
    // characters are a well-formed code and the press is a real join.
    expect(onJoin).not.toHaveBeenCalled()
  })

  it('keeps the reason up across the press instead of swapping in the empty-field copy', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'https://playhall.app/play/chess')
    await user.click(screen.getByTestId(testIds.joinSubmit))

    // Pressing Join on an empty field sets `tooShort`, so both accounts are live
    // and only the ordering in `fieldMessage` decides. *Why* the field is empty
    // is the more useful half, and this is the only state in which the two
    // compete — without it, a reversed precedence would be invisible.
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(NO_ROOM_CODE)
    expect(alert).not.toHaveTextContent('That code has 0 of')
  })

  it('clears the note once a real code is pasted over it', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} />)

    await pasteInto(user, 'https://playhall.app/play/chess')
    expect(screen.getByRole('alert')).toHaveTextContent(NO_ROOM_CODE)

    // The field is already empty, so there is nothing to clear first — which is
    // the tap this fix saves the player, and the reason the state must not be
    // sticky: no keystroke of a six-character code can reach `onChange` with a
    // value this rule fires on.
    await user.paste('ABC234')

    expect(field()).toHaveAttribute('data-value', 'ABC234')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('yields the alert node to a server error, like the other two notes do', async () => {
    const user = userEvent.setup()
    render(<JoinByCodeForm onJoin={vi.fn()} error="That room has closed." />)

    await pasteInto(user, 'https://playhall.app/play/chess')

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('That room has closed.')
    expect(alert).not.toHaveTextContent(NO_ROOM_CODE)
  })
})

/**
 * The guard #130 needed and this rule gets for free. Every row contains a
 * character a loose URL detector fires on — a dot, a slash, a colon — and none
 * is a link. #130 shipped a follow-up commit ("stop a prose decimal reading as
 * an invite link") for exactly the `3.14159` row; run-splitting never had the
 * bug, because it never asks whether the input is a URL.
 */
describe('input that is not a link is unaffected', () => {
  const NOT_LINKS = [
    { raw: 'ABC234', value: 'ABC234', alert: false },
    { raw: 'abc 234', value: 'ABC234', alert: false },
    { raw: 'ABC-234', value: 'ABC234', alert: false },
    { raw: '  abc-234  ', value: 'ABC234', alert: false },
    { raw: 'ABC234.', value: 'ABC234', alert: false },
    // PER-197's shapes keep working, and PER-214's announcement still fires.
    { raw: 'ABC2345', value: 'ABC234', alert: true },
    // A decimal number: four alphabet characters, no six-run, nothing dropped.
    { raw: '3.14159', value: '3459', alert: false },
  ] as const

  for (const { raw, value, alert } of NOT_LINKS) {
    it(`reads ${JSON.stringify(raw)} as ${value}${alert ? ' and warns' : ''}`, async () => {
      const user = userEvent.setup()
      render(<JoinByCodeForm onJoin={vi.fn()} />)

      await pasteInto(user, raw)

      expect(field()).toHaveAttribute('data-value', value)
      if (alert) expect(screen.getByRole('alert')).toHaveTextContent(OVERFLOW)
      else expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  }
})
