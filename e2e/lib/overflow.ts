/**
 * Horizontal-overflow measurement, run inside the page.
 *
 * Mobile-first is a product principle, but until this landed nothing in the test
 * suite could see a layout: jsdom does not lay out, so `getBoundingClientRect()`
 * is all zeroes and every width assertion in `apps/web/test/**` is vacuous
 * against geometry.
 *
 * The lesson that produced this file is [PER-121](/PER/issues/PER-121): a
 * create-lobby overflow was reported from a screenshot, and the page turned out
 * to be fine. The screenshot came from `chrome --headless --screenshot
 * --window-size=390,844`, which **crops the capture to 390px without laying the
 * page out at 390px** — the page rendered at Chrome's default viewport, `mx-auto`
 * centred a 448px `max-w-md` column inside it, and the crop cut the right side
 * off. It looks exactly like an overflow bug and is not one. So the only
 * trustworthy measurement comes from a real layout viewport, which is what
 * Playwright's `browser.newContext({ viewport })` gives us.
 *
 * The measurement answers the question that settles the argument:
 *
 *   document.documentElement.scrollWidth === document.documentElement.clientWidth
 *
 * and, when that fails, names the elements sticking out so the fix is one read
 * rather than a bisect.
 */

/** One element that crosses a viewport edge. The list is what turns a failure into a fix. */
export interface Offender {
  readonly tag: string
  readonly testId: string | null
  readonly className: string
  readonly text: string
  readonly left: number
  readonly right: number
  /** Which edge it crossed. Reported so a left-edge report is never mistaken for overflow. */
  readonly edge: 'left' | 'right'
}

export interface OverflowMeasurement {
  readonly scrollWidth: number
  readonly clientWidth: number
  readonly offenders: readonly Offender[]
  /** How many elements were measured, so a selector that matched nothing is visible. */
  readonly measured: number
}

/**
 * Sub-pixel layout rounding is not an overflow. Half a pixel of slack is
 * deliberately tight rather than generous: at 320px, one percent is 3.2px, so a
 * tolerance measured in whole pixels would wave through a real regression.
 */
const SLACK_PX = 0.5

/**
 * The in-page measurement. Must stay a self-contained function expression with
 * no closure over module scope — Playwright serialises it to the page, so a
 * reference to `SLACK_PX` here would be `undefined` at runtime.
 */
export function measureOverflow(): OverflowMeasurement {
  const SLACK = 0.5
  const root = document.documentElement
  const limit = root.clientWidth
  const offenders: Offender[] = []
  const elements = document.querySelectorAll('body *')

  for (const el of elements) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue

    /**
     * Tailwind's `sr-only` is a 1x1 box with `margin: -1px` (used today at
     * `apps/web/src/components/settings-form/chip-group-field.tsx`, on every
     * chip's native radio). Nested in a container whose content box starts near
     * x=0 it lands at `left = -1`, which the 0.5px slack alone would flag. A box
     * that is at most one pixel on both axes cannot make the document
     * horizontally scrollable, so it is not an overflow on either edge. This is
     * narrow on purpose: `width <= 1 && height <= 1`, not "small", and not
     * "position: absolute" — a 600px-wide 1px-tall rule sticking out the right
     * edge is real and still reported.
     */
    if (rect.width <= 1 && rect.height <= 1) continue

    const crossesRight = rect.right > limit + SLACK
    /**
     * The left edge needs an opt-out and the right edge does not.
     *
     * Sitting off the left edge is a legitimate, common pattern: a mobile nav
     * drawer parked at `-translate-x-full`, a carousel track, a slide-over. All
     * of them are at `left = -390` on a 390px viewport by design, and none of
     * them makes the page scroll sideways. A gate that goes red on a correct
     * pattern gets waved through, and a waved-through gate is decoration — so
     * the escape hatch is explicit and greppable rather than a widened
     * tolerance. Mark the element, or any ancestor of it, `data-allow-offscreen`.
     *
     * Nothing legitimately sits off the *right* edge: that is what horizontal
     * overflow on a phone actually is, so it has no opt-out.
     */
    const crossesLeft = rect.left < -SLACK && el.closest('[data-allow-offscreen]') === null

    if (!crossesRight && !crossesLeft) continue

    offenders.push({
      tag: el.tagName.toLowerCase(),
      testId: el.getAttribute('data-testid'),
      className: (el.getAttribute('class') ?? '').slice(0, 120),
      text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
      left: Math.round(rect.left * 10) / 10,
      right: Math.round(rect.right * 10) / 10,
      edge: crossesRight ? 'right' : 'left',
    })
  }

  return {
    scrollWidth: root.scrollWidth,
    clientWidth: limit,
    // Ten is enough to see the pattern; a broken layout can produce hundreds and
    // the 200th is never the cause.
    offenders: offenders.slice(0, 10),
    measured: elements.length,
  }
}

/** A one-line, greppable rendering of one offender, for a failure message. */
export function formatOffender(offender: Offender): string {
  const id = offender.testId === null ? '' : ` [data-testid="${offender.testId}"]`
  const text = offender.text === '' ? '' : ` "${offender.text}"`
  return (
    `${offender.edge} edge: <${offender.tag}>${id}` +
    ` left=${offender.left} right=${offender.right}${text}\n` +
    `      class="${offender.className}"`
  )
}

/** The evidence line for a passing measurement, so the log states the number it measured. */
export function formatMeasurement(label: string, measurement: OverflowMeasurement): string {
  return (
    `${label}: scrollWidth=${measurement.scrollWidth} clientWidth=${measurement.clientWidth}` +
    ` elements=${measurement.measured} offenders=${measurement.offenders.length}`
  )
}

export { SLACK_PX }
