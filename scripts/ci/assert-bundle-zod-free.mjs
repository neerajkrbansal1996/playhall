#!/usr/bin/env node
/**
 * Asserts that zod is absent from the client chunks of the create-lobby route
 * (and of the landing page) in a production `apps/web` build.
 *
 * Why this is a gate and not a comment ([PER-126](/PER/issues/PER-126)):
 *
 * [PER-115](/PER/issues/PER-115) took zod (79,639 B raw) out of the
 * create-lobby route's client chunk by splitting the SDK's settings surface into
 * a dependency-free `@playhall/game-sdk/settings-form` subpath. That win rests
 * on three conventions, and *none* of them is visible in a diff:
 *
 *   1. `packages/game-sdk/src/settings-form.ts` imports nothing at runtime.
 *   2. The `apps/web` settings-form call sites import the readers from that
 *      subpath, not from the `@playhall/game-sdk` barrel, which also exports
 *      `settingsFormDescriptorSchema`.
 *   3. `apps/web/src/components/settings-form/index.ts` re-exports `./normalize`
 *      **type-only**; `normalize.ts` imports `settingsFieldSchema` as a value.
 *
 * The `no-zod-in-pure-settings` dependency-cruiser rule covers (1) only. This
 * covers the invariant itself: whatever the import graph looks like, the bytes
 * that reach the browser on that route carry no validator.
 *
 * ## What actually regresses (measured, PER-126)
 *
 * Conventions (2) and (3) turn out **not** to be load-bearing on their own. With
 * `sideEffects: false` on the SDK (which PER-115 added alongside the split),
 * production tree-shaking drops the schemas even when a client component imports a
 * value from the barrel, and even when the barrel re-exports `./normalize` as a
 * value — both were reintroduced and measured at an unchanged 12.1 kB route.
 *
 * What does ship zod is a client component that *calls* something zod-backed. So
 * this gate is not a proxy for "did someone use the wrong import specifier"; it is
 * the assertion that the optimisation those conventions rely on still holds. That
 * is the right thing to check, because `sideEffects: false` is a claim the SDK
 * makes about itself and nothing else verifies it.
 *
 * ## How it decides
 *
 * `next build` writes `.next/app-build-manifest.json`, which maps every App
 * Router page to the exact list of client chunks the browser loads for it. That
 * is the precise reading of "reachable from the route" — it is scoped per route,
 * so an unrelated page that legitimately needs zod on the client does not make
 * this gate red, and a server-only zod parse (which is the whole design, see
 * ADR-0007 §8) is invisible to it because server code is not in that manifest.
 *
 * Detection is by string literal, not by module name: bundlers rename
 * identifiers but never rewrite string contents, so zod's own issue codes
 * survive minification where `ZodError` does not.
 *
 * ## What this cannot see
 *
 * `app-build-manifest.json` lists each page's *initial* client chunks, so a
 * chunk split out by `next/dynamic` / `React.lazy` / `await import()` is tracked
 * in `react-loadable-manifest.json` instead and is outside the scan. `apps/web`
 * has zero such call sites today, so this is unexercised rather than a live hole
 * — but a lazily-imported zod caller would ship bytes this gate would miss, and
 * PER-20's real settings form is exactly the thing someone would reach for
 * `next/dynamic` on. Widen the scan to that manifest if that day comes.
 *
 * It also only covers the production webpack build: `next dev` does not
 * tree-shake, and a move to `--turbopack` emits a different manifest (ADR-0007
 * revisit triggers).
 *
 * ## Deliberately not a size budget
 *
 * A byte threshold drifts with every dependency bump and produces noise that
 * gets raised rather than investigated. The property — "no validator on this
 * route" — is what we actually care about, and it is binary. This is also why
 * this is not, and must not become, a general bundle-size dashboard.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const selfPath = fileURLToPath(import.meta.url)
const repoRoot = join(dirname(selfPath), '..', '..')
const webRoot = join(repoRoot, 'apps', 'web')
const nextDir = join(webRoot, '.next')
const manifestPath = join(nextDir, 'app-build-manifest.json')

/**
 * zod issue codes, used as fingerprints for "the validator is in this chunk".
 *
 * These are string *literals* in zod's own source, so a minifier preserves them
 * verbatim where an identifier like `ZodError` would be renamed. They are also
 * specific enough that app code will never contain them by accident.
 *
 * They span **both** version lineages the installed package ships, because
 * `zod@3.25.x` is a dual-version package (PER-126 review):
 *
 *   - `invalid_union_discriminator`, `invalid_intersection_types` — the v3
 *     lineage (`v3/ZodError.js`, `v3/types.js`). Both sit inside a single
 *     `util.arrayToEnum([...])` array literal, which a bundler cannot partially
 *     shake, so any shipped v3 zod carries both or neither.
 *   - `invalid_element` — the v4 lineage (`v4/core/errors.js`,
 *     `v4/core/schemas.js`). v4 renamed the issue codes outright, so **none** of
 *     the v3 markers appears anywhere in `v4/`.
 *
 * Without the v4 marker a module that imports `zod/v4` — zod's own documented
 * incremental-migration path from a `^3.25` install — would ship a full
 * validator that this gate cannot see. `selfCheckVariants()` below asserts
 * coverage per lineage rather than per package, so "zod grew a variant we have
 * no fingerprint for" is a loud failure instead of a silent pass.
 */
const ZOD_MARKERS = ['invalid_union_discriminator', 'invalid_intersection_types', 'invalid_element']

/**
 * The routes whose client graph must stay validator-free, keyed by
 * `app-build-manifest.json` page id.
 *
 * `create-lobby` lists two pages and needs only one of them present, because the
 * real route is still landing: `/play/[slug]/new` is [PER-20](/PER/issues/PER-20),
 * and until it exists `/dev/settings-form` is the preview harness that renders
 * the identical component tree (it is the route PER-115 measured). When PER-20
 * lands, both match and both are checked; when the harness is deleted with it,
 * the real route carries the gate. What is *not* allowed is neither of them
 * being in the build — see the `any` handling below.
 */
const GUARDED_ROUTES = [
  {
    label: 'create-lobby',
    // TODO(PER-20 / PER-201): `any` expires when the real route lands. Until
    // then it must stay `any`, because requiring a page that does not exist yet
    // would make this gate permanently red. The day `/play/[slug]/new` ships,
    // `any` means a rename of the real route still passes as long as the dev
    // harness survives — PER-201 is filed, and blocked by PER-20, to flip this
    // to `all` and drop the harness page.
    pages: ['/play/[slug]/new/page', '/dev/settings-form/page'],
    require: 'any',
  },
  {
    label: 'landing',
    pages: ['/page'],
    require: 'all',
  },
]

/**
 * App Router special files whose own client chunk `app-build-manifest.json`
 * attributes to an *ancestor* page id rather than repeating it in each page it
 * wraps (PER-126 review).
 *
 * A root `layout.tsx` that goes `use client` emits `app/layout-<hash>.js`, which
 * the manifest lists under the `/layout` key only — it appears in no guarded page
 * entry, yet the browser loads it on every guarded route. Scanning the page
 * entries alone therefore leaves a door open for exactly the regression this gate
 * exists to catch, and the theme provider / guest-identity context / brand header
 * are all candidates to walk through it.
 *
 * Shared *vendor* chunks are repeated in every page entry, so they were already
 * covered; this is specifically about a special file's own chunk.
 */
const ANCESTOR_SPECIAL_FILES = ['layout', 'template', 'error', 'loading', 'not-found', 'default']

const reuseBuild = process.argv.includes('--reuse-build')

if (reuseBuild) {
  // The flag exists so a local run can iterate without paying for a rebuild. In
  // CI it would be a silent correctness hole: pointed at a restored `.next`
  // cache it scans chunks from a different commit and passes. Nothing passes it
  // in CI today (`gate.mjs` runs `pnpm check:bundle-zod-free` bare) — this keeps
  // that true by construction rather than by convention.
  if (process.env.CI) {
    fail(
      '--reuse-build must not be used in CI. It scans whatever is already in ' +
        `${rel(nextDir)}, which in CI may be a restored cache from another commit — ` +
        'the gate would then pass on chunks it never built. Drop the flag so the gate ' +
        'builds the tree under test.',
      'Bundle gate misconfigured (--reuse-build in CI)',
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

const selfCheck = selfCheckVariants()
console.log(
  `zod fingerprints verified against the installed zod ${selfCheck.version} ` +
    `(${rel(selfCheck.root)}), per shipped variant:`,
)
for (const lineage of selfCheck.lineages) {
  console.log(
    `  ${lineage.subpaths.join(', ')} -> ${lineage.dir}/ : ` +
      `${lineage.markers.map((m) => `"${m}"`).join(', ')} ` +
      `(${lineage.files} runtime file(s))`,
  )
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const pages = manifest.pages ?? {}

if (Object.keys(pages).length === 0) {
  fail(`${rel(manifestPath)} lists no pages. The build did not produce a client graph to check.`)
}

/** Every chunk we decided to scan, mapped to the guarded routes that load it. */
const chunkOwners = new Map()
const checkedRoutes = []
/** Ancestor special-file page ids pulled into the scan, for the summary line. */
const ancestorsScanned = new Set()

/** Adds every `.js` chunk the manifest attributes to `pageId` to the scan set. */
function collect(pageId, owner) {
  for (const file of pages[pageId]) {
    if (!file.endsWith('.js')) continue // stylesheets cannot carry a validator
    if (!chunkOwners.has(file)) chunkOwners.set(file, new Set())
    chunkOwners.get(file).add(owner)
  }
}

/**
 * The special-file page ids of every App Router segment that wraps `pageId`.
 *
 * `/dev/settings-form/page` -> `/layout`, `/dev/layout`, `/dev/settings-form/layout`,
 * then the same for `template`, `error`, `loading`, `not-found` and `default`.
 */
function ancestorPageIds(pageId) {
  const segments = pageId.split('/').filter(Boolean)
  segments.pop() // drop the trailing `page`

  const prefixes = ['']
  for (const segment of segments) prefixes.push(`${prefixes[prefixes.length - 1]}/${segment}`)

  return prefixes.flatMap((prefix) =>
    ANCESTOR_SPECIAL_FILES.map((special) => `${prefix}/${special}`),
  )
}

for (const route of GUARDED_ROUTES) {
  const present = route.pages.filter((page) => Array.isArray(pages[page]))

  // The anti-placeholder condition. If the pages a guarded route names are all
  // absent — renamed, moved, deleted — there is nothing left to scan, and a
  // scan of nothing passes. That would leave a green gate guarding air, which is
  // strictly worse than no gate because it reads as enforcement.
  if (present.length === 0) {
    fail(
      `Guarded route "${route.label}" matched no page in ${rel(manifestPath)}.\n` +
        `  Looked for: ${route.pages.join(', ')}\n` +
        `  Build contains: ${Object.keys(pages).sort().join(', ')}\n\n` +
        'A route was renamed, moved or deleted. This is a hard failure on purpose: a gate that ' +
        'scans zero chunks passes, so it would go green while guarding nothing. Update ' +
        `GUARDED_ROUTES in ${rel(selfPath)} to the route's new page id.`,
      'Guarded route missing from the build',
    )
  }

  if (route.require === 'all' && present.length !== route.pages.length) {
    const missing = route.pages.filter((page) => !present.includes(page))
    fail(
      `Guarded route "${route.label}" is missing required page(s): ${missing.join(', ')}.\n` +
        `  Build contains: ${Object.keys(pages).sort().join(', ')}`,
    )
  }

  for (const page of present) {
    checkedRoutes.push(page)
    collect(page, `${route.label} (${page})`)

    // Ancestor special files are purely *additive* to the chunk set, so one that
    // does not exist contributes nothing and needs no presence requirement. The
    // ids are derived from the page's own segments rather than hard-coded, so a
    // renamed segment cannot silently drop an ancestor from the scan — which
    // would re-create this gate's silent-pass mode at a new site.
    for (const ancestor of ancestorPageIds(page)) {
      if (!Array.isArray(pages[ancestor])) continue
      ancestorsScanned.add(ancestor)
      collect(ancestor, `${route.label} (${page} <- ${ancestor})`)
    }
  }
}

// App Router cannot build without a root layout, so `/layout` absent from the
// manifest means the manifest was misread, not that the layout is gone. That
// earns the same hard failure as a missing guarded page.
if (!Array.isArray(pages['/layout'])) {
  fail(
    `${rel(manifestPath)} has no "/layout" entry.\n` +
      `  Build contains: ${Object.keys(pages).sort().join(', ')}\n\n` +
      'An App Router build always emits a root layout, so this means the manifest shape ' +
      `changed and ${rel(selfPath)} is reading it wrong. The root layout's own client chunk ` +
      'is listed under "/layout" and in no page entry, so losing it silently would drop ' +
      'bytes the browser loads on every guarded route out of the scan.',
    'Bundle gate cannot find the root layout',
  )
}

// The page-level anti-placeholder guard above proves every guarded route is in
// the build; it does not prove any of them contributes bytes. A page present with
// an empty (or CSS-only) chunk list scans nothing and would pass — the one place
// this script's failure mode is silent, and the backstop for the Turbopack risk
// in "Not covered". The `.js` filter is the likeliest trigger: a Next release or
// a bundler change that names client chunks `.mjs` reads the manifest fine,
// clears the page-presence guard, throws nothing, and reports green on 0 bytes.
if (chunkOwners.size === 0) {
  fail(
    `Every guarded route was found in ${rel(manifestPath)}, but none of them attributes a ` +
      'single .js chunk — so this gate scanned nothing and would have passed.\n' +
      `  Routes checked: ${checkedRoutes.join(', ')}\n\n` +
      'Most likely the manifest no longer names client chunks with a .js extension; check the ' +
      `extension filter in ${rel(selfPath)}. A zero-chunk scan is a hard failure on purpose: a ` +
      'green row that scanned 0 bytes reads as enforcement while guarding nothing.',
    'Bundle gate scanned zero chunks',
  )
}

const violations = []
let scannedBytes = 0

for (const [file, owners] of [...chunkOwners].sort()) {
  const absolute = join(nextDir, file)
  if (!existsSync(absolute)) {
    fail(
      `${rel(manifestPath)} lists chunk "${file}" but ${rel(absolute)} does not exist. ` +
        'The build output is inconsistent; re-run the build.',
    )
  }

  const source = readFileSync(absolute, 'utf8')
  scannedBytes += Buffer.byteLength(source)

  const hits = ZOD_MARKERS.filter((marker) => source.includes(marker))
  if (hits.length > 0) {
    violations.push({ file, owners: [...owners], hits, bytes: Buffer.byteLength(source) })
  }
}

console.log(
  `Scanned ${chunkOwners.size} client chunk(s) (${fmtBytes(scannedBytes)}) across ` +
    `${checkedRoutes.length} guarded route(s): ${checkedRoutes.join(', ')}` +
    (ancestorsScanned.size > 0
      ? `, plus ${ancestorsScanned.size} ancestor segment(s): ${[...ancestorsScanned].sort().join(', ')}`
      : '') +
    '.',
)

if (violations.length === 0) {
  console.log('PASS — no zod in any guarded client chunk.')
  process.exit(0)
}

const detail = violations
  .map(
    (v) =>
      `  ${v.file} (${fmtBytes(v.bytes)})\n` +
      `    loaded by: ${v.owners.join(', ')}\n` +
      `    matched:   ${v.hits.map((h) => `"${h}"`).join(', ')}`,
  )
  .join('\n')

fail(
  `zod is back in a guarded route's initial client chunks. ` +
    `${violations.length} guarded chunk(s) contain a zod fingerprint:\n\n${detail}\n\n` +
    'zod is a server-side validator (ADR-0007 §8: the descriptor is validated at registry\n' +
    'load, not in the browser). It measured 79,639 B raw on this route before PER-115, to\n' +
    're-check ~800 bytes of JSON the server had already checked.\n\n' +
    'The likely cause, in order:\n\n' +
    '  1. A client component (`use client`) now *calls* something zod-backed —\n' +
    '     `settingsFormDescriptorSchema.parse`, `settingsFieldSchema`, `checkSettingsForm`,\n' +
    '     or `normalizeSettingsForm`. This is the only vector that survives tree-shaking,\n' +
    '     so check it first. Parse on the server and pass the validated value across the\n' +
    '     boundary as a prop — that is what `/dev/settings-form/page.tsx` does.\n' +
    '  2. `@playhall/game-sdk` lost its `sideEffects: false`, or a module it re-exports\n' +
    '     gained a top-level side effect. That flag is what lets webpack drop the schemas\n' +
    '     when a client component imports a *value* from the barrel rather than from\n' +
    '     `@playhall/game-sdk/settings-form`. Without it, every such import ships zod.\n' +
    '     Prefer the subpath regardless; `import type` from the barrel is always free,\n' +
    '     because `verbatimModuleSyntax` erases it.\n' +
    '  3. A *value* re-export of `./normalize` from\n' +
    '     `apps/web/src/components/settings-form/index.ts` that a client component then\n' +
    '     uses. `normalize.ts` imports `settingsFieldSchema` as a value, so keep that line\n' +
    '     `export type { ... }` and import the functions from\n' +
    '     `@/components/settings-form/normalize` directly.\n\n' +
    'Note that (2) and (3) on their own are currently absorbed by production tree-shaking —\n' +
    'an *unused* barrel value import does not ship zod today. That is a bundler optimisation,\n' +
    'not a contract, and this gate is what tells you when it stops holding.\n\n' +
    'Run `pnpm check:bundle-zod-free` locally to reproduce. If a client genuinely must\n' +
    'validate at runtime, that is an ADR-0007 change and needs a CTO decision first — do not\n' +
    'widen this gate to make it pass.',
  'zod in the create-lobby client bundle',
)

/** Builds `apps/web` for production, with the settings-form preview route enabled. */
function build() {
  console.log('Building apps/web (NEXT_PUBLIC_SETTINGS_FORM_PREVIEW=1)…')
  const result = spawnSync('pnpm', ['--filter', '@playhall/web', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      // The preview harness is 404 without this, and more to the point it is the
      // flag PER-115 measured under. It is also what keeps `/dev/settings-form`
      // in the manifest at all.
      NEXT_PUBLIC_SETTINGS_FORM_PREVIEW: '1',
    },
  })

  if (result.error) fail(`Could not start the build: ${result.error.message}`)
  if ((result.status ?? 1) !== 0) fail(`apps/web build failed (exit ${result.status}).`)
}

/**
 * Confirms every importable zod variant contains at least one fingerprint.
 *
 * Without this the gate's failure mode is silence: if the markers stop matching
 * the code that actually ships, every scan comes back clean, the gate goes green,
 * and nothing says the check stopped checking.
 *
 * Checking the *package* is not enough, which is the PER-126 review finding.
 * `zod@3.25.76` ships two version lineages side by side, and v4 renamed the issue
 * codes, so a walk of the whole package root finds the v3 markers in `v3/` and
 * reports healthy while a `zod/v4` importer ships a validator carrying none of
 * them. Coverage therefore has to be asserted per lineage.
 *
 * The lineages are derived from the package's `exports` map rather than from a
 * directory listing, because `exports` is what a consumer can actually import: a
 * future `./v5` shows up here and demands a fingerprint, and a directory that is
 * not exported cannot be reached and does not matter.
 *
 * Re-export barrels are followed to the code they forward to instead of being
 * required to carry a marker themselves. zod's own entry is a 105-byte barrel and
 * `v4-mini/index.js` is a single `export * from "../v4/mini/index.js"`, so both
 * resolve onto another lineage's code — demanding a marker *in* them would fail
 * the gate on a file that holds no validator at all.
 */
function selfCheckVariants() {
  const require = createRequire(join(repoRoot, 'packages', 'game-sdk', 'package.json'))

  let zodRoot
  let zodPkg
  try {
    const pkgPath = require.resolve('zod/package.json')
    zodRoot = dirname(pkgPath)
    zodPkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    fail(
      `Could not resolve zod from packages/game-sdk: ${error.message}\n` +
        'The gate cannot verify its fingerprints without it. Run `pnpm install`.',
    )
  }

  // Every concrete (non-wildcard) entry point a consumer can import. Subpaths
  // below a lineage root (`./v4/core`, `./v4/mini`) resolve into the same
  // directory as the lineage itself, so they fold into one group below.
  const subpaths = Object.keys(zodPkg.exports ?? {}).filter(
    (key) =>
      (key === '.' || key.startsWith('./')) && !key.includes('*') && key !== './package.json',
  )

  if (subpaths.length === 0) {
    fail(
      `Could not read any entry points from ${rel(join(zodRoot, 'package.json'))}. ` +
        'The gate derives the variants it must fingerprint from zod\'s "exports" map, so an ' +
        'unreadable map means it cannot tell what shipped. Check the installed zod layout.',
      'zod fingerprint self-check failed',
    )
  }

  // Group entry points by the lineage directory their code really lives in.
  const lineageSubpaths = new Map()
  const unresolved = []
  for (const subpath of subpaths) {
    const entry = resolveEntry(zodRoot, zodPkg, subpath)
    if (!entry) {
      unresolved.push(subpath)
      continue
    }
    const dir = lineageDirOf(zodRoot, entry)
    if (!lineageSubpaths.has(dir)) lineageSubpaths.set(dir, [])
    lineageSubpaths.get(dir).push(subpath)
  }

  // Skipping an unresolvable subpath is the same silent-pass class as a lineage
  // with no marker, reached through a different door (PER-126 review): the
  // lineage simply vanishes from the loop below, `uncovered` stays empty, and the
  // gate prints "fingerprints verified" having checked less than it says.
  //
  // `resolveEntry` returns null for a directory target (`"./v5": "./v5"`), for a
  // condition object with no plain string under `import.default` / `import` /
  // `default` / `require.default` (`{"module": …, "browser": …}`, or a nested
  // `{"import": {"browser": …, "node": …}}`), and for a barrel chain over 10 hops.
  // The nested-browser-condition shape is not exotic — it is what a package ships
  // the day it adds a browser-conditional build, which is exactly when a new
  // validator lineage would arrive.
  //
  // This is a no-op against zod 3.25.76: all 7 concrete subpaths resolve today.
  if (unresolved.length > 0) {
    fail(
      'Fingerprint self-check failed. zod exports subpath(s) this gate could not resolve to a ' +
        'runtime file, so their code was never fingerprint-checked at all:\n' +
        unresolved.map((subpath) => `  ${subpath}`).join('\n') +
        `\n\nInstalled zod: ${zodPkg.version} at ${rel(zodRoot)}\n\n` +
        'An unresolvable entry point is a hard failure, not a skip: if it ships a validator ' +
        'this gate cannot see it, and the self-check would still report "verified". Teach ' +
        `resolveEntry() in ${rel(selfPath)} the shape zod now uses (it resolves the ESM ` +
        'condition, because that is what webpack picks for the client graph), then re-run.',
      'zod fingerprint self-check failed',
    )
  }

  const lineages = []
  const uncovered = []

  for (const [dir, dirSubpaths] of [...lineageSubpaths].sort()) {
    // `src/` is zod's shipped TypeScript and `tests/` its own suite. Neither is
    // what a bundler pulls in, so neither counts as evidence a marker is live.
    const runtimeFiles = walk(join(zodRoot, dir)).filter(
      (file) => /\.(js|cjs|mjs)$/.test(file) && !/[\\/](?:src|tests)[\\/]/.test(file),
    )

    const present = new Set()
    let matchingFiles = 0
    for (const file of runtimeFiles) {
      const source = readFileSync(file, 'utf8')
      const hits = ZOD_MARKERS.filter((marker) => source.includes(marker))
      if (hits.length > 0) matchingFiles += 1
      for (const hit of hits) present.add(hit)
    }

    const lineage = {
      dir,
      subpaths: dirSubpaths.sort(),
      markers: [...present],
      files: matchingFiles,
    }
    lineages.push(lineage)
    if (present.size === 0) uncovered.push(lineage)
  }

  if (uncovered.length > 0) {
    fail(
      'Fingerprint self-check failed. This zod build ships variant(s) whose issue codes are ' +
        'not fingerprinted, so a module importing one of them would ship a validator this ' +
        'gate cannot see:\n' +
        uncovered
          .map((l) => `  ${l.dir}/ — reachable as ${l.subpaths.join(', ')} — 0 markers`)
          .join('\n') +
        `\n\nCurrent markers: ${ZOD_MARKERS.map((m) => `"${m}"`).join(', ')}\n` +
        `Installed zod: ${zodPkg.version} at ${rel(zodRoot)}\n\n` +
        'zod was probably upgraded and renamed its issue codes, or grew a new version lineage ' +
        '(it has done both: v4 renamed every code v3 used). Pick a string literal from that ' +
        "variant's runtime source — an issue code is ideal, since bundlers preserve string " +
        `contents but rename identifiers — and add it to ZOD_MARKERS in ${rel(selfPath)}.\n` +
        'This is a failure rather than a warning because a fingerprint that matches nothing ' +
        'makes this gate pass unconditionally.',
      'zod fingerprint self-check failed',
    )
  }

  return { root: zodRoot, version: zodPkg.version, lineages }
}

/**
 * The runtime file an `exports` subpath resolves to, following re-export barrels.
 *
 * A barrel is not a code root: `zod`'s own entry and `zod/v4-mini` both just
 * forward elsewhere, so the lineage that owns their code is the one they point at.
 *
 * Returns null when the subpath's target is not a plain ESM string, is a
 * directory, or does not exist. The caller treats that as a hard failure rather
 * than a skip — an entry point this script cannot read is one it cannot
 * fingerprint, and "could not check" must never render as "checked".
 */
function resolveEntry(zodRoot, zodPkg, subpath) {
  const entry = zodPkg.exports[subpath]
  // Prefer the ESM condition: this gate is about what a browser bundler emits,
  // and that is the condition webpack resolves for `apps/web`'s client graph.
  const target =
    typeof entry === 'string'
      ? entry
      : (entry?.import?.default ?? entry?.import ?? entry?.default ?? entry?.require?.default)
  if (typeof target !== 'string') return null

  let file = join(zodRoot, target)
  for (let hop = 0; hop < 10; hop += 1) {
    if (!existsSync(file) || statSync(file).isDirectory()) return null
    const next = soleReexportTarget(file)
    if (!next) return file
    file = next
  }
  return file
}

/**
 * If `file` only forwards another module, the file it forwards to.
 *
 * Returns null for a file containing any real code, or one that fans out to more
 * than one module — in both cases the file itself is the lineage's code.
 *
 * zod's own entry is the shape this has to recognise, and it is more than bare
 * `export * from`:
 *
 *     import * as z from "./v3/external.js"
 *     export * from "./v3/external.js"
 *     export { z }
 *     export default z
 *
 * Every line either names the one target module or re-publishes a binding
 * already taken from it, so the file holds no validator of its own. ESM only, by
 * design: this gate cares about what a browser bundler emits, and that is the
 * `import` condition resolved above.
 */
function soleReexportTarget(file) {
  const code = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))

  const targets = new Set()
  for (const line of code) {
    // `import ... from "T"` / `export * from "T"` / `export { a, b } from "T"`
    const forwarding =
      /^(?:import|export)\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*["']([^"']+)["'];?$/.exec(
        line,
      )
    if (forwarding) {
      targets.add(forwarding[1])
      continue
    }
    // `export { z }` / `export default z` — re-publishing a binding that can only
    // have come from one of the targets above, so it adds no code of its own.
    if (/^export\s+\{[^}]*\}\s*;?$/.test(line)) continue
    if (/^export\s+default\s+\w+\s*;?$/.test(line)) continue

    return null // real code, so this file is the lineage
  }

  if (targets.size !== 1) return null
  const [target] = [...targets]
  if (!target.startsWith('.')) return null
  return join(dirname(file), target)
}

/** The top-level directory under the zod root that owns `file` (`v3`, `v4`, …). */
function lineageDirOf(zodRoot, file) {
  const segments = relative(zodRoot, file).split(/[\\/]/)
  return segments.length > 1 ? segments[0] : '.'
}

/** Every file under `dir`, recursively. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry)
    if (statSync(absolute).isDirectory()) out.push(...walk(absolute))
    else out.push(absolute)
  }
  return out
}

function rel(path) {
  return relative(repoRoot, path) || path
}

function fmtBytes(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`
}

/**
 * Fails the gate with a GitHub-annotated, self-explaining message.
 *
 * `title` is the annotation heading in the Actions UI, so it has to name the
 * *actual* failure: half of this script's exits are "the gate could not check"
 * rather than "zod is in the bundle", and annotating those as a zod regression
 * would send the reader looking for an import that is not there.
 */
function fail(message, title = 'Bundle gate could not run') {
  // `::error` renders in the Actions log and on the job summary; the plain copy
  // below it is what a local run reads.
  console.error(`::error title=${title}::${message.split('\n')[0]}`)
  console.error(`\nzod-free client bundle gate FAILED\n\n${message}\n`)
  process.exit(1)
}
