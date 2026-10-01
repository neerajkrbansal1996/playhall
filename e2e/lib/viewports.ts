/** The layout viewports and page states the overflow gate measures. */

export interface Viewport {
  readonly name: string
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor: number
  /**
   * Playwright's `isMobile` switches on the mobile viewport meta handling and
   * the `hover: none` / `pointer: coarse` media queries. It is a device class,
   * not a width — so a tablet-width breakpoint check must not set it, or the
   * measurement is of a layout no real device produces.
   */
  readonly isMobile: boolean
}

/**
 * 320 is the narrowest width we support (iPhone SE, and the WCAG 2.1 1.4.10
 * reflow floor). 360 and 412 are the two commonest Android widths and 390 is
 * the reported iPhone 12–16 width. 768 is the tablet breakpoint — `isMobile`
 * is deliberately `false` there: it is a width check, and flipping
 * pointer/hover on a tablet-width run measures a layout no device renders.
 * 1280 catches a "fix" that works only by making the mobile layout the desktop
 * one too.
 */
export const VIEWPORTS: readonly Viewport[] = [
  { name: '320', width: 320, height: 800, deviceScaleFactor: 2, isMobile: true },
  { name: '360', width: 360, height: 800, deviceScaleFactor: 3, isMobile: true },
  { name: '390', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true },
  { name: '412', width: 412, height: 915, deviceScaleFactor: 2.6, isMobile: true },
  { name: '768', width: 768, height: 1024, deviceScaleFactor: 2, isMobile: false },
  { name: '1280', width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false },
]

/**
 * Look a viewport up by name, failing loudly if it has been renamed or removed.
 *
 * A spec that pinned one of these by index or by a re-`find()` would silently
 * start measuring a different width — or `undefined` — the day the list is
 * reordered. Throwing is the point: a fixture measured at the wrong viewport is
 * worse than a suite that will not start.
 */
export function viewportNamed(name: string): Viewport {
  const found = VIEWPORTS.find((viewport) => viewport.name === name)
  if (found === undefined) {
    throw new Error(
      `no viewport named "${name}" in VIEWPORTS (have: ` +
        `${VIEWPORTS.map((viewport) => viewport.name).join(', ')})`,
    )
  }
  return found
}

/**
 * One interactive state of a route.
 *
 * `proof` is not optional and not decoration. A state is reached by clicking,
 * and a click whose selector silently stops matching after a refactor leaves the
 * suite measuring the default state N times over while staying green — covering
 * nothing, which is how a gate becomes decoration. So every state must name a
 * selector that is present in that state and absent from the page before it, and
 * the spec asserts it is visible before it measures.
 *
 * `click` selectors are CSS, and must never be keyed on user-visible copy:
 * product copy belongs to Product Designer, it will change, and i18n breaks all
 * of it. Use a `data-testid`, a `data-*` contract attribute, or a form value.
 */
export interface RouteState {
  readonly name: string
  readonly proof: string
  /** CSS selector of the element to click to enter this state. Omitted for `default`. */
  readonly click?: string
}

export interface Route {
  readonly name: string
  readonly path: string
  readonly states: readonly RouteState[]
}

export const ROUTES: readonly Route[] = [
  {
    name: 'landing',
    path: '/',
    // The M0 placeholder landing page. It grows real content in M1 (PER-20);
    // this entry is here so that work is measured from its first commit.
    states: [{ name: 'default', proof: 'main h1' }],
  },
  {
    name: 'create-lobby-preview',
    // The create-lobby composition, behind `NEXT_PUBLIC_SETTINGS_FORM_PREVIEW=1`
    // (set by the `webServer` command). The widest content this app renders.
    path: '/dev/settings-form',
    states: [
      { name: 'default', proof: '[data-field-key="timeControl"]' },
      /**
       * The two number fields are `visibleWhen: { field: 'timeControl', equals:
       * ['custom'] }`, so the default state never renders them. The chip's own
       * `<input type="radio">` is `sr-only`, so the click target is its sibling
       * `<label>` — reached through the field's `data-field-key` contract
       * attribute and the radio's `value` token (`s:` prefixes a string option;
       * see `grouping.ts#optionToken`). No English anywhere in the selector.
       */
      {
        name: 'custom-time-control',
        click: '[data-field-key="timeControl"] input[value="s:custom"] + label',
        proof: '[data-field-key="customInitialMinutes"]',
      },
      // A server rejection adds an icon + message row under a field, which is
      // the state most likely to push a field past the right edge at 320.
      {
        name: 'server-error',
        click: '[data-testid="toggle-server-error"]',
        proof: '[data-field-key="timeControl"] [role="alert"]',
      },
      // The widest thing the page can render: a pre-formatted settings JSON blob.
      {
        name: 'submitted',
        click: '[data-testid="create-lobby-submit"]',
        proof: '[data-testid="submitted-settings"]',
      },
    ],
  },
  {
    name: 'room-preview',
    /**
     * The room, seats, presence and join-by-code surfaces, behind
     * `NEXT_PUBLIC_ROOM_PREVIEW=1` (set by the `webServer` command).
     *
     * These are the surfaces every M2 chess E2E scenario passes through before
     * it reaches a board, so they are measured from their first commit rather
     * than when [PER-20](/PER/issues/PER-20) lands the real `/r/[code]`.
     */
    path: '/dev/room',
    states: [
      /**
       * The preview mounts with Black **dropped** (`disconnected` initialises
       * `true`), so the default state is the mid-reconnect one. Pinning
       * `data-connected="false"` here rather than just `[data-testid="seat-b"]`
       * is deliberate: it proves presence is being emitted as the attribute the
       * disconnect scenarios assert on, and it fails if the initial state is
       * ever flipped to the happy path — at which point the state below would
       * silently become a no-op click.
       */
      { name: 'default', proof: '[data-testid="seat-b"][data-connected="false"]' },
      // Presence restored. The seat row swaps icon, word and attribute.
      {
        name: 'black-reconnected',
        click: '[data-testid="toggle-black-presence"]',
        proof: '[data-testid="seat-b"][data-connected="true"]',
      },
      // An empty room: the spectator row re-renders with a different count, and
      // `0 spectators` is the longest of the three strings it can hold.
      {
        name: 'no-spectators',
        click: '[data-testid="toggle-spectators"]',
        proof: '[data-testid="spectator-count"][data-count="0"]',
      },
      /**
       * A rejected join. Adds an icon + message row under the input, the same
       * shape as the create-lobby `server-error` state and for the same reason:
       * it is the row most likely to push the field past the right edge at
       * 320px.
       */
      {
        name: 'join-error',
        click: '[data-testid="toggle-join-error"]',
        proof: '[data-testid="join-code-input"][aria-invalid="true"]',
      },
    ],
  },
]
