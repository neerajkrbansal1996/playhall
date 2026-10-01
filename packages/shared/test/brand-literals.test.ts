import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { APPROVED_NAME, INTERNAL_CODENAME } from '../src/brand.js'

/**
 * `brand.ts` claims to be the only place a brand string lives. `brand.test.ts` proves the
 * constant resolves correctly; this file proves the *claim* — that no second copy of the
 * name, and no baked-in host, exists anywhere in the shipping source.
 *
 * It is here rather than in a CI gate script because the invariant belongs to this file:
 * the day someone types the product name into a page instead of importing it, the test
 * that fails is the one sitting next to the constant they bypassed. The criterion on
 * [PER-194](/PER/issues/PER-194) was a case-insensitive grep for the old codename, run by
 * hand; a grep is only true for the commit it ran on, so it runs here on every commit
 * instead. This file cannot spell the codename itself — the scan would find it — so it
 * reads both literals from the constants.
 *
 * Scope: source files that can render copy — `.ts`, `.tsx`, `.css` — under `apps/`,
 * `packages/` and `games/`. Deliberately excluded:
 *
 * - **`docs/`, ADRs, READMEs, CHANGELOG.** They are a historical record of the rename and
 *   rewriting them would destroy the record.
 * - **`package.json` manifests.** A manifest cannot import a constant, so the rule it
 *   could follow is "be correct at rename time", which is what a grep is for, not a gate.
 * - **`*.d.ts`.** Generated, and `next-env.d.ts` carries a docs URL nobody wrote.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The two files allowed to contain the brand literals: the constant and its own test. */
const BRAND_SOURCES = ['packages/shared/src/brand.ts', 'packages/shared/test/brand.test.ts']

/**
 * Two codename occurrences in `@playhall/game-testkit` that this change deliberately does
 * not touch, because neither is user-visible and one is load-bearing:
 * `checks/actions.ts` names an intentionally-unknown probe key, and `internal/prepare.ts`
 * uses the codename in `DEFAULTS.seed` — the default RNG seed for every conformance
 * playout. Renaming that string changes the action sequence every conformance subject is
 * driven through, which is the testkit owner's call and not a side-effect of a brand fix.
 * They are listed here rather than dropped from the scan so the exception stays visible.
 */
const CODENAME_EXCEPTIONS = [
  'packages/game-testkit/src/checks/actions.ts',
  'packages/game-testkit/src/internal/prepare.ts',
]

const COPY_EXTENSIONS = ['.ts', '.tsx', '.css']
const ROOTS = ['apps', 'packages', 'games']

interface Hit {
  readonly file: string
  readonly line: number
  readonly text: string
}

/** Tracked files only: an untracked scratch file is not something the repo ships. */
function copySources(): readonly string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...ROOTS], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return out
    .split('\0')
    .filter((f) => f.length > 0)
    .filter((f) => COPY_EXTENSIONS.some((ext) => f.endsWith(ext)))
    .filter((f) => !f.endsWith('.d.ts'))
}

function scan(pattern: RegExp, allowlist: readonly string[] = []): readonly Hit[] {
  const hits: Hit[] = []
  for (const file of copySources()) {
    if (allowlist.includes(file)) continue
    const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n')
    lines.forEach((text, index) => {
      if (pattern.test(text)) hits.push({ file, line: index + 1, text: text.trim() })
    })
  }
  return hits
}

/** Readable failure: the point of the test is to name the file to fix. */
function format(hits: readonly Hit[]): string {
  return hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n')
}

describe('brand literals', () => {
  it('finds source files to scan at all', () => {
    // Without this the three cases below pass vacuously the moment the glob, the roots or
    // `git ls-files` stops working, which is the failure mode a grep-shaped gate has.
    const files = copySources()

    expect(files.length).toBeGreaterThan(50)
    expect(files).toContain('packages/shared/src/brand.ts')
    expect(files).toContain('packages/ui/src/wordmark.tsx')
  })

  it('keeps the approved name out of every source file but the constant and its test', () => {
    // The scope (`@playhall/…`) and the env prefix (`PLAYHALL_…`) are not the display
    // name, so the pattern is the exact display casing with a word boundary either side.
    const hits = scan(new RegExp(`\\b${APPROVED_NAME}\\b`), BRAND_SOURCES)

    expect(format(hits)).toBe('')
  })

  it('keeps the internal codename out of every source file but the constant and its test', () => {
    // The codename survives in `brand.ts` as the sentinel `isProvisional` compares
    // against — containing it to that one line is the whole point of the sentinel.
    const hits = scan(new RegExp(INTERNAL_CODENAME, 'i'), [
      ...BRAND_SOURCES,
      ...CODENAME_EXCEPTIONS,
    ])

    expect(format(hits)).toBe('')
  })

  it('still has exactly the two known codename exceptions, and no more', () => {
    // An allowlist that outlives its entries is how a gate goes quietly green. If the
    // testkit renames these, this case fails and the entry comes off the list.
    const stale = CODENAME_EXCEPTIONS.filter(
      (file) => !new RegExp(INTERNAL_CODENAME, 'i').test(readFileSync(join(repoRoot, file), 'utf8')),
    )

    expect(stale).toEqual([])
  })

  it('bakes no product host into the source', () => {
    // The planned host is unregistered (M5, [PER-44]) and its TLD is HSTS-preloaded, so a
    // wrong literal is a hard TLS error with no fallback. Origins are derived at request
    // time; the only hosts a source file may name are the loopback fallback and the
    // RFC 6761 reserved test TLDs used by fixtures.
    const hits = scan(
      /https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\$\{|[^\s'"`)]*\.(?:test|example|invalid|localhost)\b)[a-z0-9-]+\.[a-z]/i,
    )

    expect(format(hits)).toBe('')
  })
})
