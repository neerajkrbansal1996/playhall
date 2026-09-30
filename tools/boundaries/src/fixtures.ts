/**
 * Reader for `tools/boundary-fixtures/*.fixture`.
 *
 * Fixtures are `.fixture`, not `.ts`, so they stay invisible to the real module graph, to
 * `tsc` and to ESLint (ADR-0002 §5). A fixture is a deliberate boundary violation: if it were
 * a normal source file, CI would be permanently red and the negative case would be useless as
 * evidence.
 *
 * Format — a small header, then one or more file blocks:
 *
 *     # expect: no-game-to-platform
 *     # why: a one-line statement of the violation being proven
 *     === file: games/fx-a/src/index.ts ===
 *     import { createRoom } from '@playhall/platform-core'
 *
 * `expect: none` means the fixture must produce **no** error — that is the positive control
 * that stops the suite from passing on a rule set that simply rejects everything.
 * `tool: declared-deps` routes the fixture to `check-declared-deps.mjs` instead of
 * dependency-cruiser, for the one rule dependency-cruiser cannot express.
 *
 * `unlink: platform-core, fx-b` omits those packages' workspace symlinks from the scratch repo,
 * so importing them does **not** resolve. That reproduces the production case the mini repo
 * otherwise cannot express: pnpm links a workspace package into `node_modules` only when the
 * importer *declares* it, and a game may never declare a platform package. Without this, every
 * illegal bare specifier resolves inside the harness, and the suite proves the rules fire under
 * conditions the real repo never produces — which is how a rule can pass its own fixture and
 * still be green on the realistic violation.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Which checker enforces the rule a fixture targets. */
export type FixtureTool = 'depcruise' | 'declared-deps'

export interface Fixture {
  /** Fixture file name, used as the test name. */
  readonly name: string
  /** Rule that must fire, or `null` for the positive control. */
  readonly expectRule: string | null
  /** One-line statement of what the fixture proves, shown on failure. */
  readonly why: string
  readonly tool: FixtureTool
  /**
   * Unscoped workspace package names whose `node_modules` symlink the scratch repo must NOT
   * create, so an import of them stays unresolved — the undeclared-dependency case.
   */
  readonly unlink: readonly string[]
  /** Repo-relative path -> file contents, written into the scratch repo verbatim. */
  readonly files: ReadonlyMap<string, string>
}

const HEADER_LINE = /^#\s*([a-z-]+)\s*:\s*(.*)$/
const FILE_BLOCK = /^===\s*file:\s*(.+?)\s*===$/

function parse(name: string, raw: string): Fixture {
  const header = new Map<string, string>()
  const files = new Map<string, string>()

  let currentPath: string | null = null
  let currentLines: string[] = []

  const flush = (): void => {
    if (currentPath !== null) {
      files.set(currentPath, `${currentLines.join('\n').trim()}\n`)
    }
  }

  for (const line of raw.split('\n')) {
    const fileBlock = FILE_BLOCK.exec(line)
    if (fileBlock?.[1] !== undefined) {
      flush()
      currentPath = fileBlock[1]
      currentLines = []
      continue
    }
    if (currentPath === null) {
      const headerLine = HEADER_LINE.exec(line)
      if (headerLine?.[1] !== undefined) header.set(headerLine[1], (headerLine[2] ?? '').trim())
      continue
    }
    currentLines.push(line)
  }
  flush()

  const expect = header.get('expect')
  if (expect === undefined) {
    throw new Error(`Fixture ${name} has no "# expect:" header. Say which rule must fire.`)
  }
  if (files.size === 0) {
    throw new Error(`Fixture ${name} declares no "=== file: <path> ===" block.`)
  }

  const tool = header.get('tool') ?? 'depcruise'
  if (tool !== 'depcruise' && tool !== 'declared-deps') {
    throw new Error(`Fixture ${name} has unknown "# tool: ${tool}".`)
  }

  const unlink = (header.get('unlink') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  return {
    name,
    expectRule: expect === 'none' ? null : expect,
    why: header.get('why') ?? '(no "# why:" given)',
    tool,
    unlink,
    files,
  }
}

/** Every fixture in `dir`, sorted by name so the suite reports in a stable order. */
export function loadFixtures(dir: string): Fixture[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.fixture'))
    .sort()
    .map((entry) => parse(entry, readFileSync(join(dir, entry), 'utf8')))
}
