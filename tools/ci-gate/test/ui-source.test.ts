import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The `styles` gate ([PER-231](/PER/issues/PER-231)) asserts that utilities only
 * `packages/ui` uses reach the stylesheet the landing page loads — which is what proves
 * `apps/web/src/app/globals.css` still registers `packages/ui/src` as a Tailwind source.
 * Delete that one line and the component ships unstyled with no build error, no failing
 * type-check and nothing in the diff to notice.
 *
 * As with the `bundle` gate, the risk here is not a false red. It is a **silent pass**:
 * every way this gate can end up asserting nothing still exits 0 and prints a confident
 * summary. The gate has four such doors by construction — no stylesheet in the manifest,
 * a probe that left `packages/ui`, a probe `apps/web` has started using, and all probes
 * retired at once — and each one is a case below. A fifth is the manifest shape itself:
 * App Router attributes a layout's CSS to `/layout` and leaves `/page` an empty array,
 * so a gate that read the page entry alone would find no stylesheet and have nothing to
 * report missing.
 *
 * Each case builds a complete fake repo in a scratch directory — the real gate script, a
 * fake `apps/web/.next` with a manifest and a stylesheet on disk, a fake
 * `packages/ui/src`, and a `globals.css` whose `@source` directives are the variable
 * under test — and runs the gate with `--reuse-build`. Nothing here runs a real build.
 *
 * The script is *copied* from `scripts/ci/` rather than reimplemented, and the probe list
 * is read out of its source rather than restated, so these cases cannot drift away from
 * the gate they are testing.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const gatePath = join(repoRoot, 'scripts', 'ci', 'assert-ui-source-registered.mjs')
const gateSource = readFileSync(gatePath, 'utf8')

/**
 * The utilities the gate probes for, read from its own `PROBES` table.
 *
 * Restating them here would let the fixtures keep passing against a probe list that has
 * moved on — the same drift the `bundle` gate's cases avoid by copying the script.
 */
const PROBES = (() => {
  const block = /const PROBES = \[\n([\s\S]*?)\n\]\n/.exec(gateSource)?.[1]
  if (!block) throw new Error('could not locate the PROBES table in the gate script')
  const utilities = [...block.matchAll(/utility: '([^']+)'/g)].map((m) => m[1])
  if (utilities.length === 0) throw new Error('the PROBES table lists no utilities')
  return utilities
})()

/** The directive the whole gate exists to defend. */
const UI_SOURCE = "@source '../../../../packages/ui/src';"
/** The exclusion that makes the probes load-bearing in the first place. */
const TEST_EXCLUSION = "@source not '../../test';"

interface Fixture {
  /** Replaces the default `@source` directive block in `globals.css`. */
  sources?: string
  /** Utilities to write into `packages/ui/src`. Defaults to every probe. */
  uiUtilities?: string[]
  /** Utilities to compile into the stylesheet. Defaults to every probe. */
  cssUtilities?: string[]
  /** Extra files under `apps/web`, keyed by path relative to `apps/web`. */
  webFiles?: Record<string, string>
  /** Replaces the manifest's `pages` map. */
  pages?: Record<string, string[]>
  /** Set false to leave the stylesheet out of the build output. */
  writeStylesheet?: boolean
}

/**
 * Tailwind escapes `:`, `[` and `]` in a generated class selector. The fixtures emit the
 * escaped form so the gate's unescaping is exercised rather than bypassed — the arbitrary
 * property probe is the one that matters here, and an unescaped `.[x:y]` would be matched
 * by a gate that did no unescaping at all.
 */
function selectorFor(utility: string): string {
  return `.${utility.replaceAll(/[[\]:./]/g, (char) => `\\${char}`)}`
}

function stylesheetFor(utilities: string[]): string {
  return utilities.map((u) => `${selectorFor(u)}{--probe:1}`).join('')
}

function buildFakeRepo(fixture: Fixture = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ui-source-gate-'))

  // The gate derives repoRoot from its own location, so it has to live at the same depth
  // as the real one.
  write(join(root, 'scripts', 'ci', 'assert-ui-source-registered.mjs'), '')
  cpSync(gatePath, join(root, 'scripts', 'ci', 'assert-ui-source-registered.mjs'))

  const sources = fixture.sources ?? `${UI_SOURCE}\n${TEST_EXCLUSION}`
  write(
    join(root, 'apps', 'web', 'src', 'app', 'globals.css'),
    `@import 'tailwindcss';\n\n${sources}\n\n:root { --radius: 0.625rem; }\n`,
  )

  // A component that uses the utilities, in the package the gate is checking is
  // registered. `cn(...)` is irrelevant to the gate — it reads text, as Tailwind does.
  const uiUtilities = fixture.uiUtilities ?? PROBES
  write(
    join(root, 'packages', 'ui', 'src', 'wordmark.tsx'),
    `export const Wordmark = () => <span className="${uiUtilities.join(' ')}" />\n`,
  )

  for (const [path, contents] of Object.entries(fixture.webFiles ?? {})) {
    write(join(root, 'apps', 'web', path), contents)
  }

  const nextDir = join(root, 'apps', 'web', '.next')
  const cssFile = 'static/css/probe.css'
  if (fixture.writeStylesheet !== false) {
    write(join(nextDir, cssFile), stylesheetFor(fixture.cssUtilities ?? PROBES))
  }
  write(
    join(nextDir, 'app-build-manifest.json'),
    JSON.stringify({
      pages: fixture.pages ?? {
        // The shape the real build produces: the stylesheet belongs to the root layout
        // and the page entry lists only its own chunks.
        '/layout': [cssFile, 'static/chunks/layout.js'],
        '/page': ['static/chunks/page.js'],
      },
    }),
  )

  return root
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function runGate(root: string, env: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'ci', 'assert-ui-source-registered.mjs'), '--reuse-build'],
    // `CI` is cleared by default: the real environment sets it, and the gate refuses
    // `--reuse-build` under CI on purpose. The case for that refusal sets it back.
    { encoding: 'utf8', env: { ...process.env, CI: '', ...env } },
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('the styles gate passes only when packages/ui reaches the stylesheet', () => {
  it('passes when every probe is in the stylesheet', () => {
    const { status, stdout } = runGate(buildFakeRepo())

    expect(status).toBe(0)
    expect(stdout).toContain(`${PROBES.length} of ${PROBES.length} probe(s)`)
    for (const utility of PROBES) expect(stdout).toContain(`present  .${utility}`)
  })

  it('finds the stylesheet the root layout owns, not the page entry', () => {
    // `/page` lists no CSS in a real build. A gate that read only the page entry would
    // see an empty list — and must not report that as nothing missing.
    const { status, stdout } = runGate(buildFakeRepo())

    expect(status).toBe(0)
    expect(stdout).toContain('static/css/probe.css')
  })

  it('fails, naming the directive to restore, when the @source line is gone', () => {
    const root = buildFakeRepo({ sources: TEST_EXCLUSION, cssUtilities: [] })
    const { status, stderr } = runGate(root)

    expect(status).toBe(1)
    expect(stderr).toContain('does not register')
    // The fix has to be in the failure, not in a doc the reader has to go find.
    expect(stderr).toContain("@source '../../../../packages/ui/src';")
    for (const utility of PROBES) expect(stderr).toContain(`.${utility}`)
  })

  it('distinguishes a present-but-ineffective directive from a missing one', () => {
    // The line is there and the utilities still did not compile: a wrong relative path, a
    // renamed package, or a Tailwind release that changed `@source` resolution. Telling
    // the reader to "restore the line" here would send them looking at a line that is
    // already correct.
    const { status, stderr } = runGate(buildFakeRepo({ cssUtilities: [] }))

    expect(status).toBe(1)
    expect(stderr).toContain('not taking effect')
    expect(stderr).not.toContain('does not register')
  })

  it('fails when a single probe is missing, not only when all of them are', () => {
    const { status, stderr } = runGate(buildFakeRepo({ cssUtilities: PROBES.slice(1) }))

    expect(status).toBe(1)
    expect(stderr).toContain(`.${PROBES[0]}`)
  })
})

describe('the styles gate fails closed rather than asserting nothing', () => {
  it('fails when a probe has left packages/ui instead of skipping it', () => {
    // A probe the package no longer uses proves nothing by being in the CSS. The gate has
    // to say so: silently dropping it shrinks the check with nothing in the log.
    const root = buildFakeRepo({ uiUtilities: PROBES.slice(1) })
    const { status, stderr } = runGate(root)

    expect(status).toBe(1)
    expect(stderr).toContain('no longer appear anywhere in packages/ui/src')
    expect(stderr).toContain(`"${PROBES[0]}"`)
  })

  it('retires a probe apps/web has started using, and says so', () => {
    // Not a failure: nothing is broken, the probe has just stopped being evidence,
    // because apps/web's own sources would now generate it.
    const root = buildFakeRepo({
      webFiles: { 'src/app/page.tsx': `export default () => <h1 className="${PROBES[0]}" />\n` },
    })
    const { status, stdout } = runGate(root)

    expect(status).toBe(0)
    expect(stdout).toContain('UI source probe retired')
    expect(stdout).toContain('src/app/page.tsx')
    expect(stdout).toContain(`${PROBES.length - 1} of ${PROBES.length} probe(s)`)
  })

  it('fails when apps/web has claimed every probe', () => {
    // The erosion endpoint. Every probe is still in the CSS, so the naive check is green —
    // and completely blind, because apps/web would generate all of them on its own.
    const root = buildFakeRepo({
      webFiles: { 'src/app/page.tsx': `<h1 className="${PROBES.join(' ')}" />\n` },
    })
    const { status, stderr } = runGate(root)

    expect(status).toBe(1)
    expect(stderr).toContain('nothing left to prove')
  })

  it('keeps a probe that only the excluded test tree mentions', () => {
    // The point of `@source not '../../test'`. Tailwind does not read these files, so a
    // class name asserted in a test does not generate the class and does not retire the
    // probe. Before that exclusion existed, every probe was mentioned in
    // `apps/web/test/ui/wordmark.test.tsx` and this gate had nothing to assert.
    const root = buildFakeRepo({
      webFiles: {
        'test/ui/wordmark.test.tsx': `expect(el).toHaveClass('${PROBES.join("', '")}')\n`,
      },
    })
    const { status, stdout } = runGate(root)

    expect(status).toBe(0)
    expect(stdout).toContain(`${PROBES.length} of ${PROBES.length} probe(s)`)
    expect(stdout).not.toContain('probe retired')
  })

  it('retires that probe once the exclusion is dropped', () => {
    // The same tree, with only the `@source not` directive removed: Tailwind reads the
    // test file again, so the assertion in it is what generates the class. This is the
    // measured pre-PER-231 state, and the gate must report it as unprovable rather than
    // pass on CSS the test file is responsible for.
    const root = buildFakeRepo({
      sources: UI_SOURCE,
      webFiles: {
        'test/ui/wordmark.test.tsx': `expect(el).toHaveClass('${PROBES.join("', '")}')\n`,
      },
    })
    const { status, stderr } = runGate(root)

    expect(status).toBe(1)
    expect(stderr).toContain('nothing left to prove')
  })

  it('fails when no stylesheet is attributed to the route or its ancestors', () => {
    // "Nothing to check" is the worst possible pass: it is also what a manifest shape
    // change looks like, and what an app that ships no CSS at all looks like.
    const root = buildFakeRepo({
      writeStylesheet: false,
      pages: { '/layout': ['static/chunks/layout.js'], '/page': ['static/chunks/page.js'] },
    })
    const { status, stderr } = runGate(root)

    expect(status).toBe(1)
    expect(stderr).toContain('No stylesheet is attributed')
  })

  it('fails when the landing route is absent from the manifest', () => {
    const root = buildFakeRepo({ pages: { '/layout': ['static/css/probe.css'] } })
    const { status, stderr } = runGate(root)

    expect(status).toBe(1)
    expect(stderr).toContain('has no "/page" entry')
  })

  it('fails when globals.css declares no @source directives at all', () => {
    const { status, stderr } = runGate(buildFakeRepo({ sources: '/* nothing here */' }))

    expect(status).toBe(1)
    expect(stderr).toContain('no @source directives')
  })

  it('does not read an @source directive out of a comment', () => {
    // `globals.css` documents its own directives in prose, and the real file quotes the
    // directive it is explaining. A parser that took the commented copy as configuration
    // would report `packages/ui` registered while the build had no such source.
    const root = buildFakeRepo({
      sources: `/* restore this if it goes missing: ${UI_SOURCE} */\n${TEST_EXCLUSION}`,
      cssUtilities: [],
    })
    const { status, stderr } = runGate(root)

    expect(status).toBe(1)
    expect(stderr).toContain('does not register')
  })

  it('refuses --reuse-build under CI', () => {
    // In CI the flag would read a restored `.next` from another commit and pass on a
    // stylesheet it never built.
    const { status, stderr } = runGate(buildFakeRepo(), { CI: 'true' })

    expect(status).toBe(1)
    expect(stderr).toContain('--reuse-build must not be used in CI')
  })
})

describe('the styles gate matches a selector, not a substring', () => {
  it('is not satisfied by a longer utility that starts with the probe', () => {
    // `.text-balance` must not be answered by `.text-balance-foo`: a different class, a
    // different declaration, and the hero still unstyled.
    const probe = PROBES.find((u) => /^[a-z0-9-]+$/.test(u))
    expect(probe, 'expected at least one plain word-and-dash probe').toBeDefined()
    const root = buildFakeRepo({ cssUtilities: PROBES })
    write(
      join(root, 'apps', 'web', '.next', 'static', 'css', 'probe.css'),
      stylesheetFor(PROBES.filter((u) => u !== probe)) + `.${probe}-extra{--probe:1}`,
    )

    const { status, stderr } = runGate(root)

    expect(status).toBe(1)
    expect(stderr).toContain(`.${probe}`)
  })

  it('is not rescued by a longer class name in packages/ui', () => {
    // The mirror image: `wrap-anywhere` appearing only inside `text-wrap-anywhere` is a
    // mention of a different utility and must not count as the package using the probe.
    const probe = PROBES.find((u) => /^[a-z0-9-]+$/.test(u))!
    const root = buildFakeRepo({
      uiUtilities: [...PROBES.filter((u) => u !== probe), `prefixed-${probe}-suffixed`],
    })
    const { status, stderr } = runGate(root)

    expect(status).toBe(1)
    expect(stderr).toContain('no longer appear anywhere in packages/ui/src')
    expect(stderr).toContain(`"${probe}"`)
  })
})
