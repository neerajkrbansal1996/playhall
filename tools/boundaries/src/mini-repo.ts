/**
 * Builds a throwaway miniature of the workspace so a fixture can be cruised by the **real**
 * committed rule set without ever putting an illegal import in the real tree.
 *
 * Why a scratch repo rather than a scratch package inside the workspace: the rules match on
 * repo-relative paths (`^games/`, `^packages/platform-core/`), so the fixture has to sit at a
 * path that looks exactly like a workspace path. A directory inside the real repo would either
 * be picked up by `pnpm install`, `tsc -b` and `eslint .`, or would have to live at a path the
 * rules do not match — and a fixture the rules do not match proves nothing. A mini repo gives
 * true paths and cannot leak into anyone's build.
 *
 * `.dependency-cruiser.cjs` is copied, not re-written: the whole value of the negative suite is
 * that it exercises the file CI runs.
 */
import { cpSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'

/** Files copied verbatim from the real repo, so the fixtures test the committed rule set. */
const COPIED_FROM_REPO = [
  '.dependency-cruiser.cjs',
  'tools/boundaries/tsconfig.resolve.json',
  'tools/boundaries/resolve-anchor.d.ts',
]

/** Workspace packages the fixtures need to be able to reach (or be blocked from reaching). */
const STUB_PACKAGES = [
  { dir: 'packages/shared', name: '@atrium/shared' },
  { dir: 'packages/game-sdk', name: '@atrium/game-sdk' },
  { dir: 'packages/platform-core', name: '@atrium/platform-core' },
  { dir: 'packages/netcode', name: '@atrium/netcode' },
  { dir: 'packages/game-testkit', name: '@atrium/game-testkit' },
  { dir: 'packages/ui', name: '@atrium/ui' },
  // `fx-a` is the game under test; fixtures overwrite its files. `fx-b` is the second game, so
  // `no-game-to-game` has a real neighbour to be blocked from.
  { dir: 'games/fx-a', name: '@atrium/fx-a' },
  { dir: 'games/fx-b', name: '@atrium/fx-b' },
]

/** Source files the stub packages start with. All of these edges are legal. */
const STUB_SOURCES: Record<string, string> = {
  'packages/shared/src/index.ts': "export const BRAND_KEY = 'atrium'\n",
  // Not re-exported from index, so a deep import into it is the violation
  // `no-game-to-shared-internals` exists to catch.
  'packages/shared/src/room-code.ts': "export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'\n",
  'packages/game-sdk/src/index.ts': "export type GameId = string & { __brand: 'GameId' }\n",
  'packages/platform-core/src/index.ts':
    "import { BRAND_KEY } from '@atrium/shared'\nexport const brandKey = BRAND_KEY\n",
  'packages/netcode/src/index.ts': 'export const TICK_HZ = 30\n',
  'packages/game-testkit/src/index.ts':
    "import type { GameId } from '@atrium/game-sdk'\nexport type Conformance = { id: GameId }\n",
  'packages/ui/src/index.ts': "export const cn = (...parts: string[]) => parts.join(' ')\n",
  'apps/web/src/app/page.ts':
    "import { brandKey } from '@atrium/platform-core'\nexport default brandKey\n",
  'apps/realtime/src/index.ts':
    "import { brandKey } from '@atrium/platform-core'\nexport const boot = () => brandKey\n",
  'games/fx-a/src/index.ts':
    "import type { GameId } from '@atrium/game-sdk'\nexport const id = 'fx-a' as GameId\n",
  'games/fx-b/src/index.ts':
    "import type { GameId } from '@atrium/game-sdk'\nexport const id = 'fx-b' as GameId\n",
}

function write(root: string, relPath: string, contents: string): void {
  const target = join(root, relPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

function packageManifest(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: '0.0.0',
      private: true,
      type: 'module',
      main: './src/index.ts',
      types: './src/index.ts',
      // Only the root entry point is exported — same as the real packages, which is why a deep
      // import has to be written as a relative path to resolve at all.
      exports: { '.': './src/index.ts' },
    },
    null,
    2,
  )}\n`
}

/**
 * Creates the scratch repo and returns its canonical root.
 *
 * The path is realpath'd because on macOS `os.tmpdir()` is a symlink (`/var` -> `/private/var`).
 * dependency-cruiser resolves module paths through symlinks, so if cwd were the symlinked form
 * every resolved path would come back absolute instead of repo-relative and no rule would match.
 */
export function createMiniRepo(repoRoot: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atrium-boundaries-')))

  for (const relPath of COPIED_FROM_REPO) {
    const target = join(root, relPath)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(repoRoot, relPath), target)
  }

  write(
    root,
    'package.json',
    `${JSON.stringify({ name: 'atrium-scratch', private: true, type: 'module' }, null, 2)}\n`,
  )

  for (const { dir, name } of STUB_PACKAGES) {
    write(root, join(dir, 'package.json'), packageManifest(name))
  }
  write(root, 'apps/web/package.json', packageManifest('@atrium/web'))
  write(root, 'apps/realtime/package.json', packageManifest('@atrium/realtime'))

  for (const [relPath, contents] of Object.entries(STUB_SOURCES)) {
    write(root, relPath, contents)
  }

  // Workspace resolution: pnpm links workspace packages into node_modules, and that is how
  // `@atrium/platform-core` becomes the path `packages/platform-core/src/index.ts` in the graph.
  // Reproduce it with plain symlinks so the fixtures can use real package specifiers.
  const scope = join(root, 'node_modules', '@atrium')
  mkdirSync(scope, { recursive: true })
  for (const { dir, name } of STUB_PACKAGES) {
    const link = join(scope, name.replace('@atrium/', ''))
    symlinkSync(relative(dirname(link), join(root, dir)), link, 'dir')
  }

  // One real third-party package, so the positive control can prove third-party imports from a
  // game stay legal — the rules forbid reaching across our own boundaries, not using libraries.
  write(
    root,
    'node_modules/zod/package.json',
    `${JSON.stringify({ name: 'zod', version: '3.24.1', main: './index.js' }, null, 2)}\n`,
  )
  write(root, 'node_modules/zod/index.js', 'module.exports = { z: {} }\n')

  return root
}
