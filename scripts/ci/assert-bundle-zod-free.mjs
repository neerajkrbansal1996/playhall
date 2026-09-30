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
 * These are string *literals* in zod's own source (`v3/ZodError.js` and
 * `v3/types.js`, both of which any real use of zod pulls in), so a minifier
 * preserves them verbatim. They are also specific enough that app code will
 * never contain them by accident.
 *
 * Both are self-checked against the installed zod below. A zod upgrade that
 * renames them must fail this gate loudly rather than let it pass on a
 * fingerprint that no longer matches anything.
 */
const ZOD_MARKERS = ['invalid_union_discriminator', 'invalid_intersection_types']

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
    pages: ['/play/[slug]/new/page', '/dev/settings-form/page'],
    require: 'any',
  },
  {
    label: 'landing',
    pages: ['/page'],
    require: 'all',
  },
]

const reuseBuild = process.argv.includes('--reuse-build')

if (reuseBuild) {
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

const markerFiles = selfCheckMarkers()
console.log(
  `zod fingerprints verified against the installed zod ` +
    `(${ZOD_MARKERS.map((m) => `"${m}"`).join(', ')}, found in ${markerFiles} runtime file(s)).`,
)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const pages = manifest.pages ?? {}

if (Object.keys(pages).length === 0) {
  fail(`${rel(manifestPath)} lists no pages. The build did not produce a client graph to check.`)
}

/** Every chunk we decided to scan, mapped to the guarded routes that load it. */
const chunkOwners = new Map()
const checkedRoutes = []

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
    for (const file of pages[page]) {
      if (!file.endsWith('.js')) continue // stylesheets cannot carry a validator
      if (!chunkOwners.has(file)) chunkOwners.set(file, new Set())
      chunkOwners.get(file).add(`${route.label} (${page})`)
    }
  }
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
    `${checkedRoutes.length} guarded route(s): ${checkedRoutes.join(', ')}.`,
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
  `zod is in the create-lobby client graph again. ` +
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
 * Confirms every fingerprint still occurs in the installed zod's runtime files.
 *
 * Without this the gate's failure mode is silence: rename the codes upstream and
 * every scan stops matching, the gate goes green, and nothing says the check
 * stopped checking. zod's package entry is a 105-byte re-export barrel, so the
 * strings live one level down in `v3/` — hence a directory walk rather than a
 * read of the resolved entry file.
 */
function selfCheckMarkers() {
  const require = createRequire(join(repoRoot, 'packages', 'game-sdk', 'package.json'))

  let zodRoot
  try {
    zodRoot = dirname(require.resolve('zod/package.json'))
  } catch (error) {
    fail(
      `Could not resolve zod from packages/game-sdk: ${error.message}\n` +
        'The gate cannot verify its fingerprints without it. Run `pnpm install`.',
    )
  }

  // `src/` is zod's shipped TypeScript, `tests/` its own suite. Neither is what a
  // bundler would pull in, so neither should count as evidence the marker is live.
  const runtimeFiles = walk(zodRoot).filter(
    (file) => /\.(js|cjs|mjs)$/.test(file) && !/[\\/](?:src|tests)[\\/]/.test(file),
  )

  const counts = new Map(ZOD_MARKERS.map((marker) => [marker, 0]))
  for (const file of runtimeFiles) {
    const source = readFileSync(file, 'utf8')
    for (const marker of ZOD_MARKERS) {
      if (source.includes(marker)) counts.set(marker, counts.get(marker) + 1)
    }
  }

  const stale = ZOD_MARKERS.filter((marker) => counts.get(marker) === 0)
  if (stale.length > 0) {
    fail(
      `Fingerprint self-check failed. These marker(s) no longer appear anywhere in the ` +
        `installed zod (${rel(zodRoot)}):\n` +
        stale.map((marker) => `  "${marker}"`).join('\n') +
        '\n\nA fingerprint that matches nothing makes this gate pass unconditionally, so this ' +
        'is a failure rather than a warning. zod was probably upgraded and renamed its issue ' +
        `codes. Pick replacement string literals from zod's runtime source and update ` +
        `ZOD_MARKERS in ${rel(selfPath)}.`,
      'zod fingerprint self-check failed',
    )
  }

  return new Set(
    runtimeFiles.filter((file) => {
      const source = readFileSync(file, 'utf8')
      return ZOD_MARKERS.some((marker) => source.includes(marker))
    }),
  ).size
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
