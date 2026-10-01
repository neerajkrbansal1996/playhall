import { expect, test, type Locator, type Page } from '@playwright/test'

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
 * `aria-describedby` is a space-separated **list** of ids, and the join field
 * uses two of them: the always-present hint, then the message when there is
 * one. Splitting is not a detail — `[id="${attr}"]` against the raw attribute
 * matches nothing at all once a second id appears, which is a silent miss
 * rather than a failure if the assertion is only `toBeVisible`.
 *
 * The expected count is an argument rather than a separate `toHaveLength` at
 * the call site, so asserting the count and narrowing the result are one fact.
 * Under `noUncheckedIndexedAccess` a `readonly string[]` indexes as
 * `string | undefined`, and a `toHaveLength` in the spec does not narrow it —
 * returning a fixed-length tuple is what lets `ids[0]` be a `string`.
 */
async function describedByIds(input: Locator, expected: 1): Promise<readonly [string]>
async function describedByIds(input: Locator, expected: 2): Promise<readonly [string, string]>
async function describedByIds(input: Locator, expected: number): Promise<readonly string[]> {
  const attr = await input.getAttribute('aria-describedby')
  expect(attr, 'aria-describedby on the join input').toBeTruthy()
  const ids = (attr ?? '').split(/\s+/).filter((id) => id.length > 0)
  expect(ids, `aria-describedby names ${expected} id(s)`).toHaveLength(expected)
  return ids
}

/**
 * An `[id="…"]` selector rather than `#…`: React's `useId` emits ids containing
 * `«»`, which are not valid in a CSS id selector, and `CSS.escape` is a browser
 * API unavailable in the Node-side spec.
 */
function byId(page: Page, id: string) {
  return page.locator(`[id="${id}"]`)
}

/**
 * A **typed** code is normalised keystroke by keystroke.
 *
 * Asserted separately from the bulk-insertion path below because the two are
 * different code paths through the same handler, and they have already diverged
 * once: a typed separator is stripped as it arrives, so the value never grew
 * past six and [PER-197](/PER/issues/PER-197) was invisible here while every
 * pasted shape was broken.
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

/** A clean 6-character paste was never affected — isolates the shapes below to the cap. */
test('a clean pasted code is accepted as-is', async ({ page }) => {
  const input = page.getByTestId(testIds.joinCodeInput)

  await input.fill('abc234')

  await expect(input).toHaveValue(PREVIEW_CODE)
})

/**
 * Bulk-insertion shapes that all carry the canonical code `ABC234` and nothing
 * else, paired with what the field used to hold before
 * [PER-197](/PER/issues/PER-197) was fixed.
 *
 * Every one of these normalises to exactly `ABC234` once normalisation runs
 * before the length cap, so there is no judgement call in any row. `was` is kept
 * from the red version of this table rather than deleted: it is measured, not
 * predicted, and it is what makes the failure message name the severity instead
 * of only the mismatch. The loss was never a uniform one character.
 *
 * Measured identically on Chromium and WebKit, and identically via
 * `locator.fill()` and `keyboard.insertText()` (see the note on `fill` below).
 */
const PASTE_SHAPES = [
  // The original report: a space between the letter and digit groups.
  { raw: 'abc 234', was: 'ABC23' },
  // The hyphen form, the other shape `JoinByCodeForm`'s doc comment promises.
  { raw: 'ABC-234', was: 'ABC23' },
  // A *clean* code with one leading space — no separator anywhere, still broken.
  { raw: ' abc234', was: 'ABC23' },
  // Double-tap-to-select on iOS and Android routinely grabs the surrounding
  // spaces, so this is a likelier shape than the bare 7-character ones above.
  { raw: '  abc-234  ', was: 'ABC' },
  // Six characters of leading whitespace — an indented or quoted chat line —
  // consumed the entire cap and left the field **empty**.
  { raw: '      abc234', was: '' },
] as const

/**
 * A bulk-inserted code is normalised, not truncated.
 *
 * This table was born red, as five `test.fail()` cases. It used to be that
 * `maxLength={ROOM_CODE_LENGTH}` on the input was enforced by the browser on the
 * **raw** inserted string, before React's `onChange` could strip anything — so
 * the field kept only the canonical characters among the *first six raw*
 * characters, and the damage scaled with how much non-canonical text preceded
 * the code rather than being a fixed off-by-one: `abc 234` landed as `ABC23`,
 * `  abc-234  ` as `ABC`, and `      abc234` as the empty string. None of it was
 * announced, so a player saw a plausible-looking short code and the friendly
 * not-found path, with nothing connecting either to their paste.
 *
 * The cap now runs inside `onChange`, after `normalizeRoomCode`. The `maxLength`
 * rationale — "a 7th character is never part of a code" — was only ever true of
 * *canonical* characters, and that half still holds: see
 * `a bulk-inserted over-long code is capped` below, which pins it.
 *
 * Keep all five shapes rather than collapsing them into one case. A fix written
 * against the seven-character examples alone would turn a combined test green
 * while the leading-whitespace shapes stayed broken, and a later refactor can
 * reintroduce exactly that asymmetry.
 *
 * ## Why `fill()` is a fair model of a paste
 *
 * `locator.fill()` is not a clipboard operation — no spec in this suite reads or
 * writes the real clipboard, because granting clipboard permission is
 * Chromium-only and would cost the WebKit half of the matrix. It is a fair model
 * anyway, and that was measured rather than assumed: every shape above produced
 * a byte-identical result under `page.keyboard.insertText()`, which is the same
 * single-operation insertion path the browser uses for a paste and which honours
 * `maxLength` natively. Both engines agree with each other too. A real
 * clipboard paste remains unverified, and is noted as such in the M2 report.
 */
for (const { raw, was } of PASTE_SHAPES) {
  test(`a bulk-inserted ${JSON.stringify(raw)} is normalised to the code`, async ({ page }) => {
    const input = page.getByTestId(testIds.joinCodeInput)

    await input.fill(raw)

    await expect(
      input,
      `${JSON.stringify(raw)} must normalise to ${PREVIEW_CODE}; before PER-197 it landed as ${JSON.stringify(was)}`,
    ).toHaveValue(PREVIEW_CODE)
    // The state behind the field, not just the `uppercase`-transformed render: a
    // CSS transform can make a wrong value look right in a screenshot.
    await expect(input).toHaveAttribute('data-value', PREVIEW_CODE)
  })
}

/**
 * The length cap survived the move out of `maxLength`.
 *
 * Dropping `maxLength` is half of the PER-197 fix; the other half is
 * `.slice(0, ROOM_CODE_LENGTH)` in `onChange`, and without this case that half
 * could be deleted with every test above still green. A 7th *canonical*
 * character genuinely is never part of a code, so it must still be dropped —
 * that is the part of the old rationale which was right.
 */
test('a bulk-inserted over-long code is capped, not just normalised', async ({ page }) => {
  const input = page.getByTestId(testIds.joinCodeInput)

  await input.fill('abc234xyz')

  await expect(input).toHaveValue(PREVIEW_CODE)
  await expect(input).toHaveAttribute('data-value', PREVIEW_CODE)
})

/**
 * The 7th canonical keystroke on an already-full field — the one path React does
 * not re-render for.
 *
 * Every other case here moves the state, so React rewrites the DOM node the
 * ordinary way and nothing subtle is being exercised. This one does not:
 * `normalizeRoomCode('ABC2345').slice(0, 6)` returns `ABC234`, which is what
 * state already holds, so React bails out of rendering entirely and only
 * react-dom's `restoreControlledState` pulls the input element back to six
 * characters.
 *
 * It needs its own case because the fix is what made it reachable. Under
 * `maxLength` the DOM could never hold a seventh character in the first place,
 * so the bail-out never had anything to undo; removing the attribute moves that
 * correctness onto a react-dom implementation detail. If that restore ever stops
 * covering us, this is the only test that would notice — the field would show
 * `ABC2345` while `data-value` still read `ABC234`, which is precisely the
 * "visible value and request disagree" failure `JoinByCodeForm` exists to
 * prevent. Asserting both is the point; either alone would pass.
 *
 * This case was written while the drop was deliberately silent, and said so —
 * with the note that if it were ever announced it would gain an assertion rather
 * than lose one. [PER-214](/PER/issues/PER-214) announced it, so that is what
 * happened below.
 *
 * The assertions are deliberately about the *wiring* and not the wording. The
 * string is pinned exactly once, in `apps/web/test/room/testids.test.tsx`; a
 * browser test that has to be edited for a copy change is a test nobody will
 * keep honest. What must not regress is that something is announced at all, and
 * that a screen reader can associate it with the field.
 */
test('a 7th canonical keystroke on a full field is dropped without desyncing', async ({ page }) => {
  const input = page.getByTestId(testIds.joinCodeInput)

  await input.fill(PREVIEW_CODE)
  await expect(input).toHaveValue(PREVIEW_CODE)
  // Six characters is not an overflow, so nothing may be announced yet. Without
  // this the assertions below would also pass against an alert left over from an
  // earlier interaction — and the describedby list is the hint alone.
  await expect(joinAlert(page)).toHaveCount(0)
  await describedByIds(input, 1)

  // Typed, not filled: `fill()` replaces the value in one operation and would
  // never produce the already-at-the-cap transition this is about.
  await input.pressSequentially('5')

  await expect(input).toHaveValue(PREVIEW_CODE)
  await expect(input).toHaveAttribute('data-value', PREVIEW_CODE)

  // The announcement, in a real browser: the bail-out path still reaches the
  // player. Fires on input here, with no press — the typed-path counterpart of
  // `apps/web/test/room/join-code-overflow.test.tsx`.
  await expect(joinAlert(page)).toBeVisible()
  await expect(input).toHaveAttribute('aria-invalid', 'true')

  // Through `describedByIds`, not the raw attribute: the hint makes this a
  // two-id list, so `[id="${attr}"]` would match nothing and `toBeVisible`
  // would never be reached to notice. Hint first, then the message, same order
  // as the short-code case and as `fieldIds()` in the settings form.
  //
  // The second id is asserted to *be* the alert's id, not to resolve to a node
  // with the alert's text: two separate elements rendering the same sentence
  // satisfy a text comparison while the field describes the wrong one. This is
  // the identity `apps/web/test/room/join-code-overflow.test.tsx` pins with
  // `expect(messageId).toBe(alert.id)`, now pinned in a real browser too.
  //
  // The count is not redundant with the identity, and it is the one thing the
  // text comparison carried that identity does not. `aria-describedby` resolves
  // through `getElementById`, which takes the **first** node in document order,
  // so a duplicate id leaves the alert holding the named id while a different
  // element is what assistive technology actually reads — a tree the identity
  // assertion alone passes. The old text comparison failed it, but only
  // incidentally, as a strict-mode violation on a two-element locator. Saying
  // it out loud keeps the catch and reports it as `Expected 1, Received 2`.
  const [hintRef, messageRef] = await describedByIds(input, 2)
  await expect(byId(page, hintRef)).toHaveText(/Codes never use/)
  await expect(byId(page, messageRef), 'exactly one node carries the described id').toHaveCount(1)
  await expect(joinAlert(page)).toHaveAttribute('id', messageRef)
})

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

  // The hint describes the field before anything has gone wrong, and keeps
  // describing it afterwards — so `aria-describedby` is a *list*, and reading
  // it as a single id silently stops resolving the moment a message appears.
  // Resting, that list is the hint alone.
  const [restingId] = await describedByIds(input, 1)
  await expect(byId(page, restingId)).toHaveText(/Codes never use/)

  await input.fill('ABC')
  // Nothing may be announced before the player has actually pressed join.
  await expect(joinAlert(page)).toHaveCount(0)

  await submit.click()

  await expect(submit).toBeEnabled()
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await expect(joinAlert(page)).toBeVisible()

  // The wiring, not just the presence: `aria-describedby` must name the element
  // that is actually showing the message, and must still name the hint — in
  // that order, matching `fieldIds()` in the settings form. Identity plus a
  // uniqueness count, not text, for the two reasons given on the overflow case
  // above.
  const [hintRef, messageRef] = await describedByIds(input, 2)
  await expect(byId(page, hintRef)).toHaveText(/Codes never use/)
  await expect(byId(page, messageRef), 'exactly one node carries the described id').toHaveCount(1)
  await expect(joinAlert(page)).toHaveAttribute('id', messageRef)
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
