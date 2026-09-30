#!/usr/bin/env node
/**
 * Builds the release bundle for `apps/realtime` and its source map, then
 * asserts the map's paths are repo-relative before anything can upload it.
 *
 * This is the artifact half of the source-map pipeline in
 * `docs/ENVIRONMENTS.md` §10. It exists as a script rather than an ad-hoc
 * `esbuild` invocation for one reason: the pipeline's failure modes are all
 * silent. A wrong outfile location, a stale `sourceRoot`, a frame convention
 * that does not match the uploaded artifact names — every one of them still
 * produces a green build, a `201` from the upload, and an accepted event. You
 * only find out when someone opens a production trace.
 *
 * So the properties a trace depends on are checked here, at build time:
 *
 *   1. every `sources` entry is repo-root-relative and names a real file;
 *   2. the entry module appears under its repo path, not a build-machine path;
 *   3. the bundle carries a `sourceMappingURL` so Sentry can follow it.
 *
 * Note what this retires. §10 used to instruct "build in-tree", because the raw
 * `sources` a bundler emits are relative to the outfile. Normalising the map
 * makes the outfile's location irrelevant — measured: building to a directory
 * outside the repository now yields the same clean paths. The instruction was
 * load-bearing only while nothing enforced the outcome; the check replaces it.
 *
 * The bundle is deliberately runtime-agnostic (`platform: neutral`, ESM). The
 * hosting runtime is open on PER-38 and `workerd` is a live candidate, so the
 * release artifact must not be Node-shaped even though today it runs on Node.
 *
 * It lives in the app rather than in `scripts/` because it needs a bundler, and
 * pnpm's isolated `node_modules` only resolves a dependency for the package that
 * declares it. The invariant it enforces is not app-specific, so that half lives
 * once in `scripts/release/sourcemap-paths.mjs` — `apps/web` needs the same
 * guarantee and must not re-derive it.
 *
 * Usage:  pnpm --filter @playhall/realtime build:release [-- --outdir <dir>]
 */
import { build } from 'esbuild'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const entry = join(repoRoot, 'apps', 'realtime', 'src', 'index.ts')

const outDirArg = process.argv.indexOf('--outdir')
const outDir =
  outDirArg === -1
    ? join(repoRoot, 'apps', 'realtime', 'dist')
    : resolve(process.cwd(), process.argv[outDirArg + 1] ?? '')

const outFile = join(outDir, 'index.js')
const mapFile = `${outFile}.map`
/** The repo-relative path we require to appear in the map. */
const entrySource = relative(repoRoot, entry).split('\\').join('/')

const { normaliseSourceMap, assertResolvable, SourcePathEscapedError } =
  await import('../../scripts/release/sourcemap-paths.mjs')

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  // Not `node`: PER-38 keeps a `workerd` runtime in play, and a bundle built for
  // Node's builtins cannot be moved there without a rebuild.
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  // Embedded so a trace renders surrounding source context without Sentry
  // needing to fetch anything.
  sourcesContent: true,
  // Every workspace import is inlined; only Node builtins and real externals
  // stay out. `zod` is bundled so the artifact is self-contained.
  packages: undefined,
  external: ['node:*'],
  absWorkingDir: repoRoot,
  logLevel: 'warning',
})

const map = JSON.parse(readFileSync(mapFile, 'utf8'))

try {
  normaliseSourceMap(map, { outDir, repoRoot })
} catch (error) {
  if (error instanceof SourcePathEscapedError) {
    console.error(`\n✗ ${error.message}\n`)
    console.error(
      'A source outside the tree cannot be made repo-relative, so it would reach\n' +
        'Sentry as a build-machine path. Vendor the module into the workspace, or\n' +
        'mark it external so it is not bundled.\n',
    )
    process.exit(1)
  }
  throw error
}

const problems = assertResolvable(map, {
  expectEntry: entrySource,
  fileExists: (source) => existsSync(join(repoRoot, source)),
})

if (problems.length > 0) {
  console.error('\n✗ source map does not resolve against this repository:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

const bundle = readFileSync(outFile, 'utf8')
if (!bundle.includes('//# sourceMappingURL=')) {
  console.error(
    '\n✗ bundle has no sourceMappingURL comment — Sentry follows it to find the\n' +
      '  map, so without it every frame arrives minified.\n',
  )
  process.exit(1)
}

writeFileSync(mapFile, JSON.stringify(map))

console.log(`✓ built ${relative(repoRoot, outFile)}  (${sizeKb(bundle)} KB)`)
console.log(`✓ ${map.sources.length} sources, all repo-relative and present on disk`)
console.log(`✓ entry module resolves as ${entrySource}`)
console.log('\n  sources:')
for (const source of map.sources) console.log(`    ${source}`)

function sizeKb(text) {
  return (Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)
}
