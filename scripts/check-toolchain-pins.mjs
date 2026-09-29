#!/usr/bin/env node
// Toolchain consistency gate.
//
// Two failure modes this catches, both of which are invisible until CI behaves
// differently from a developer's machine:
//
//   1. A pnpm-lock.yaml nested inside a workspace package. That means someone ran
//      `pnpm install` from inside the package instead of the repo root, which
//      bypasses workspace resolution and installs a private copy of the toolchain.
//   2. Two packages declaring different versions of the same toolchain dependency.
//      Packages that share the conformance testkit must share one test runner and
//      one compiler, or a game can pass the suite under a runner the platform
//      never runs.
//
// Purely static: reads package.json files off disk, runs no install, and needs no
// dependencies. Safe to run on a dirty or partially installed workspace.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Dependencies whose version must be identical everywhere it is declared. These
// decide how code is compiled and how tests are run, so a disagreement means two
// packages are not actually being verified the same way.
const GOVERNED = ['typescript', 'vitest', '@vitest/coverage-v8']

// Directories we never descend into: installed trees, build output, and sibling
// git worktrees that belong to other branches.
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', 'dist', '.next', 'coverage'])

/** Read the workspace package globs out of pnpm-workspace.yaml. */
function workspaceGlobs() {
  const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  const globs = []
  let inPackages = false
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/#.*$/, '')
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      const entry = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/)
      if (entry) {
        globs.push(entry[1])
        continue
      }
      if (line.trim() !== '') break // a new top-level key ended the list
    }
  }
  return globs
}

/** Expand a pnpm workspace glob (only the `a/*` and `a/b/*` forms we use). */
function expandGlob(glob) {
  const star = glob.indexOf('*')
  if (star === -1) return [glob]
  const parent = glob.slice(0, star).replace(/\/$/, '')
  const parentPath = join(repoRoot, parent)
  let entries
  try {
    entries = readdirSync(parentPath)
  } catch {
    return [] // an optional workspace directory that does not exist yet
  }
  return entries
    .filter((name) => !SKIP_DIRS.has(name) && !name.startsWith('.'))
    .map((name) => join(parent, name))
    .filter((dir) => statSync(join(repoRoot, dir)).isDirectory())
}

/** Every tracked package directory, root included. */
function packageDirs() {
  const dirs = ['.']
  for (const glob of workspaceGlobs()) dirs.push(...expandGlob(glob))
  return dirs.filter((dir) => {
    try {
      return statSync(join(repoRoot, dir, 'package.json')).isFile()
    } catch {
      return false
    }
  })
}

/** Walk the repo for lockfiles, skipping installed and foreign trees. */
function findLockfiles(dir = repoRoot, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      findLockfiles(join(dir, entry.name), found)
    } else if (entry.name === 'pnpm-lock.yaml') {
      found.push(relative(repoRoot, join(dir, entry.name)))
    }
  }
  return found
}

const problems = []

// --- Check 1: exactly one lockfile, at the repo root. -----------------------
const nestedLockfiles = findLockfiles().filter((path) => path !== 'pnpm-lock.yaml')
if (nestedLockfiles.length > 0) {
  problems.push(
    [
      `Found ${nestedLockfiles.length} lockfile(s) outside the repo root:`,
      ...nestedLockfiles.map((path) => `    ${path}`),
      '  The root pnpm-lock.yaml is the only lockfile this repo has. Delete these and',
      '  run `pnpm install` from the repo root.',
    ].join('\n'),
  )
}

// --- Check 2: one declared version per governed dependency. -----------------
// `catalog:` counts as a version string like any other, so a workspace that moves
// every package onto the pnpm catalog passes by agreeing on the literal `catalog:`.
const declarations = new Map(GOVERNED.map((name) => [name, new Map()]))

for (const dir of packageDirs()) {
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(join(repoRoot, manifestPath), 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (!declarations.has(name)) continue
      const byRange = declarations.get(name)
      if (!byRange.has(range)) byRange.set(range, [])
      byRange.get(range).push(manifestPath)
    }
  }
}

for (const [name, byRange] of declarations) {
  if (byRange.size <= 1) continue
  const lines = [`\`${name}\` is declared at ${byRange.size} different versions:`]
  for (const [range, manifests] of byRange) {
    lines.push(`    ${range}`)
    for (const manifest of manifests) lines.push(`      ${manifest}`)
  }
  lines.push(
    '  Every package must agree. Declare the version once in pnpm-workspace.yaml',
    '  under `catalog:` and set each package to `"' + name + '": "catalog:"`.',
  )
  problems.push(lines.join('\n'))
}

if (problems.length > 0) {
  console.error('Toolchain check failed:\n')
  for (const problem of problems) console.error(`  - ${problem}\n`)
  process.exit(1)
}

console.log(`Toolchain check passed: one root lockfile, ${GOVERNED.length} governed deps agree.`)
