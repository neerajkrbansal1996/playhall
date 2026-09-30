#!/usr/bin/env node
/**
 * Horizontal-overflow check against a real browser, at a real layout viewport.
 *
 * Mobile-first is a product principle, but nothing in the test suite could see a
 * layout: jsdom does not lay out, so `getBoundingClientRect()` is all zeroes and
 * every width assertion is vacuous. That blind spot cost us
 * [PER-121](/PER/issues/PER-121) — a create-lobby overflow was reported from a
 * screenshot, and the page turned out to be fine. The screenshot came from
 * `chrome --headless --screenshot --window-size=390,844`, which **crops the
 * capture to 390px without laying the page out at 390px**: the page rendered at
 * the default ~800px viewport, `mx-auto` centred a 448px `max-w-md` column
 * inside it, and the crop cut the right-hand side off. It looks exactly like an
 * overflow bug and is not one.
 *
 * So this script drives Chrome over the DevTools Protocol and uses
 * `Emulation.setDeviceMetricsOverride`, which changes the layout viewport rather
 * than the crop. It answers the only question that settles the argument:
 *
 *   document.documentElement.scrollWidth === document.documentElement.clientWidth
 *
 * and, when that fails, names the elements sticking out so the fix is one read
 * rather than a bisect. Use `--screenshots <dir>` to get captures that are
 * actually at the viewport they claim.
 *
 * No new dependency: the CDP client is ~40 lines over Node's built-in
 * `WebSocket` (stable since Node 22, which is this repo's engine floor).
 *
 * Usage:
 *   cd apps/web
 *   NEXT_PUBLIC_SETTINGS_FORM_PREVIEW=1 pnpm exec next build
 *   NEXT_PUBLIC_SETTINGS_FORM_PREVIEW=1 pnpm exec next start -p 3947 &
 *   pnpm check:viewport
 *   pnpm check:viewport -- --screenshots ./shots
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- configuration -------------------------------------------------------

/**
 * 320 is the narrowest viewport we support (iPhone SE, and the WCAG 1.4.10
 * reflow floor); 390 is the reported iPhone 12-14 width; 1280 catches a fix that
 * only works by making the mobile layout the desktop one too.
 */
const VIEWPORTS = [
  { name: '320', width: 320, height: 800, deviceScaleFactor: 2, mobile: true },
  { name: '360', width: 360, height: 800, deviceScaleFactor: 3, mobile: true },
  { name: '390', width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  { name: '768', width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
  { name: '1280', width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
]

/**
 * Routes to check, each with the interactive states worth measuring.
 *
 * A state is reached from a freshly loaded page and must declare a `proof`
 * selector. Without one, a click that silently stops matching after a refactor
 * measures the default state again and the check stays green while covering
 * nothing — which is how a gate becomes decoration.
 */
const ROUTES = [
  { path: '/', states: [{ name: 'default', proof: 'body' }] },
  {
    path: '/dev/settings-form',
    states: [
      { name: 'default', proof: 'main' },
      // The two number fields are conditional on `timeControl: custom`, so the
      // default state never renders them. Option ids carry a type-prefixed
      // token (`s:custom`), hence matching the chip by its label text.
      {
        name: 'custom-time-control',
        click: { label: 'Custom' },
        proof: '[data-field-key="customInitialMinutes"]',
      },
      // A server error adds an icon + message row under a field.
      {
        name: 'server-error',
        click: { button: 'Toggle a server error' },
        proof: '[role="alert"]',
      },
      // The widest thing the page can render: a submitted-settings JSON blob.
      { name: 'submitted', click: { button: 'Create lobby' }, proof: 'pre' },
    ],
  },
]

// --- arguments -----------------------------------------------------------

const args = process.argv.slice(2)
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const baseUrl = flag('url', process.env.PREVIEW_URL ?? 'http://127.0.0.1:3947').replace(/\/$/, '')
const screenshotDir = flag('screenshots', null)

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p) => typeof p === 'string' && p.length > 0)

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
if (chromePath === undefined) {
  // Deliberately a hard failure, not a skip. A check that exits 0 when it could
  // not run is worse than no check: it reports "green" for work it never did.
  console.error(
    'No Chrome or Chromium found. Set CHROME_PATH to a browser binary.\nLooked in:\n  ' +
      CHROME_CANDIDATES.join('\n  '),
  )
  process.exit(1)
}

// --- minimal CDP client --------------------------------------------------

const profileDir = mkdtempSync(join(tmpdir(), 'viewport-check-'))
const chrome = spawn(chromePath, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  // Without this, a vertical scrollbar eats ~15px of the layout viewport and
  // every measurement is off by the scrollbar width on some platforms only.
  '--hide-scrollbars',
  'about:blank',
])

/** Chrome prints `DevTools listening on ws://...` to stderr once it is up. */
const wsUrl = await new Promise((resolve, reject) => {
  let buffered = ''
  const timer = setTimeout(() => reject(new Error('Chrome did not start within 30s')), 30_000)
  chrome.stderr.on('data', (chunk) => {
    buffered += chunk.toString()
    const match = buffered.match(/ws:\/\/[^\s]+/)
    if (match !== null) {
      clearTimeout(timer)
      resolve(match[0])
    }
  })
  chrome.once('error', reject)
})

const socket = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
})

let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})

function call(method, params = {}, sessionId) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
}

const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
const send = (method, params) => call(method, params, sessionId)

await send('Page.enable')
await send('Runtime.enable')

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation threw')
  }
  return result.result.value
}

// --- the measurement ------------------------------------------------------

/**
 * Runs in the page. Reports the document's scroll width against its client
 * width, plus every element crossing either edge — the element list is what
 * turns a failure into a fix.
 */
const MEASURE = `(() => {
  const root = document.documentElement
  const limit = root.clientWidth
  const offenders = []
  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    // Half a pixel of slack: sub-pixel layout rounding is not an overflow.
    if (rect.right > limit + 0.5 || rect.left < -0.5) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        className: (el.getAttribute('class') ?? '').slice(0, 100),
        text: (el.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 40),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      })
    }
  }
  return {
    scrollWidth: root.scrollWidth,
    clientWidth: limit,
    offenders: offenders.slice(0, 10),
  }
})()`

function clickExpression(click) {
  if (click.label !== undefined) {
    return `(() => {
      const el = [...document.querySelectorAll('label')]
        .find((n) => n.textContent.trim() === ${JSON.stringify(click.label)})
      if (!el) throw new Error('no label ' + ${JSON.stringify(click.label)})
      el.click()
    })()`
  }
  return `(() => {
    const el = [...document.querySelectorAll('button')]
      .find((n) => n.textContent.includes(${JSON.stringify(click.button)}))
    if (!el) throw new Error('no button ' + ${JSON.stringify(click.button)})
    el.click()
  })()`
}

if (screenshotDir !== null) mkdirSync(screenshotDir, { recursive: true })

const failures = []
let checked = 0

for (const viewport of VIEWPORTS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
  })

  for (const route of ROUTES) {
    for (const state of route.states) {
      const label = `${viewport.name}px ${route.path} [${state.name}]`

      await send('Page.navigate', { url: `${baseUrl}${route.path}` })
      // Page.loadEventFired would be tighter, but this page hydrates before it
      // reaches its final layout and a fixed settle beats a flaky race.
      await new Promise((resolve) => setTimeout(resolve, 1200))

      if (state.click !== undefined) {
        await evaluate(clickExpression(state.click))
        await new Promise((resolve) => setTimeout(resolve, 300))
      }

      const applied = await evaluate(
        `document.querySelector(${JSON.stringify(state.proof)}) !== null`,
      )
      if (applied !== true) {
        failures.push({ label, reason: `state never applied — ${state.proof} not in the DOM` })
        continue
      }

      const { scrollWidth, clientWidth, offenders } = await evaluate(MEASURE)
      checked += 1

      if (scrollWidth > clientWidth || offenders.length > 0) {
        failures.push({
          label,
          reason: `scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`,
          offenders,
        })
      }

      if (screenshotDir !== null) {
        const shot = await send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
        })
        const file = `${route.path.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'root'}--${state.name}--${viewport.name}.png`
        writeFileSync(join(screenshotDir, file), Buffer.from(shot.data, 'base64'))
      }
    }
  }
}

socket.close()
chrome.kill()
// Best-effort: Chrome is still flushing its profile as we exit, so a failed
// unlink of a temp directory must never decide this check's exit code.
await new Promise((resolve) => chrome.once('exit', resolve))
try {
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
} catch {
  // The OS will reap it from the temp directory.
}

if (failures.length > 0) {
  console.error(`\nHorizontal overflow in ${failures.length} of ${checked} checks:\n`)
  for (const failure of failures) {
    console.error(`  ✗ ${failure.label}\n      ${failure.reason}`)
    for (const offender of failure.offenders ?? []) {
      console.error(
        `      <${offender.tag} class="${offender.className}"> ` +
          `left=${offender.left} right=${offender.right} — ${offender.text}`,
      )
    }
  }
  console.error('')
  process.exit(1)
}

console.log(`No horizontal overflow: ${checked} checks across ${VIEWPORTS.length} viewports.`)
if (screenshotDir !== null) console.log(`Screenshots written to ${screenshotDir}`)
process.exit(0)
