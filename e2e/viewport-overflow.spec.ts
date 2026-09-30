import { expect, test } from '@playwright/test'

import { formatMeasurement, formatOffender, measureOverflow } from './lib/overflow'
import { ROUTES, VIEWPORTS } from './lib/viewports'

/**
 * The horizontal-overflow gate. Nothing on a phone should scroll sideways.
 *
 * One test per route x viewport, each walking that route's declared interactive
 * states, on both Chromium and WebKit (see `playwright.config.ts` for why those
 * two). Every measurement is logged with the numbers it measured, pass or fail —
 * a gate that only speaks up when it fails cannot be distinguished from a gate
 * that never ran.
 *
 * ## Not covered, deliberately
 *
 * This measures **horizontal** overflow and nothing else. It does not check
 * vertical clipping, tap-target size, colour contrast, focus order, reading
 * order, or whether the layout is any good. Those are separate checks with
 * separate owners — the a11y and Lighthouse gates are the QA Engineer's, the
 * layout is the Frontend Engineer's. Do not read a green run here as
 * "the mobile layout is fine".
 */

// A fresh context per viewport, not `page.setViewportSize`: `isMobile`,
// `hasTouch` and `deviceScaleFactor` are context-level options in Playwright and
// cannot be changed on a live page. Reusing one page would silently measure
// every viewport with the first one's device class.
for (const route of ROUTES) {
  for (const viewport of VIEWPORTS) {
    test(`no horizontal overflow: ${route.name} @ ${viewport.name}px`, async ({
      browser,
      browserName,
    }, testInfo) => {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
        isMobile: viewport.isMobile,
        hasTouch: viewport.isMobile,
      })
      const page = await context.newPage()

      const lines: string[] = []
      try {
        for (const state of route.states) {
          // `waitUntil: 'load'` rather than 'networkidle': networkidle is
          // deprecated and flaky against a Next.js app that keeps a connection
          // open. The `proof` assertion below is the real readiness signal.
          await page.goto(route.path, { waitUntil: 'load' })

          if (state.click !== undefined) {
            // Auto-waiting: `click()` waits for the element to be attached,
            // visible, stable and enabled. No fixed settle anywhere in this
            // suite — a `setTimeout` on a hydrating page is what turns a slow
            // runner red, and a flaky gate is a defect.
            await page.locator(state.click).first().click()
          }

          // The proof. Until this is visible the page is not in the state we
          // claim to be measuring, and `toBeVisible` retries until it is — so
          // this is both the state assertion and the settle.
          const proof = page.locator(state.proof).first()
          await expect(
            proof,
            `state "${state.name}" of ${route.path} did not reach its proof selector ` +
              `\`${state.proof}\`. Either the state is unreachable or the selector is ` +
              'stale — a stale proof means this state was never measured.',
          ).toBeVisible()

          const measurement = await page.evaluate(measureOverflow)
          const label = `${browserName} ${viewport.name}px ${route.path} [${state.name}]`

          /**
           * The gate's own load-bearing precondition, asserted rather than
           * assumed. Under `isMobile: true` a document with no
           * `<meta name="viewport" content="width=device-width">` is laid out at
           * the mobile default of **980px**, so a 600px element does not
           * overflow a "390px" run and every assertion below passes for the
           * wrong reason. Drop `export const viewport` from
           * `apps/web/src/app/layout.tsx` and the whole suite would go green
           * while covering nothing — so it has to be this test that catches it,
           * not a reviewer.
           */
          expect(
            measurement.clientWidth,
            `${label} was laid out at ${measurement.clientWidth}px, not ${viewport.width}px. ` +
              'On a mobile context that means the page is missing ' +
              '`<meta name="viewport" content="width=device-width">` and is being laid out at ' +
              'the 980px mobile default — which silently makes every overflow assertion in ' +
              'this suite vacuous.',
          ).toBe(viewport.width)
          lines.push(formatMeasurement(label, measurement))
          // Per-measurement line in the runner log: this is the evidence the
          // issue asks for, and it is emitted for a pass as well as a failure.
          console.log(formatMeasurement(label, measurement))

          const detail =
            measurement.offenders.length === 0
              ? ''
              : '\n  Elements crossing an edge:\n    ' +
                measurement.offenders.map(formatOffender).join('\n    ') +
                '\n  A left-edge report is a bug in the element, not in the gate, unless the ' +
                'element (or an ancestor) is marked `data-allow-offscreen`.'

          expect(
            measurement.scrollWidth,
            `${label} scrolls horizontally: scrollWidth ${measurement.scrollWidth} > ` +
              `clientWidth ${measurement.clientWidth}.${detail}`,
          ).toBe(measurement.clientWidth)

          expect(
            measurement.offenders,
            `${label} has ${measurement.offenders.length} element(s) crossing a viewport ` +
              `edge.${detail}`,
          ).toEqual([])
        }
      } finally {
        // Attached whether the test passed or failed, so the report carries the
        // measured numbers rather than only the assertion that tripped.
        await testInfo.attach(`overflow-${route.name}-${viewport.name}`, {
          body: lines.join('\n'),
          contentType: 'text/plain',
        })
        await context.close()
      }
    })
  }
}
