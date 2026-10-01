#!/usr/bin/env node
/**
 * Asserts that utilities which exist only in `packages/ui/src` reach the stylesheet the
 * landing page actually loads in a production `apps/web` build.
 *
 * Why this is a gate and not a comment ([PER-231](/PER/issues/PER-231)):
 *
 * `apps/web/src/app/globals.css` carries one line that every current and future
 * `@playhall/ui` component depends on:
 *
 *     @source '../../../../packages/ui/src';
 *
 * Tailwind v4's automatic source detection starts at the app's own root, so without that
 * line a utility class that only ever appears in `packages/ui` is never generated. The
 * component then ships **unstyled, with no build error and nothing in the diff to
 * notice** — and the first casualty is `Wordmark` on `/`, which is the landing page's LCP
 * element. Delete the line and no type-checks, no lint rule and no unit test object:
 * `Wordmark` renders the same DOM either way, and jsdom has no stylesheet to be wrong.
 *
 * ## The trap this gate had to be designed around
 *
 * The obvious version of this check — "assert a `packages/ui`-only utility is in the
 * built CSS" — was unbuildable when PER-231 was written, and measuring it is what showed
 * why. Tailwind's extractor reads candidates out of *any* text under the app root, which
 * at the time included `apps/web/test`. Every one of `Wordmark`'s utilities was therefore
 * emitted off its own name appearing in `apps/web/test/ui/wordmark.test.tsx`'s
 * assertions. Two production builds of the same tree, one with the `@source` line and one
 * without, differed by 27 bytes and exactly one rule: `.overflow-hidden`, generated from
 * the English words "nowrap + overflow-hidden" inside a code comment.
 *
 * So there was no `packages/ui`-only utility to probe, and the one candidate that existed
 * was dead CSS conjured out of prose. The utilities were correct for a reason that had
 * nothing to do with the component being registered — a test asserting a class name was
 * what kept the class name alive.
 *
 * `@source not '../../test'` in `globals.css` is the half of PER-231 that makes this gate
 * possible: production CSS becomes a function of production sources. With it, deleting
 * the `@source` line costs nine rules including `.font-bold`, `.text-5xl`,
 * `.text-balance`, `.wrap-anywhere`, `.text-foreground` and
 * `.[font-variant-ligatures:none]` — the hero wordmark's weight, size, wrapping and
 * colour. Those are regressions a human would see, which is what makes them worth
 * gating.
 *
 * ## What this gate checks, in order
 *
 * The verdict comes from the emitted bytes, not from grepping `globals.css` for the
 * line. A line can be present and still not work: a wrong relative path, a renamed
 * package directory, or a Tailwind release that changes `@source` resolution all leave
 * the line sitting there looking correct. `globals.css` is parsed only to derive the file
 * set Tailwind scans (so the "is this probe still load-bearing?" question below cannot
 * drift from the real configuration) and to explain a failure once one happens.
 *
 *   1. Build `apps/web`, or reuse an existing build with `--reuse-build` (local only).
 *   2. Resolve the stylesheet `/` loads from `app-build-manifest.json`, via the route's
 *      **ancestors** — App Router attributes a layout's CSS to `/layout` and leaves
 *      `/page` empty, so reading the page entry alone finds no stylesheet at all.
 *   3. Work out which declared probes are still load-bearing: present in
 *      `packages/ui/src`, and absent from every file Tailwind scans for this app.
 *   4. Assert each surviving probe's rule is in that stylesheet.
 *
 * Step 3 is the part that fails closed. A probe `apps/web` has started using is no longer
 * evidence of anything — its presence in the CSS would be explained by the app's own
 * source — so it is dropped from the check and reported. If that erodes the set to
 * nothing the gate **fails** rather than printing a confident summary over zero
 * assertions, and a probe that has vanished from `packages/ui/src` fails too. Both are
 * the `scripts/ci/gate.mjs` rule that an unresolvable input must never report "verified".
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'

const selfPath = fileURLToPath(import.meta.url)
const repoRoot = join(dirname(selfPath), '..', '..')
const webRoot = join(repoRoot, 'apps', 'web')
const nextDir = join(webRoot, '.next')
const manifestPath = join(nextDir, 'app-build-manifest.json')
const globalsPath = join(webRoot, 'src', 'app', 'globals.css')
const uiSrc = join(repoRoot, 'packages', 'ui', 'src')

/** The route whose stylesheet is under test: the landing page, whose LCP element is `Wordmark`. */
const GUARDED_ROUTE = '/page'

/**
 * Special files whose CSS the App Router attributes to their own manifest entry rather
 * than to the page that renders inside them. `globals.css` is imported by the root
 * layout, so `/page` lists no stylesheet and `/layout` lists the only one there is.
 */
const ANCESTOR_SPECIAL_FILES = ['layout', 'template', 'error', 'loading', 'not-found', 'default']

/**
 * The utilities whose presence is the assertion.
 *
 * Each is a real `Wordmark` class, not a sentinel: if it is missing the landing hero is
 * visibly wrong, which is the regression PER-231 is about. They are deliberately all
 * un-variant base utilities — a probe that only ever compiles under a variant (`md:`)
 * would need this gate to reconstruct Tailwind's variant selector escaping to find it.
 *
 * `reason` is printed in the summary so the accounting stays readable as the set erodes.
 */
const PROBES = [
  {
    utility: '[font-variant-ligatures:none]',
    reason: 'the entire implementation of the wordmark spec line that disables ligatures',
  },
  { utility: 'font-bold', reason: 'the wordmark is 700 weight at every size' },
  { utility: 'text-balance', reason: 'keeps a two-line hero wordmark even' },
  { utility: 'wrap-anywhere', reason: 'stops a long product name overflowing the hero column' },
  { utility: 'text-5xl', reason: 'the hero wordmark size' },
]

/** Files Tailwind's extractor never reads, so a probe appearing in one does not rescue it. */
const NON_SOURCE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'coverage'])
const NON_SOURCE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.pdf',
  '.zip',
  '.lock',
])

const reuseBuild = process.argv.includes('--reuse-build')

if (reuseBuild) {
  // Same reasoning as the `bundle` gate: the flag exists so a local run can iterate
  // without paying for a rebuild, and in CI it would be a silent correctness hole.
  // Pointed at a restored `.next` cache it reads a stylesheet built from another commit
  // and passes. Nothing passes it in CI today — `gate.mjs` runs `pnpm check:ui-source`
  // bare — and this keeps that true by construction rather than by convention.
  if (process.env.CI) {
    fail(
      '--reuse-build must not be used in CI. It reads whatever stylesheet is already in ' +
        `${rel(nextDir)}, which in CI may be a restored cache from another commit — the ` +
        'gate would then pass on CSS it never built. Drop the flag so the gate builds the ' +
        'tree under test.',
      'UI source gate misconfigured (--reuse-build in CI)',
    )
  }
  if (!existsSync(manifestPath)) {
    fail(
      `--reuse-build was passed but ${rel(manifestPath)} does not exist. ` +
        'Run this without the flag to build first.',
    )
  }
  console.log(`Reusing the existing build at ${rel(nextDir)} (--reuse-build).`)
} else {
  build()
}

const sourceConfig = readSourceConfig()
console.log(
  `${rel(globalsPath)} registers ${sourceConfig.included.length} extra source path(s) and ` +
    `excludes ${sourceConfig.excluded.length}:`,
)
for (const path of sourceConfig.included) console.log(`  @source     ${rel(path)}`)
for (const path of sourceConfig.excluded) console.log(`  @source not ${rel(path)}`)

const stylesheets = resolveRouteStylesheets()
const css = stylesheets.map((path) => readFileSync(path, 'utf8')).join('\n')
console.log(
  `\nStylesheet(s) loaded by ${GUARDED_ROUTE}: ` +
    `${stylesheets.map((p) => `${rel(p)} (${fmtBytes(statSync(p).size)})`).join(', ')}`,
)

// Tailwind escapes `:`, `[`, `]`, `/` and `.` in generated class selectors. Dropping every
// backslash turns `.\[font-variant-ligatures\:none\]` back into the utility's own name, so
// a probe can be matched literally without this gate reimplementing the escaping rules.
const unescapedCss = css.replaceAll('\\', '')

const scannedFiles = collectScannedFiles(sourceConfig.excluded)
const uiFiles = collectFiles(uiSrc, () => true)
console.log(
  `Scanned ${scannedFiles.length} Tailwind source file(s) under ${rel(webRoot)} and ` +
    `${uiFiles.length} under ${rel(uiSrc)} to re-check each probe.`,
)

const loadBearing = []
const notInUi = []
const claimedByWeb = []

for (const probe of PROBES) {
  if (!uiFiles.some((file) => fileMentions(file, probe.utility))) {
    notInUi.push(probe)
    continue
  }
  const claimant = scannedFiles.find((file) => fileMentions(file, probe.utility))
  if (claimant) {
    claimedByWeb.push({ ...probe, claimant })
    continue
  }
  loadBearing.push(probe)
}

if (notInUi.length > 0) {
  fail(
    `${notInUi.length} probe(s) no longer appear anywhere in ${rel(uiSrc)}: ` +
      `${notInUi.map((p) => `"${p.utility}"`).join(', ')}. The gate cannot assert a utility ` +
      'that the package does not use — its presence in the stylesheet would prove nothing. ' +
      `Replace it in PROBES in ${rel(selfPath)} with a utility the current components do ` +
      'use, and keep a one-line reason for why its absence would be visible.',
    'UI source gate has a stale probe',
  )
}

for (const probe of claimedByWeb) {
  console.log(
    `::notice title=UI source probe retired::"${probe.utility}" now also appears in ` +
      `${rel(probe.claimant)}, so apps/web's own sources would generate it. It is no longer ` +
      'evidence that packages/ui is registered and has been dropped from this run.',
  )
}

if (loadBearing.length === 0) {
  fail(
    `All ${PROBES.length} probe(s) are now used by apps/web itself, so none of them can ` +
      'show whether packages/ui is a registered Tailwind source. This gate would pass on ' +
      'a deleted `@source` line, which is the exact hole PER-231 exists to close. Add a ' +
      `utility that only \`packages/ui\` uses to PROBES in ${rel(selfPath)} — ` +
      `${rel(uiSrc)} is the tree to pick it from.`,
    'UI source gate has nothing left to prove',
  )
}

const missing = loadBearing.filter((probe) => !cssDefines(probe.utility))

console.log(
  `\n${loadBearing.length} of ${PROBES.length} probe(s) are packages/ui-only and were checked:`,
)
for (const probe of loadBearing) {
  console.log(
    `  ${cssDefines(probe.utility) ? 'present' : 'MISSING'}  .${probe.utility} — ${probe.reason}`,
  )
}

if (missing.length === 0) {
  console.log(
    `\nOK — every packages/ui-only utility checked reaches ${GUARDED_ROUTE}'s stylesheet, ` +
      'so packages/ui is a registered Tailwind source.',
  )
  process.exit(0)
}

const registered = sourceConfig.included.some(
  (path) => path === uiSrc || path.startsWith(uiSrc + sep),
)

fail(
  `${missing.length} ${missing.length === 1 ? 'utility' : 'utilities'} used by ` +
    `${rel(uiSrc)} ${missing.length === 1 ? 'is' : 'are'} absent from the stylesheet ` +
    `${GUARDED_ROUTE} loads:\n` +
    missing.map((p) => `  .${p.utility} — ${p.reason}`).join('\n') +
    '\n\n' +
    (registered
      ? `${rel(globalsPath)} does register ${rel(uiSrc)}, so the directive is present but ` +
        'not taking effect — check the relative path still resolves from the stylesheet, ' +
        'that the package directory has not been renamed, and whether a Tailwind upgrade ' +
        'changed how `@source` is resolved.'
      : `${rel(globalsPath)} does not register ${rel(uiSrc)} as a Tailwind source. Restore:\n` +
        "\n    @source '../../../../packages/ui/src';\n\n" +
        "Tailwind's automatic detection starts at apps/web's own root, so without that " +
        'line a utility only `packages/ui` uses is never generated and the component ships ' +
        'unstyled with no build error.') +
    `\n\nThe components rendering unstyled includes \`Wordmark\` on ${GUARDED_ROUTE}, the ` +
    "landing page's LCP element.",
  'packages/ui is not reaching the stylesheet',
)

/** Builds `apps/web` for production, with the same flags the `bundle` gate uses. */
function build() {
  console.log('Building apps/web (NEXT_PUBLIC_SETTINGS_FORM_PREVIEW=1)…')
  const result = spawnSync('pnpm', ['--filter', '@playhall/web', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    // Matching the `bundle` gate's flag keeps the two gates building the same tree, so a
    // stylesheet difference between them can never be the build configuration.
    env: { ...process.env, NEXT_PUBLIC_SETTINGS_FORM_PREVIEW: '1' },
  })

  if (result.error) fail(`Could not start the build: ${result.error.message}`)
  if ((result.status ?? 1) !== 0) fail(`apps/web build failed (exit ${result.status}).`)
}

/**
 * Reads the `@source` / `@source not` directives out of `globals.css`.
 *
 * Parsed from the stylesheet rather than duplicated here so the "is this probe still
 * load-bearing?" test below reads the same configuration the build does. Hard-coding
 * `apps/web/test` as the excluded directory would leave this gate quietly checking the
 * wrong file set the day that exclusion changes.
 */
function readSourceConfig() {
  if (!existsSync(globalsPath)) {
    fail(
      `${rel(globalsPath)} does not exist, so the gate cannot tell which files Tailwind ` +
        'scans for this app. If the stylesheet moved, update this gate to match.',
      'UI source gate could not read the stylesheet',
    )
  }
  const text = readFileSync(globalsPath, 'utf8')
  // Comments are stripped first: this file documents its own directives in prose, and a
  // quoted `@source` inside a comment would otherwise read as configuration.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const base = dirname(globalsPath)
  const included = []
  const excluded = []

  for (const match of code.matchAll(/@source\s+(not\s+)?['"]([^'"]+)['"]\s*;/g)) {
    const [, negated, spec] = match
    // A glob's non-magic prefix is enough: every consumer below only needs the directory
    // the directive reaches into, not the pattern that filters inside it.
    const literal = spec.split('*')[0]
    ;(negated ? excluded : included).push(resolve(base, literal))
  }

  if (included.length === 0 && excluded.length === 0) {
    fail(
      `${rel(globalsPath)} contains no @source directives at all. Tailwind would then scan ` +
        'only apps/web, and no packages/ui utility can reach the stylesheet.',
      'UI source gate found no @source directives',
    )
  }

  return { included, excluded }
}

/**
 * The stylesheet(s) `/` actually loads, read from the build manifest.
 *
 * Resolved through the route's ancestors, not from its own entry: `globals.css` is
 * imported by the root layout, and App Router lists a layout's CSS under `/layout` while
 * leaving `/page` an empty array. A gate that read the page entry alone would find no
 * stylesheet, and "no stylesheet to check" must never read as "nothing missing".
 */
function resolveRouteStylesheets() {
  if (!existsSync(manifestPath)) {
    fail(
      `${rel(manifestPath)} does not exist. The build did not produce a manifest, so there ` +
        'is no way to tell which stylesheet the landing page loads.',
    )
  }
  const pages = JSON.parse(readFileSync(manifestPath, 'utf8')).pages ?? {}

  if (!Object.hasOwn(pages, GUARDED_ROUTE)) {
    fail(
      `${rel(manifestPath)} has no "${GUARDED_ROUTE}" entry, so the landing page was not ` +
        `built. Known entries: ${Object.keys(pages).join(', ') || '(none)'}.`,
    )
  }

  const entries = [GUARDED_ROUTE, ...ancestorPageIds(GUARDED_ROUTE)].filter((id) =>
    Object.hasOwn(pages, id),
  )
  const files = [...new Set(entries.flatMap((id) => pages[id]).filter((f) => f.endsWith('.css')))]
  const paths = files.map((file) => join(nextDir, file))

  for (const path of paths) {
    if (!existsSync(path)) fail(`${rel(manifestPath)} lists ${file(path)} but it is not on disk.`)
  }
  if (paths.length === 0) {
    fail(
      `No stylesheet is attributed to ${GUARDED_ROUTE} or any of its ancestors in ` +
        `${rel(manifestPath)}. Either the app ships no CSS — in which case every ` +
        'packages/ui component is unstyled — or the manifest shape changed and this gate ' +
        'is looking in the wrong place. Both need a human, so this is a failure rather ' +
        'than an empty pass.',
    )
  }
  return paths
}

/** `/a/b/page` -> `['/a/b/layout', '/a/layout', '/layout', …]`, for every special file. */
function ancestorPageIds(pageId) {
  const segments = pageId.split('/').filter(Boolean).slice(0, -1)
  const ids = []
  for (let depth = segments.length; depth >= 0; depth--) {
    const prefix = segments.slice(0, depth).join('/')
    for (const special of ANCESTOR_SPECIAL_FILES) {
      ids.push(`/${prefix ? `${prefix}/` : ''}${special}`)
    }
  }
  return ids
}

/** Every file under `apps/web` that Tailwind's extractor would read, per `globals.css`. */
function collectScannedFiles(excluded) {
  return collectFiles(
    webRoot,
    (path) => !excluded.some((dir) => path === dir || path.startsWith(dir + sep)),
  )
}

function collectFiles(root, keep) {
  const out = []
  if (!existsSync(root)) return out
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (NON_SOURCE_DIRS.has(entry.name)) continue
        if (!keep(path)) continue
        stack.push(path)
        continue
      }
      if (!entry.isFile()) continue
      const dot = entry.name.lastIndexOf('.')
      if (dot > 0 && NON_SOURCE_EXTS.has(entry.name.slice(dot).toLowerCase())) continue
      if (!keep(path)) continue
      out.push(path)
    }
  }
  return out
}

/**
 * Whether a file contains the utility's name as a class candidate.
 *
 * Deliberately as blunt as Tailwind's own extractor, which reads candidates out of any
 * text and does not care whether it found one in a string literal, a comment or a
 * sentence of English. `.overflow-hidden` shipped for a year off the words "nowrap +
 * overflow-hidden" in a comment; a stricter match here would call a probe load-bearing
 * that the extractor can in fact rescue.
 */
function fileMentions(path, utility) {
  const text = readFileSync(path, 'utf8')
  let from = 0
  for (;;) {
    const at = text.indexOf(utility, from)
    if (at === -1) return false
    // A mention inside a longer utility (`text-wrap-anywhere` for `wrap-anywhere`) is a
    // different class and does not rescue this one.
    const before = text[at - 1]
    const after = text[at + utility.length]
    if (!isNameChar(before) && !isNameChar(after)) return true
    from = at + 1
  }
}

function isNameChar(char) {
  return char !== undefined && /[A-Za-z0-9_-]/.test(char)
}

/** Whether the stylesheet defines a rule for this utility's own class. */
function cssDefines(utility) {
  const needle = `.${utility}`
  let from = 0
  for (;;) {
    const at = unescapedCss.indexOf(needle, from)
    if (at === -1) return false
    // The selector has to end here, so `.text-balance` is not satisfied by
    // `.text-balance-foo`. A variant form (`.md:text-5xl`) is a different selector and is
    // not accepted either — see the note on PROBES.
    if (!isNameChar(unescapedCss[at + needle.length])) return true
    from = at + 1
  }
}

// Function declarations, not `const` arrows: the top-level build/reuse block above runs
// before this point in the module and calls `rel()` on its failure paths, which a `const`
// down here would answer with a TDZ ReferenceError instead of the error message.
function rel(path) {
  return relative(repoRoot, path) || '.'
}

function file(path) {
  return relative(nextDir, path)
}

function fmtBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`
}

function fail(message, title = 'UI source gate could not run') {
  console.error(`::error title=${title}::${message.replaceAll('\n', '%0A')}`)
  console.error(`\n${title}\n\n${message}\n`)
  process.exit(1)
}
