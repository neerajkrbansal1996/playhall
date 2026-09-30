import { expect, test, type Browser } from '@playwright/test'

import { measureOverflow } from './lib/overflow'
import { viewportNamed } from './lib/viewports'

/**
 * Tests for the detector itself, against hand-built fixtures.
 *
 * `viewport-overflow.spec.ts` asserts that the app has no overflow. That spec
 * passing tells you nothing unless the detector can actually fail — a check that
 * cannot go red is decoration, and the only way to know is to feed it something
 * that should be red. So these fixtures are served with `page.setContent()`
 * through the same `page.evaluate(measureOverflow)` call the real spec uses; the
 * code path under test is identical, only the DOM is synthetic.
 *
 * Each fixture also pins one of the two false-positive classes the CDP
 * predecessor ([PER-121](/PER/issues/PER-121), PR #60) would have tripped on,
 * so a later "simplification" of the detector cannot quietly reintroduce them.
 */

/** One representative mobile viewport; the detector's behaviour is not width-dependent. */
const MOBILE = viewportNamed('390')

/**
 * `html`/`body` reset so the fixtures measure the box under test, not UA margins.
 *
 * The `<meta name="viewport">` is not boilerplate. Under `isMobile: true` a
 * document without it gets the mobile default **980px** layout viewport, so a
 * 600px child on a 390px device does not overflow and the detector correctly
 * reports nothing. These fixtures failed exactly that way on the first run. The
 * real app ships the tag (`apps/web/src/app/layout.tsx` exports `viewport`), and
 * `viewport-overflow.spec.ts` now asserts the resulting `clientWidth` — because
 * dropping the tag would make the whole gate vacuous rather than red.
 */
const RESET =
  '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
  '<style>*{box-sizing:border-box}html,body{margin:0;padding:0}</style>'

async function measure(
  browser: Browser,
  bodyHtml: string,
): Promise<ReturnType<typeof measureOverflow>> {
  const context = await browser.newContext({
    viewport: { width: MOBILE.width, height: MOBILE.height },
    deviceScaleFactor: MOBILE.deviceScaleFactor,
    isMobile: MOBILE.isMobile,
    hasTouch: MOBILE.isMobile,
  })
  try {
    const page = await context.newPage()
    await page.setContent(`${RESET}${bodyHtml}`, { waitUntil: 'load' })
    return await page.evaluate(measureOverflow)
  } finally {
    await context.close()
  }
}

test('reports a child wider than the viewport, and names it', async ({ browser }) => {
  // The same shape as the manual proof on the real page: a 600px child inside a
  // two-column grid on a 390px viewport.
  const measurement = await measure(
    browser,
    `<section data-testid="quick-start" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
       <button data-testid="preset-a">Preset A</button>
       <button data-testid="overflow-probe" style="width:600px">Preset B</button>
     </section>`,
  )

  expect(measurement.scrollWidth).toBeGreaterThan(measurement.clientWidth)
  const rightEdge = measurement.offenders.filter((offender) => offender.edge === 'right')
  expect(rightEdge.length).toBeGreaterThan(0)
  // Naming the element is the point: a failure that says only "the page is too
  // wide" costs a bisect.
  expect(rightEdge.map((offender) => offender.testId)).toContain('overflow-probe')
})

test('an element parked off the left edge needs the opt-out to pass', async ({ browser }) => {
  /**
   * The false positive the predecessor script had: it flagged any element with
   * `rect.left < -0.5`, which is where a mobile nav drawer at
   * `-translate-x-full`, a carousel track and a slide-over all legitimately sit.
   * A gate that goes red on a correct pattern gets waved through.
   *
   * Both halves are asserted in one test on purpose: an opt-out that is honoured
   * is only interesting if the thing it opts out of is otherwise reported, and
   * splitting them lets one half rot green.
   */
  const drawer = (attribute: string) =>
    `<div ${attribute} data-testid="nav-drawer"
        style="position:fixed;top:0;left:0;width:390px;height:400px;transform:translateX(-100%)">
       <nav data-testid="drawer-nav" style="width:100%;height:100%">Menu</nav>
     </div>
     <main data-testid="page" style="width:100%;height:200px">Page</main>`

  const withOptOut = await measure(browser, drawer('data-allow-offscreen'))
  expect(
    withOptOut.offenders,
    'a drawer marked `data-allow-offscreen` must not fail the gate',
  ).toEqual([])
  expect(withOptOut.scrollWidth).toBe(withOptOut.clientWidth)

  const withoutOptOut = await measure(browser, drawer(''))
  const leftEdge = withoutOptOut.offenders.filter((offender) => offender.edge === 'left')
  expect(
    leftEdge.map((offender) => offender.testId),
    'without the opt-out the same drawer must be reported, or the opt-out is vacuous',
  ).toContain('nav-drawer')
  // The opt-out covers descendants too — a drawer's contents are off-screen for
  // the same reason the drawer is, and marking each child would never happen.
  expect(leftEdge.map((offender) => offender.testId)).toContain('drawer-nav')
})

test("Tailwind's sr-only box is not an overflow on either edge", async ({ browser }) => {
  /**
   * `sr-only` is a 1x1 box with `margin: -1px`, used today on every settings
   * chip's native radio (`chip-group-field.tsx`). Nested in a container whose
   * content box starts at x=0 it lands at `left = -1`, half a pixel outside the
   * predecessor's tolerance — the near-miss that showed the `-0.5` slack was
   * load-bearing rather than arbitrary.
   */
  const measurement = await measure(
    browser,
    `<div style="width:100%">
       <input type="radio" data-testid="sr-only-radio"
         style="position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;
                clip-path:inset(50%);white-space:nowrap;border-width:0;padding:0" />
       <label data-testid="chip" style="display:inline-flex;height:44px">Custom</label>
     </div>`,
  )

  expect(measurement.offenders).toEqual([])
  expect(measurement.scrollWidth).toBe(measurement.clientWidth)
})

test('a 1px-tall rule sticking past the right edge is still an overflow', async ({ browser }) => {
  // The boundary on the sr-only exemption: it is `width <= 1 && height <= 1`,
  // not "small" and not "absolutely positioned". A wide hairline is real
  // horizontal overflow and must not be exempted by being one pixel tall.
  const measurement = await measure(
    browser,
    '<hr data-testid="wide-rule" style="width:600px;height:1px;border:0;background:#000;margin:0" />',
  )

  expect(measurement.offenders.map((offender) => offender.testId)).toContain('wide-rule')
  expect(measurement.scrollWidth).toBeGreaterThan(measurement.clientWidth)
})
