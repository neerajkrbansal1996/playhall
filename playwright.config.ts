import { defineConfig } from '@playwright/test'

/**
 * The E2E runner. Turns the `e2e` gate in `scripts/ci/gate.mjs` from a green
 * placeholder into a real gate ([PER-131](/PER/issues/PER-131)).
 *
 * The gate registry has declared `e2e: { script: 'test:e2e' }` since PER-6, and
 * `.github/workflows/ci.yml` has had the job (and the `playwright-report`
 * artifact upload) the whole time — but with no root `test:e2e` script the gate
 * printed `::notice title=CI gate pending` and exited 0. Landing that script is
 * the only thing needed to make it live; see `docs/testing/e2e.md`.
 *
 * ## Why two browsers and not three
 *
 * `chromium` and `webkit`, both installed by the single `pnpm e2e:install`.
 * WebKit is the load-bearing one: the support matrix requires Safari including
 * iOS, and flex/grid min-content sizing, `dvh` and overflow resolution are
 * precisely where WebKit diverges from Chromium. A Chromium-only mobile
 * overflow gate buys much less than its name implies. Firefox is deliberately
 * out for now — it is a third browser download for a third rendering engine
 * whose box model agrees with Chromium's on the things this suite measures.
 *
 * ## No fixed settles
 *
 * There is deliberately no `await setTimeout(n)` anywhere in `e2e/`. Playwright's
 * auto-waiting and web-first assertions (`expect.poll`, `toBeVisible`) replace
 * it. A fixed settle on a hydrating Next.js page is the single most common cause
 * of a suite that is green on a laptop and red on a loaded CI runner, and a
 * flaky gate is a defect, not a re-run.
 */

/** The preview build the suite drives. Kept off the default port so a `pnpm dev` can coexist. */
const PORT = Number(process.env.E2E_PORT ?? 3947)
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`

/**
 * The preview flags that make the `/dev/*` measurement harnesses resolve
 * instead of 404.
 *
 * `NEXT_PUBLIC_SETTINGS_FORM_PREVIEW=1` gates `/dev/settings-form`, the
 * create-lobby composition and the widest content this app can currently
 * render. `NEXT_PUBLIC_ROOM_PREVIEW=1` gates `/dev/room`, the room/seats/join
 * surfaces ([PER-141](/PER/issues/PER-141)).
 *
 * Both are `NEXT_PUBLIC_*` flags read at **build** time, so each must be set
 * for the build step as well as the server — hence one shared prefix applied to
 * both halves of the command rather than an env block, which `next build`
 * in a child `pnpm exec` would not inherit from Playwright's `webServer.env`
 * for the already-built bundle.
 *
 * A missing flag here does not fail loudly: the route 404s, and a spec written
 * against it fails with a confusing "element not found" rather than "the page
 * you asked for is switched off". `/dev/room` shipped unreachable for exactly
 * this reason — `NEXT_PUBLIC_ROOM_PREVIEW` appeared nowhere but the page that
 * tested it. When a new `/dev/*` harness lands, add its flag here in the same
 * commit.
 */
const PREVIEW_FLAGS = 'NEXT_PUBLIC_SETTINGS_FORM_PREVIEW=1 NEXT_PUBLIC_ROOM_PREVIEW=1'

const WEB_SERVER_COMMAND =
  `${PREVIEW_FLAGS} pnpm --filter @playhall/web exec next build && ` +
  `${PREVIEW_FLAGS} pnpm --filter @playhall/web exec next start --port ${PORT}`

export default defineConfig({
  testDir: './e2e',
  // Every spec here is a measurement against a server-rendered page. None of
  // them mutate shared state, so they parallelise cleanly.
  fullyParallel: true,
  // A `.only` left in a spec silently stops the rest of the gate from running.
  forbidOnly: Boolean(process.env.CI),
  // Zero, on purpose. A retry that turns a red into a green hides a flake, and
  // this suite's whole subject is deterministic layout measurement: if a
  // measurement is not reproducible, that is the bug.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]]
    : [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',

  use: {
    baseURL: BASE_URL,
    // Traces and screenshots only for a failure: they are the evidence a bug
    // report needs, and `playwright-report/**` is already uploaded by the job.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],

  // The suite needs a production build: `next dev` injects the dev overlay and
  // recompiles on first request, both of which change layout timing and neither
  // of which ships.
  webServer: {
    command: WEB_SERVER_COMMAND,
    url: `${BASE_URL}/api/health`,
    /**
     * Opt-in, not the usual `!process.env.CI`.
     *
     * Reuse is a trap here rather than a convenience: a `next start` left
     * running by an earlier session answers `/api/health` perfectly well while
     * serving a build of a *different branch*. That is not hypothetical — it
     * cost a debugging pass on this very suite, which reported six green
     * viewports and four missing `data-testid`s because the port already had
     * yesterday's bytes on it. A suite whose subject is "what does the current
     * tree render" must not silently measure another tree. Set
     * `E2E_REUSE_SERVER=1` when you are deliberately iterating against a server
     * you started yourself.
     */
    reuseExistingServer: process.env.E2E_REUSE_SERVER === '1',
    // A cold `next build` of apps/web dominates this; the serve itself is instant.
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
