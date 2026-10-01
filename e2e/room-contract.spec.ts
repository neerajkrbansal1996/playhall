import { expect, test, type Page } from '@playwright/test'

import { seatTestId, testIds } from '../apps/web/src/lib/testids'

/**
 * The platform room surfaces, verified in a real browser.
 *
 * This is the **consume** side of the M2 E2E observable contract
 * ([PER-28](/PER/issues/PER-28)): the contract names the selectors and the
 * behaviours, `apps/web/src/lib/testids.ts` owns the names, and this spec is
 * what turns the pair into evidence. Until it landed, no browser had ever been
 * driven against this product — every room assertion in the repo lived in jsdom,
 * which does not lay out and does not run WebKit.
 *
 * ## Why it imports the registry instead of writing the strings
 *
 * `../apps/web/src/lib/testids` is imported, not retyped. A string typed by hand
 * in a page and again in a spec drifts, and the spec then goes green matching
 * nothing — the exact failure the registry exists to prevent. Importing it means
 * a rename is a compile error here too (`pnpm typecheck:e2e`), which is the
 * whole point of having one.
 *
 * The import reaches into `apps/web` from a directory that belongs to no
 * workspace package. That is legal: the `boundaries` gate cruises
 * `apps packages games`, so `e2e/` is not a source in the graph, and the target
 * is a dependency-free module of string constants. It is also the only honest
 * option — a copy would be the drift.
 *
 * ## What this does and does not prove
 *
 * It proves the room/seat/presence/join contract renders and behaves on
 * Chromium **and** WebKit, which is where flex min-content sizing and input
 * handling diverge. It is driven by static props, so it proves **nothing** about
 * transport, server authority, clock sync or two-player agreement. AC2 of the M2
 * report stays NOT VERIFIED on the strength of this file: two real clients
 * playing each other needs [PER-20](/PER/issues/PER-20)'s real routes and a
 * lobby protocol. Do not read a green run here as "the room works".
 */

/** The harness route, gated by `NEXT_PUBLIC_ROOM_PREVIEW=1` in `playwright.config.ts`. */
const ROUTE = '/dev/room'

/** The code the preview mounts with, and the one the invite surfaces must agree on. */
const PREVIEW_CODE = 'ABC234'

/**
 * The seats the preview mounts: White connected, Black **dropped**.
 *
 * The initial `disconnected` state is `true`, so the page opens in the
 * mid-reconnect state rather than the happy path. Encoding that here rather than
 * discovering it per-test is what lets the presence test assert a real
 * transition in both directions from one click.
 */
const SEATS = [
  { id: 'w', connected: true },
  { id: 'b', connected: false },
] as const

test.beforeEach(async ({ page }) => {
  const response = await page.goto(ROUTE)

  /**
   * Fail on the 404 rather than on a missing element thirty lines later.
   *
   * `/dev/room` 404s unless `NEXT_PUBLIC_ROOM_PREVIEW=1` was set **at build
   * time**, and it shipped with nothing setting it anywhere in the repo. A spec
   * that skips this check reports "locator resolved to 0 elements", which reads
   * like a selector bug and sends the next person looking in the wrong file.
   */
  expect(
    response?.status(),
    `${ROUTE} did not serve a page — is NEXT_PUBLIC_ROOM_PREVIEW=1 set for the build *and* the server?`,
  ).toBe(200)
})

/**
 * Every fixed room testid resolves to exactly one element.
 *
 * `getByTestId(...)` with a strict-mode assertion is the load-bearing part: a
 * duplicate is as broken as an absence, because the first spec to scope badly
 * throws instead of measuring. The registry's own doc comment flags this as the
 * reason `editSettingsForm` exists as a scoping anchor.
 */
test('every fixed room testid resolves to exactly one element', async ({ page }) => {
  const expected = [
    testIds.roomCode,
    testIds.roomLink,
    testIds.copyRoomLink,
    testIds.joinCodeInput,
    testIds.joinSubmit,
    testIds.spectatorCount,
    ...SEATS.map((seat) => seatTestId(seat.id)),
  ]

  for (const id of expected) {
    await expect(page.getByTestId(id), `testid "${id}"`).toHaveCount(1)
  }
})

/**
 * Share-first: the code and the invite link cannot disagree.
 *
 * Two surfaces render the same room identity, and a link carrying a different
 * code than the one shown next to it is a silent dead end for whoever retypes
 * it. Asserting the link *contains* the displayed code rather than matching a
 * full URL keeps this from breaking when the origin changes.
 */
test('the invite link carries the code the room displays', async ({ page }) => {
  await expect(page.getByTestId(testIds.roomCode)).toHaveText(PREVIEW_CODE)
  await expect(page.getByTestId(testIds.roomLink)).toContainText(PREVIEW_CODE)
})

/**
 * Presence is carried by `data-connected`, and the attribute tracks the state.
 *
 * The disconnect/reconnect scenarios in M3 assert exactly this selector, so the
 * attribute has to be present in **both** states rather than omitted when
 * false — an absent attribute and a disconnected player are indistinguishable
 * to a spec. Both directions are driven from the one toggle so a one-way-only
 * regression cannot hide.
 */
test('seat presence is carried by data-connected in both states', async ({ page }) => {
  for (const seat of SEATS) {
    await expect(page.getByTestId(seatTestId(seat.id))).toHaveAttribute(
      'data-connected',
      String(seat.connected),
    )
  }

  await page.getByTestId('toggle-black-presence').click()

  // Black reconnects; White must not have moved. A toggle that rewrote every
  // seat would pass a check that only looked at the one it clicked.
  await expect(page.getByTestId(seatTestId('b'))).toHaveAttribute('data-connected', 'true')
  await expect(page.getByTestId(seatTestId('w'))).toHaveAttribute('data-connected', 'true')

  await page.getByTestId('toggle-black-presence').click()
  await expect(page.getByTestId(seatTestId('b'))).toHaveAttribute('data-connected', 'false')
})

/**
 * The spectator count's attribute and its text agree.
 *
 * `data-count` exists so a spec does not have to parse "2 spectators" and
 * re-derive the number from a sentence Product Designer is free to reword. That
 * only holds while the two cannot drift, so this asserts both — an attribute
 * that lies is worse than no attribute, because every other spec trusts it.
 */
test('the spectator count attribute agrees with its text', async ({ page }) => {
  const count = page.getByTestId(testIds.spectatorCount)

  await expect(count).toHaveAttribute('data-count', '2')
  await expect(count).toContainText('2')

  await page.getByTestId('toggle-spectators').click()

  await expect(count).toHaveAttribute('data-count', '0')
  await expect(count).toContainText('0')
})

/**
 * The join form's own alert region.
 *
 * Scoped to the form, never `page.getByRole('alert')`: Next.js App Router
 * injects its route announcer as a body-level, **empty** element with
 * `role="alert"` (`#__next-route-announcer__`), so a page-wide alert query is
 * never zero and a `toBeVisible()` on it can pass by matching the announcer
 * instead of the message under test. That cost this spec two red tests on its
 * first run.
 */
function joinAlert(page: Page) {
  return page.locator('form', { has: page.getByTestId(testIds.joinCodeInput) }).getByRole('alert')
}

/**
 * A **typed** code is normalised keystroke by keystroke.
 *
 * This is the path that works, and it is asserted separately from the paste path
 * so the two cannot be confused: normalisation runs in `onChange`, so a typed
 * separator is stripped as it arrives and the value never grows past six
 * characters.
 *
 * Worth running on both engines: this is a controlled input whose value is
 * rewritten inside `onChange`, and `autoCapitalize="characters"` plus the
 * `uppercase` text transform are handled differently by WebKit. `data-value` is
 * asserted alongside the value because a CSS `uppercase` transform can make a
 * lower-cased value *look* right in a screenshot while the state behind it is
 * wrong.
 */
test('a typed code is normalised keystroke by keystroke', async ({ page }) => {
  const input = page.getByTestId(testIds.joinCodeInput)

  await input.pressSequentially('abc 234')

  await expect(input).toHaveValue(PREVIEW_CODE)
  await expect(input).toHaveAttribute('data-value', PREVIEW_CODE)
})

/** A clean 6-character paste is unaffected — isolates the defect below to separators. */
test('a clean pasted code is accepted as-is', async ({ page }) => {
  const input = page.getByTestId(testIds.joinCodeInput)

  await input.fill('abc234')

  await expect(input).toHaveValue(PREVIEW_CODE)
})

/**
 * Bulk-insertion shapes that all carry the canonical code `ABC234` and nothing
 * else, paired with what the field **actually** holds today.
 *
 * Every one of these normalises to exactly `ABC234` if normalisation runs before
 * the length cap, so there is no judgement call in any row: the `expected`
 * column is the only defensible answer for all of them, and `actual` is measured,
 * not predicted. `actual` is recorded here so the *severity* is in the file
 * rather than only in an issue comment — the loss is not a uniform one character.
 *
 * Measured identically on Chromium and WebKit, and identically via
 * `locator.fill()` and `keyboard.insertText()` (see the note on `fill` below).
 */
const PASTE_SHAPES = [
  // The original report: a space between the letter and digit groups.
  { raw: 'abc 234', actual: 'ABC23' },
  // The hyphen form, the other shape `JoinByCodeForm`'s doc comment promises.
  { raw: 'ABC-234', actual: 'ABC23' },
  // A *clean* code with one leading space — no separator anywhere, still broken.
  { raw: ' abc234', actual: 'ABC23' },
  // Double-tap-to-select on iOS and Android routinely grabs the surrounding
  // spaces, so this is a likelier shape than the bare 7-character ones above.
  { raw: '  abc-234  ', actual: 'ABC' },
  // Six characters of leading whitespace — an indented or quoted chat line —
  // consumes the entire cap and the field ends up **empty**.
  { raw: '      abc234', actual: '' },
] as const

/**
 * KNOWN DEFECT — a bulk-inserted code is silently truncated, by one character to all of them.
 *
 * `maxLength={ROOM_CODE_LENGTH}` is enforced by the browser on the **raw**
 * inserted string, before React's `onChange` can strip anything. So the field
 * keeps only the canonical characters among the *first six raw* characters, and
 * the damage scales with how much non-canonical text precedes the code rather
 * than being a fixed off-by-one: `abc 234` lands as `ABC23`, `  abc-234  ` as
 * `ABC`, and `      abc234` as the empty string.
 *
 * `JoinByCodeForm`'s own doc comment claims "a player who pastes `abc 234` or
 * `ABC-234` from a chat message watches it become `ABC234`". Both of its
 * examples are seven raw characters, so neither does. The `maxLength` rationale
 * — "a 7th character is never part of a code" — is only true of *canonical*
 * characters; a 7th raw character routinely is, once a space or hyphen is
 * stripped. `packages/platform-core/src/rooms/join.ts` already trims its input;
 * the server is tolerant and the field in front of it is not, which is why this
 * only ever surfaces as a wrong value in the input.
 *
 * None of it is announced, so a player sees a plausible-looking short code and
 * the friendly not-found path, with nothing to connect either to their paste.
 * That breaks **zero friction** and **share-first** on the primary acquisition
 * path: a code copied out of a chat app on a phone.
 *
 * ## Why `fill()` is a fair model of a paste
 *
 * `locator.fill()` is not a clipboard operation — no spec in this suite reads or
 * writes the real clipboard, because granting clipboard permission is
 * Chromium-only and would cost the WebKit half of the matrix. It is a fair model
 * anyway, and that was measured rather than assumed: every shape above produces
 * a byte-identical result under `page.keyboard.insertText()`, which is the same
 * single-operation insertion path the browser uses for a paste and which honours
 * `maxLength` natively. Both engines agree with each other too. A real
 * clipboard paste remains unverified, and is noted as such in the M2 report.
 *
 * ## Why `test.fail()` and not `skip`
 *
 * Skipping hides it. An expected failure keeps the defect executing on every run
 * and makes Playwright report an error the moment it starts passing — which is
 * the signal that the fix landed. One case per shape, deliberately: a single
 * combined test would go green on a fix that handles the seven-character
 * examples and still leaves the leading-whitespace shapes broken.
 *
 * Tracked as [PER-197](/PER/issues/PER-197) (Frontend Engineer). **Remove these
 * annotations in the same commit as the fix**, so the tests start guarding it.
 */
for (const { raw, actual } of PASTE_SHAPES) {
  test(`a bulk-inserted ${JSON.stringify(raw)} is normalised to the code`, async ({ page }) => {
    test.fail()

    const input = page.getByTestId(testIds.joinCodeInput)

    await input.fill(raw)

    await expect(
      input,
      `${JSON.stringify(raw)} should normalise to ${PREVIEW_CODE}; it currently lands as ${JSON.stringify(actual)}`,
    ).toHaveValue(PREVIEW_CODE)
  })
}

/**
 * A short code is rejected with an announced message, and submit stays enabled.
 *
 * The accessibility claim is the substance here, not the rejection: a disabled
 * control with no explanation is the worst outcome on a phone, because nothing
 * happens on tap and no assistive technology says why. So the button must still
 * be enabled, the message must be in an alert, and it must be wired to the
 * input through `aria-describedby` — a visible message that no screen reader
 * associates with the field is not an accessible error.
 */
test('a short code is rejected accessibly, with submit still enabled', async ({ page }) => {
  const input = page.getByTestId(testIds.joinCodeInput)
  const submit = page.getByTestId(testIds.joinSubmit)

  await input.fill('ABC')
  // Nothing may be announced before the player has actually pressed join.
  await expect(joinAlert(page)).toHaveCount(0)

  await submit.click()

  await expect(submit).toBeEnabled()
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await expect(joinAlert(page)).toBeVisible()

  // The wiring, not just the presence: `aria-describedby` must name the element
  // that is actually showing the message.
  const describedBy = await input.getAttribute('aria-describedby')
  expect(describedBy, 'aria-describedby on the join input').toBeTruthy()
  // An `[id="…"]` selector rather than `#…`: React's `useId` emits ids
  // containing `«»`, which are not valid in a CSS id selector, and `CSS.escape`
  // is a browser API unavailable in the Node-side spec.
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(await joinAlert(page).innerText())
})

/**
 * A server-rejected join is announced the same way as a client-side one.
 *
 * Unknown room, expired room and closed room all arrive as an `error` prop
 * rather than from local validation, and they must not take a different
 * rendering path — a player cannot tell the two apart and should not have to.
 */
test('a server-rejected join is announced', async ({ page }) => {
  await expect(joinAlert(page)).toHaveCount(0)

  await page.getByTestId('toggle-join-error').click()

  await expect(joinAlert(page)).toBeVisible()
  await expect(page.getByTestId(testIds.joinCodeInput)).toHaveAttribute('aria-invalid', 'true')
})
