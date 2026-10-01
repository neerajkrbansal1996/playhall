import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The `bundle` gate (PER-126) asserts zod is absent from the create-lobby route's
 * client chunks. Its real risk is not a false red — it is a *silent pass*: every
 * way this script can end up checking less than it says still exits 0 and prints
 * a confident summary. Three such doors were found by review, each by probing a
 * fabricated repo root by hand. Hand probes prove the fix on the day; they do not
 * stop the door reopening. These cases pin them.
 *
 * Each case builds a complete fake repo in a scratch directory — the real gate
 * script, a fake `apps/web/.next` manifest with chunks on disk, and a fake zod
 * whose `exports` map is the variable under test — and runs the gate against it
 * with `--reuse-build`. Nothing here touches the real build or the real zod, so
 * the cases are fast and independent of what is installed.
 *
 * The script is *copied* from `scripts/ci/` rather than reimplemented, so these
 * cases cannot drift away from the gate they are testing.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const gatePath = join(repoRoot, 'scripts', 'ci', 'assert-bundle-zod-free.mjs')

/** v3 lineage fingerprints, as they appear in `v3/ZodError.js`. */
const V3_MARKERS = 'invalid_union_discriminator, invalid_intersection_types'
/** v4 renamed every issue code; this is the one the gate fingerprints. */
const V4_MARKER = 'invalid_element'
/** A code belonging to no fingerprinted lineage — a validator the gate cannot see. */
const UNSEEN_MARKER = 'invalid_shape_v5'

type ExportsMap = Record<string, unknown>

interface Fixture {
  /** Extra `exports` entries merged over the baseline zod map. */
  zodExports?: ExportsMap
  /** Extra files written under the fake zod root, keyed by relative path. */
  zodFiles?: Record<string, string>
  /** Contents of the chunk the manifest attributes to `/layout` only. */
  layoutChunk?: string
}

/**
 * A fake zod that mirrors the shape of the installed 3.25.x: a barrel entry that
 * forwards to `v3/`, a separate `v4/` lineage with renamed codes, and a
 * `v4-mini/` barrel that forwards into `v4/`. That last one matters — it is the
 * file whose emptiness forced the gate to follow re-export barrels instead of
 * demanding a marker in every root.
 */
const BASE_ZOD_EXPORTS: ExportsMap = {
  '.': { import: { default: './index.js' }, require: { default: './index.cjs' } },
  './v3': './v3/external.js',
  './v4': './v4/index.js',
  './v4/mini': './v4/mini/index.js',
  './v4-mini': './v4-mini/index.js',
  './package.json': './package.json',
}

const BASE_ZOD_FILES: Record<string, string> = {
  'index.js':
    'import * as z from "./v3/external.js";\nexport * from "./v3/external.js";\nexport { z };\nexport default z;\n',
  'index.cjs': 'module.exports = require("./v3/external.js");\n',
  'v3/external.js': `export const codes = ["${V3_MARKERS.split(', ').join('", "')}"];\n`,
  'v4/index.js': `export const codes = ["${V4_MARKER}"];\n`,
  'v4/mini/index.js': `export const codes = ["${V4_MARKER}"];\n`,
  'v4-mini/index.js': 'export * from "../v4/mini/index.js";\n',
}

function buildFakeRepo(fixture: Fixture = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'bundle-zod-gate-'))

  // The gate derives repoRoot from its own location, so it has to live at the
  // same depth as the real one.
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true })
  cpSync(gatePath, join(root, 'scripts', 'ci', 'assert-bundle-zod-free.mjs'))

  // The gate resolves zod the way the SDK would, from packages/game-sdk.
  mkdirSync(join(root, 'packages', 'game-sdk'), { recursive: true })
  writeFileSync(
    join(root, 'packages', 'game-sdk', 'package.json'),
    JSON.stringify({ name: '@playhall/game-sdk', version: '0.0.0' }),
  )

  const zodRoot = join(root, 'node_modules', 'zod')
  writeFileSync(
    writeDir(join(zodRoot, 'package.json')),
    JSON.stringify({
      name: 'zod',
      version: '3.25.76-fixture',
      exports: { ...BASE_ZOD_EXPORTS, ...(fixture.zodExports ?? {}) },
    }),
  )
  for (const [path, contents] of Object.entries({
    ...BASE_ZOD_FILES,
    ...(fixture.zodFiles ?? {}),
  })) {
    writeFileSync(writeDir(join(zodRoot, path)), contents)
  }

  // A minimal but structurally faithful app-build-manifest: one shared chunk on
  // both guarded routes, one route-specific chunk, and the root layout's own
  // chunk — which the manifest attributes to `/layout` and to no page entry.
  const chunks = {
    'static/chunks/shared.js': 'export const shared = 1;\n',
    'static/chunks/settings.js': 'export const settings = 1;\n',
    'static/chunks/layout.js': fixture.layoutChunk ?? 'export const layout = 1;\n',
  }
  const nextDir = join(root, 'apps', 'web', '.next')
  for (const [path, contents] of Object.entries(chunks)) {
    writeFileSync(writeDir(join(nextDir, path)), contents)
  }
  writeFileSync(
    join(nextDir, 'app-build-manifest.json'),
    JSON.stringify({
      pages: {
        '/layout': ['static/chunks/layout.js'],
        '/page': ['static/chunks/shared.js'],
        '/dev/settings-form/page': ['static/chunks/shared.js', 'static/chunks/settings.js'],
      },
    }),
  )

  return root
}

/** Creates the parent directory of `path` and returns `path`, for inline writes. */
function writeDir(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  return path
}

function runGate(fixture: Fixture = {}): { status: number | null; output: string } {
  const root = buildFakeRepo(fixture)
  // CI is stripped deliberately: `--reuse-build` is a hard failure under CI (it
  // would scan a restored cache), and these cases supply the build themselves.
  const env = { ...process.env }
  delete env.CI
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'ci', 'assert-bundle-zod-free.mjs'), '--reuse-build'],
    { cwd: root, encoding: 'utf8', env },
  )
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

describe('the bundle gate scans what it claims to scan', () => {
  it('passes on a clean build, having checked both guarded routes and the layout chunk', () => {
    const { status, output } = runGate()

    expect(status).toBe(0)
    expect(output).toContain('PASS — no zod in any guarded client chunk')
    expect(output).toContain('/dev/settings-form/page')
    expect(output).toContain('/page')
    // The ancestor scan is the whole point of the first review finding: if this
    // line goes missing the layout case below is the only thing that notices.
    expect(output).toContain('ancestor segment(s): /layout')
  })

  it('fails when zod is only in the root layout chunk, which no page entry lists', () => {
    const { status, output } = runGate({
      layoutChunk: `export const codes = ["${V4_MARKER}"];\n`,
    })

    expect(status).toBe(1)
    expect(output).toContain('zod is back in a guarded route')
    expect(output).toContain('static/chunks/layout.js')
    expect(output).toContain('<- /layout')
  })
})

describe('the bundle gate fingerprint self-check fails closed', () => {
  it('fails when a shipped lineage carries none of the fingerprints', () => {
    const { status, output } = runGate({
      zodExports: { './v5': './v5/index.js' },
      zodFiles: { 'v5/index.js': `export const codes = ["${UNSEEN_MARKER}"];\n` },
    })

    expect(status).toBe(1)
    expect(output).toContain('variant(s) whose issue codes are not fingerprinted')
    expect(output).toContain('v5/ — reachable as ./v5 — 0 markers')
  })

  // The three shapes below all make `resolveEntry` return null. Before the
  // PER-126 review fix each was skipped silently and the gate printed
  // "fingerprints verified" — a validator lineage shipping real code that the
  // scan had never been taught to recognise, with nothing in the log saying so.
  const unresolvable: Array<[string, unknown, Record<string, string>]> = [
    [
      'the entry is a directory (exports sugar)',
      './v5',
      { 'v5/index.js': `export const codes = ["${UNSEEN_MARKER}"];\n` },
    ],
    [
      'the condition object has no ESM string (module/browser only)',
      { module: './v5/index.js', browser: './v5/browser.js' },
      {
        'v5/index.js': `export const codes = ["${UNSEEN_MARKER}"];\n`,
        'v5/browser.js': `export const codes = ["${UNSEEN_MARKER}"];\n`,
      },
    ],
    [
      'the import condition is itself nested (browser/node, no bare default)',
      { import: { browser: './v5/browser.js', node: './v5/index.js' } },
      {
        'v5/index.js': `export const codes = ["${UNSEEN_MARKER}"];\n`,
        'v5/browser.js': `export const codes = ["${UNSEEN_MARKER}"];\n`,
      },
    ],
  ]

  for (const [label, entry, files] of unresolvable) {
    it(`fails, naming the subpath, when ${label}`, () => {
      const { status, output } = runGate({ zodExports: { './v5': entry }, zodFiles: files })

      expect(status).toBe(1)
      expect(output).toContain('could not resolve to a runtime file')
      expect(output).toContain('./v5')
      // The distinguishing assertion: the old behaviour was to skip and report
      // success, so "did not pass" is not enough — it must not claim verification.
      expect(output).not.toContain('PASS — no zod')
    })
  }

  it('still passes when every subpath resolves, so the check is not red by default', () => {
    const { status, output } = runGate({
      zodExports: { './v5': { import: { default: './v5/index.js' } } },
      zodFiles: { 'v5/index.js': `export const codes = ["${V4_MARKER}"];\n` },
    })

    expect(status).toBe(0)
    expect(output).toContain('PASS — no zod in any guarded client chunk')
  })
})
