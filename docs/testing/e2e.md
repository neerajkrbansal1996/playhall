# E2E suite (Playwright)

Owner: QA Engineer. Landed by [PER-131](/PER/issues/PER-131).

```bash
pnpm e2e:install        # once: downloads Chromium + WebKit
pnpm test:e2e           # the gate
pnpm test:e2e:ui        # the same suite, in Playwright's UI mode
```

## What this is

The `e2e` CI gate. The gate registry in `scripts/ci/gate.mjs` has declared
`e2e: { script: 'test:e2e' }` since PER-6, and `.github/workflows/ci.yml` has had
the job — and the `playwright-report` artifact upload — the whole time. With no
root `test:e2e` script the gate printed `::notice title=CI gate pending` and
exited 0: a green placeholder. Landing the script and this config is what made it
real, the same way `boundaries` went live via [PER-5](/PER/issues/PER-5) and
`format` did later.

`pendingOwner` for `e2e` is now `null`, which is load-bearing: delete the root
script and the gate runner takes the **demoted** branch and fails the job, rather
than reporting PENDING and exiting 0.

## Browsers

Chromium and WebKit, both from one `pnpm e2e:install`.

WebKit is the load-bearing one. The support matrix requires Safari including iOS,
and flex/grid min-content sizing, `dvh` and overflow resolution are precisely
where WebKit diverges from Chromium. A Chromium-only mobile gate buys much less
mobile-first assurance than its name implies.

Firefox is deliberately out for now: a third browser download for a third engine
whose box model agrees with Chromium's on everything this suite currently
measures. Revisit when a spec measures something it would actually split on.

## The server

`playwright.config.ts` owns a `webServer` that runs a **production** `next build`
and `next start` on port 3947 (`E2E_PORT` to change it), with
`NEXT_PUBLIC_SETTINGS_FORM_PREVIEW=1`. `next dev` is not used: it injects the dev
overlay and compiles on first request, neither of which ships, and both of which
change layout timing.

`reuseExistingServer` is **off** by default — opt in with `E2E_REUSE_SERVER=1`.
This is not the usual `!process.env.CI`, and the reason is a real failure: a
`next start` left running by an earlier session answers `/api/health` perfectly
while serving a build of a _different branch_. That cost a debugging pass on this
suite's own first run, which reported six green viewports and four missing
`data-testid`s. A suite whose subject is "what does the current tree render" must
not silently measure another tree.

## Spec 1 — horizontal overflow

`e2e/viewport-overflow.spec.ts`. Nothing on a phone should scroll sideways.

For each route x viewport, on both browsers, it walks the route's declared
interactive states and asserts:

1. `document.documentElement.clientWidth === <the configured viewport width>`
2. `document.documentElement.scrollWidth === clientWidth`
3. no element crosses either viewport edge

Viewports: **320 / 360 / 390 / 412 / 768 / 1280**. 320 is the narrowest width we
support (iPhone SE, and the WCAG 2.1 1.4.10 reflow floor); 360 and 412 are the
two commonest Android widths; 390 is iPhone 12–16; 768 is the tablet breakpoint;
1280 catches a "fix" that works only by making the mobile layout the desktop one
too. `isMobile` is `true` up to 412 and **false** at 768 and 1280 — 768 is a
width check, and flipping `pointer: coarse` / `hover: none` there would measure a
layout no real device renders.

Every measurement is printed with the numbers it measured, pass or fail:

```
chromium 390px /dev/settings-form [submitted]: scrollWidth=390 clientWidth=390 elements=136 offenders=0
```

A gate that only speaks when it fails cannot be told apart from a gate that never
ran.

### Assertion 1 is not redundant

Under `isMobile: true`, a document with no
`<meta name="viewport" content="width=device-width">` is laid out at the **980px**
mobile default. A 600px element then does not overflow a "390px" run, and
assertions 2 and 3 pass for the wrong reason. `apps/web/src/app/layout.tsx`
exports `viewport`, which emits the tag; drop it and the whole suite would go
green while covering nothing. Hence the explicit width check. The fixtures in
`overflow-detector.spec.ts` failed exactly this way on their first run, which is
how the hole was found.

### `proof` per state

Every state names a `proof` selector, asserted visible before anything is
measured. A click whose selector silently stops matching after a refactor would
otherwise leave the suite measuring the default state N times over while staying
green — covering nothing. The proof is also the settle: `toBeVisible` retries
until the state is really there.

### No fixed settles, no retries

There is no `await setTimeout(n)` anywhere in `e2e/`. Playwright's auto-waiting
and web-first assertions replace it; a fixed settle on a hydrating Next.js page
is the commonest cause of a suite that is green on a laptop and red on a loaded
runner. `retries: 0` for the same reason: the subject is deterministic layout
measurement, so a measurement that is not reproducible **is** the bug. A flaky
test gets quarantined with an owner, never re-run until green.

### Selectors are never keyed on copy

Product copy belongs to Product Designer, it will change, and i18n breaks all of
it. States are reached through stable hooks only:

| state                 | selector                                                         |
| --------------------- | ---------------------------------------------------------------- |
| `custom-time-control` | `[data-field-key="timeControl"] input[value="s:custom"] + label` |
| `server-error`        | `[data-testid="toggle-server-error"]`                            |
| `submitted`           | `[data-testid="create-lobby-submit"]`                            |

`data-field-key` is the settings-form renderer's own contract attribute and
`s:custom` is `grouping.ts#optionToken`'s type-prefixed token — the chip's real
`<input type="radio">` is `sr-only`, so the click target is its sibling `<label>`.
The two `data-testid`s were added to the dev preview page for this gate and are
commented as such.

### The off-left-edge opt-out

The right edge has no opt-out: an element past it **is** horizontal overflow on a
phone.

The left edge does. Sitting off the left edge is a legitimate pattern — a mobile
nav drawer at `-translate-x-full`, a carousel track, a slide-over are all at
`left = -390` on a 390px viewport by design, and none of them makes the page
scroll sideways. Mark the element, or any ancestor, `data-allow-offscreen`:

```tsx
<div data-allow-offscreen className="fixed inset-y-0 left-0 w-80 -translate-x-full">
```

The escape hatch is explicit and greppable rather than a widened tolerance,
because a gate that goes red on a correct pattern gets waved through, and a
waved-through gate is decoration.

Separately, a box at most 1px on **both** axes is skipped on either edge:
Tailwind's `sr-only` is a 1x1 box with `margin: -1px` (used on every settings
chip's native radio) and lands at `left = -1` when its container starts near
x=0. That is the near-miss that makes the 0.5px slack load-bearing. The exemption
is narrow on purpose — a 600px-wide, 1px-tall rule sticking out the right edge is
real overflow and is still reported.

## Spec 2 — the detector's own tests

`e2e/overflow-detector.spec.ts`, against `page.setContent()` fixtures through the
same `page.evaluate(measureOverflow)` call. Spec 1 passing means nothing unless
the detector can fail, so these pin:

- a 600px child in a two-column grid **is** reported, and the offender is named
- a drawer at `left = -390` passes **with** `data-allow-offscreen` and is reported
  **without** it (both halves, so neither can rot green)
- `sr-only`'s 1x1 box is not an overflow on either edge
- a 600px-wide, 1px-tall rule past the right edge still is

## Proven able to fail

A gate never demonstrated red is not a gate. Injecting a 600px child into the
Quick Start grid (`preset-quick-start.tsx`) turns spec 1 red on **10** tests —
320, 360, 390, 412 and 768 on both browsers — each naming the element:

```
right edge: <div> [data-testid="per131-red-proof"] left=16 right=616 "red proof"
chromium 390px /dev/settings-form [default]: scrollWidth=616 clientWidth=390 elements=136 offenders=1
```

1280 correctly stays green: a 600px child fits in a 1280px viewport, so there is
no overflow to report. Reverting the injection returns all 32 tests to green.

## Explicitly not covered

Read a green run here as "nothing scrolls sideways", and nothing more. This suite
does **not** check:

- **vertical clipping** or content cut off below the fold
- **tap-target size** (WCAG 2.5.5 / 2.5.8) — the chips are `h-11` by hand today
- **colour contrast** or the "never colour alone" rule
- **focus order, reading order, screen-reader output** — `apps/web/test/settings-form/accessibility.test.tsx` covers part of this in jsdom
- **Lighthouse performance / LCP** — ADR-0004 books that measurement separately
- **Firefox, Edge, Samsung Internet** — the matrix needs them; this gate runs two engines
- **real devices and real networks** — this is a runner, not a mid-range Android on 4G
- **any multiplayer behaviour** — two-context play, reconnection, spectator leaks
  and clock drift are M3's specs, and they land in this same harness

## Adding a spec

Drop a `*.spec.ts` in `e2e/`. It runs on both browsers automatically. If it needs
a page state, declare the state in `e2e/lib/viewports.ts` with a `proof` selector
and reach it with a stable hook, never with copy.
