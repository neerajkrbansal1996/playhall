#!/usr/bin/env node
/**
 * The `unit` gate's precondition: prove that every package expected to
 * contribute unit tests actually runs some.
 *
 * Why this exists (PER-99): the `unit` gate is `pnpm -r test`. `pnpm -r` runs a
 * script only in the packages that declare it and **exits 0 for the packages
 * that do not**, so a package with zero tests is indistinguishable from a
 * passing one. Measured on `main` @ 57162da: nine workspace projects were in
 * scope, five produced any test output, and the job concluded `success`. Two of
 * the packages the engineering standards hold to >= 80% — `platform-core` and
 * `netcode` — declared no `test` script at all and contributed nothing.
 *
 * This check is deliberately about *presence*, not percentage. The percentage
 * is the `coverage` gate's job (`scripts/ci/gate.mjs` -> `test:coverage`,
 * PER-89/PER-93). The two are different failures and deserve different
 * messages: "nobody is measuring this package" is not the same as "this package
 * is at 41%", and the first one is the one that hides.
 *
 * Pending entries follow the same contract as the gate registry in
 * `scripts/ci/gate.mjs`: a known, owned gap reports PENDING and passes, so the
 * absence is visible in the job summary instead of silent, and
 * `CI_STRICT_GATES=1` turns every PENDING into a hard failure. A pending entry
 * that is no longer true fails — a ledger nobody is forced to prune becomes a
 * second silent exemption, which is the bug this file exists to close.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Packages the >= 80% standard names directly. Every `games/*` package is added
 * to this set at runtime ("every game's rules code"), so a new game is enrolled
 * by existing rather than by remembering to edit a list here.
 */
const REQUIRED_DIRS = ['packages/game-sdk', 'packages/platform-core', 'packages/netcode']

/**
 * Known gaps, each with the issue that closes it. A package listed here reports
 * PENDING instead of failing. Delete the entry in the same commit that lands
 * the tests — this check fails if an entry is no longer true.
 */
const PENDING = {
  'packages/platform-core': 'PER-93 — vitest config and first tests (also carried on PR #14)',
  'packages/netcode':
    'PER-93 — vitest config and first tests. The kit itself is M6 and board-gated; the ' +
    'package is a documented placeholder until then, but a placeholder still has to be measured',
}

const strict = process.env.CI_STRICT_GATES === '1'
const packages = workspacePackages()

if (packages.length === 0) {
  fail('no workspace packages found — pnpm-workspace.yaml is not being read correctly')
  process.exit(2)
}

const required = new Set([
  ...REQUIRED_DIRS,
  ...packages.filter((pkg) => pkg.dir.startsWith('games/')).map((pkg) => pkg.dir),
])

for (const dir of REQUIRED_DIRS) {
  if (!packages.some((pkg) => pkg.dir === dir)) {
    fail(`required package "${dir}" is not a workspace package — update REQUIRED_DIRS`)
  }
}

const failures = []
const pendings = []
const rows = []

for (const pkg of packages) {
  const hasScript = Boolean(pkg.manifest.scripts?.test)
  const specCount = countSpecFiles(join(repoRoot, pkg.dir))
  const isRequired = required.has(pkg.dir)
  const problem = diagnose({ isRequired, hasScript, specCount })

  rows.push({ dir: pkg.dir, name: pkg.manifest.name, hasScript, specCount, problem })

  const pendingReason = Object.hasOwn(PENDING, pkg.dir) ? PENDING[pkg.dir] : null

  if (problem === null) {
    // A pending entry that has been fixed must be removed, or the ledger turns
    // into the silent exemption this check exists to prevent.
    if (pendingReason !== null) {
      failures.push(
        `${pkg.dir} is listed as PENDING but now satisfies the check — delete its entry ` +
          `from PENDING in scripts/ci/assert-test-scripts.mjs (was: ${pendingReason})`,
      )
    }
    continue
  }

  if (pendingReason !== null) {
    pendings.push(`${pkg.dir} — ${problem}. Owner: ${pendingReason}`)
    continue
  }

  failures.push(`${pkg.dir} — ${problem}`)
}

for (const dir of Object.keys(PENDING)) {
  if (!packages.some((pkg) => pkg.dir === dir)) {
    failures.push(`PENDING names "${dir}", which is not a workspace package — remove the entry`)
  }
}

report()

if (failures.length > 0) {
  for (const detail of failures) fail(detail)
  console.error(
    `\nunit gate precondition: ${failures.length} package(s) would have been skipped silently ` +
      'by `pnpm -r test`.',
  )
  process.exit(1)
}

if (pendings.length > 0 && strict) {
  for (const detail of pendings) fail(`${detail} (CI_STRICT_GATES=1)`)
  process.exit(1)
}

console.log(
  `unit gate precondition: ${rows.length} workspace package(s) checked, ` +
    `${pendings.length} pending, 0 failing.`,
)

/**
 * Returns a human-readable problem, or null when the package is fine.
 *
 * A package outside the required set is free to ship no tests — `apps/web` and
 * `packages/ui` are covered by the `e2e` gate, not by unit tests. What it is
 * *not* free to do is carry spec files nothing runs.
 */
function diagnose({ isRequired, hasScript, specCount }) {
  if (!hasScript) {
    if (isRequired) {
      return 'held to the >= 80% standard but declares no `test` script, so `pnpm -r test` skips it and exits 0'
    }
    if (specCount > 0) {
      return `has ${specCount} spec file(s) but declares no \`test\` script, so nothing runs them`
    }
    return null
  }
  if (isRequired && specCount === 0) {
    return 'declares a `test` script but ships no spec files, so the run passes on nothing'
  }
  return null
}

/** Workspace packages, as `{ dir, manifest }`, sorted by directory. */
function workspacePackages() {
  const found = new Map()

  for (const pattern of workspaceGlobs()) {
    for (const dir of expand(pattern)) {
      const manifestPath = join(repoRoot, dir, 'package.json')
      if (!existsSync(manifestPath)) continue
      found.set(dir, { dir, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) })
    }
  }

  return [...found.values()].sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * The `packages:` list out of pnpm-workspace.yaml. Parsed rather than
 * hard-coded so adding a workspace glob enrolls its packages here too; a
 * duplicated list would drift and drift silently.
 */
function workspaceGlobs() {
  const lines = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8').split('\n')
  const globs = []
  let inList = false

  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inList = true
      continue
    }
    if (!inList) continue
    const item = line.match(/^\s+-\s+(.+?)\s*$/)
    if (item === null) {
      if (line.trim() === '' || line.startsWith('#')) continue
      break // back at column 0: a different top-level key.
    }
    globs.push(item[1].replace(/^['"]|['"]$/g, ''))
  }

  return globs
}

/** Expands the one glob shape pnpm-workspace.yaml uses here: a literal path or a trailing `/*`. */
function expand(pattern) {
  if (!pattern.includes('*')) return [pattern]
  if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
    throw new Error(
      `pnpm-workspace.yaml pattern "${pattern}" is not supported by ` +
        'scripts/ci/assert-test-scripts.mjs — it handles a literal path or a trailing "/*".',
    )
  }

  const parent = pattern.slice(0, -2)
  const parentPath = join(repoRoot, parent)
  if (!existsSync(parentPath)) return []

  return readdirSync(parentPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => `${parent}/${entry.name}`)
}

/** Spec files under a package, ignoring build output and nested installs. */
function countSpecFiles(root) {
  const skip = new Set(['node_modules', 'dist', 'coverage', '.turbo', '.next'])
  let count = 0

  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // Unreadable directory: not a spec file either way.
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue
      const full = join(dir, entry.name)
      // `withFileTypes` reports a symlink as neither file nor directory.
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && safeIsDir(full))
      if (isDir) {
        walk(full)
        continue
      }
      if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) count += 1
    }
  }

  walk(root)
  return count
}

function safeIsDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function report() {
  const table = [
    '| package | `test` script | spec files | verdict |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => {
      const verdict =
        row.problem === null ? 'ok' : Object.hasOwn(PENDING, row.dir) ? 'PENDING' : 'FAIL'
      return `| \`${row.dir}\` | ${row.hasScript ? 'yes' : 'no'} | ${row.specCount} | ${verdict} |`
    }),
  ].join('\n')

  console.log(table)
  if (pendings.length > 0) {
    console.log('\nPending:')
    for (const detail of pendings) {
      console.log(`  - ${detail}`)
      console.log(`::notice title=unit gate pending::${detail}`)
    }
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return
  try {
    const pendingLines = pendings.map((detail) => `- PENDING ${detail}`).join('\n')
    appendFileSync(
      summaryPath,
      `### unit gate precondition\n\n${table}\n\n${pendingLines}${pendingLines ? '\n' : ''}`,
    )
  } catch {
    // A summary is nice-to-have; never fail a gate over it.
  }
}

function fail(detail) {
  console.error(`::error title=unit gate precondition::${detail}`)
}
