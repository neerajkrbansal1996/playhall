#!/usr/bin/env node
/**
 * Generates `apps/<app>/src/games.generated.ts`.
 *
 * ADR-0002 §3 allows exactly one platform -> game edge, and only from a file
 * matched by `^apps/[^/]+/src/games\.generated\.ts$`, and only as a **dynamic**
 * `import()`. The exception is safe because the file is *generated*: no
 * engineer hand-writes a platform->game import, so the allowlist cannot be
 * used as a loophole without editing a file whose header says not to.
 *
 * A game opts in by declaring its entry point in its own `package.json`:
 *
 *   "playhall": { "gameEntry": "./src/index.ts" }
 *
 * Opt-in rather than "every directory under games/" because a game package
 * that is mid-build should not break the lobby, and because the declaration
 * is reviewable in the game's own diff.
 *
 * Usage:
 *   node tools/generate-games-registry.mjs            # write
 *   node tools/generate-games-registry.mjs --check    # CI: fail if stale
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GAME_ROOTS = ['games', 'games/_examples']
/** Apps that host a registry. Each gets the same generated file. */
const TARGET_APPS = ['apps/web', 'apps/realtime']

const HEADER = `// ---------------------------------------------------------------------------
// GENERATED FILE — DO NOT EDIT.
//
// Regenerate with \`pnpm registry:generate\`. CI runs the same script with
// \`--check\` and fails if this file is stale.
//
// This is the ONE file in the repository allowed to reference a game package
// (ADR-0002 §3), and only through a dynamic \`import()\`. A static import here
// would pull every game into the shared chunk and break the promise that
// adding a game adds zero bytes to other bundles. \`packages/platform-core\`
// gets no such exception: it receives this list, it never builds it.
// ---------------------------------------------------------------------------
`

async function findGames() {
  const found = []
  for (const root of GAME_ROOTS) {
    const absoluteRoot = join(REPO_ROOT, root)
    if (!existsSync(absoluteRoot)) continue

    const dirents = await readdir(absoluteRoot, { withFileTypes: true })
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name.startsWith('_') || dirent.name.startsWith('.')) {
        continue
      }
      const packagePath = join(absoluteRoot, dirent.name, 'package.json')
      if (!existsSync(packagePath)) continue

      const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
      const entry = pkg.playhall?.gameEntry
      if (typeof entry !== 'string') continue

      if (!existsSync(join(absoluteRoot, dirent.name, entry))) {
        throw new Error(
          `${root}/${dirent.name}/package.json declares playhall.gameEntry '${entry}', which does not exist`,
        )
      }
      found.push({ slug: dirent.name, packageName: pkg.name })
    }
  }
  return found.sort((a, b) => a.slug.localeCompare(b.slug))
}

function render(games, appDir) {
  const lines = [HEADER]
  lines.push(`import type { GameRegistration } from '@playhall/platform-core'`, '')

  if (games.length === 0) {
    lines.push('/** No game package declares `playhall.gameEntry` yet. */')
    lines.push('export const GAME_REGISTRATIONS: readonly GameRegistration[] = []', '')
    return lines.join('\n')
  }

  lines.push('export const GAME_REGISTRATIONS: readonly GameRegistration[] = [')
  for (const game of games) {
    // Import by package name, not by relative path: the workspace resolves it,
    // and a relative path would escape the app and defeat bundler tree-shaping.
    lines.push(`  { slug: '${game.slug}', load: () => import('${game.packageName}') },`)
  }
  lines.push(']', '')
  // `appDir` is unused in the body today but keeps the signature honest: a
  // future app-specific filter (web gets client modules, realtime does not)
  // belongs here, not in a hand-edited copy.
  void appDir
  return lines.join('\n')
}

async function main() {
  const check = process.argv.includes('--check')
  const games = await findGames()
  let stale = 0

  for (const appDir of TARGET_APPS) {
    const target = join(REPO_ROOT, appDir, 'src', 'games.generated.ts')
    if (!existsSync(join(REPO_ROOT, appDir, 'src'))) continue

    const next = render(games, appDir)
    const current = existsSync(target) ? await readFile(target, 'utf8') : null

    if (current === next) continue
    if (check) {
      stale += 1
      console.error(`stale: ${relative(REPO_ROOT, target)}`)
      continue
    }
    await writeFile(target, next, 'utf8')
    console.log(`wrote: ${relative(REPO_ROOT, target)} (${games.length} game(s))`)
  }

  if (check && stale > 0) {
    console.error(
      `\n${stale} generated registry file(s) are stale. Run \`pnpm registry:generate\`.`,
    )
    process.exitCode = 1
    return
  }
  if (check) console.log(`generated registries are up to date (${games.length} game(s))`)
}

await main()
