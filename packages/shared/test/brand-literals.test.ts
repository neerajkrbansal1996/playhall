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

/**
 * A line carrying nothing but a comment. Used by the origin case only: an origin in a
 * doc comment is a citation, not something the client can request.
 */
const COMMENT_ONLY_LINE = /^(?:\/\/|\/\*|\*)/

interface ScanOptions {
  /** Files permitted to match, by repo-relative path. */
  readonly allowlist?: readonly string[]
  /** Skip lines whose trimmed form is only a comment. */
  readonly skipComments?: boolean
}

/**
 * The matcher, split out from the file walk so a case can feed it lines it wrote itself.
 * Without that seam the only pattern the suite can exercise is the one derived from
 * today's constants, which is exactly the pattern already known to work.
 */
function scanLines(
  pattern: RegExp,
  file: string,
  lines: readonly string[],
  options: ScanOptions = {},
): readonly Hit[] {
  const hits: Hit[] = []
  lines.forEach((text, index) => {
    const trimmed = text.trim()
    if (options.skipComments === true && COMMENT_ONLY_LINE.test(trimmed)) return
    if (pattern.test(text)) hits.push({ file, line: index + 1, text: trimmed })
  })
  return hits
}

function scan(pattern: RegExp, options: ScanOptions = {}): readonly Hit[] {
  const hits: Hit[] = []
  for (const file of copySources()) {
    if (options.allowlist?.includes(file) === true) continue
    const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n')
    hits.push(...scanLines(pattern, file, lines, options))
  }
  return hits
}

/**
 * The brand constants are **data**, so they are escaped before they become a pattern.
 * Interpolating them raw works only while the name happens to contain no regex
 * metacharacter, and a rename is the one event this suite exists to survive.
 */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Word boundaries, applied only at an edge where `\b` can actually match.
 *
 * The scope (`@playhall/…`) and the env prefix (`PLAYHALL_…`) are not the display name,
 * so the name is matched in its exact casing with a boundary either side — but `\b` sits
 * *between* a word and a non-word character, so a name ending in `!` or `+` would get a
 * boundary that can never match, and the case would go green while the literal is pasted
 * all over the tree. Omitting the boundary at a non-word edge keeps the pattern matching,
 * and errs towards one extra hit to triage rather than towards silence.
 */
function nameLiteralPattern(name: string): RegExp {
  const word = /\w/
  const left = word.test(name.slice(0, 1)) ? '\\b' : ''
  const right = word.test(name.slice(-1)) ? '\\b' : ''
  return new RegExp(`${left}${escapeLiteral(name)}${right}`)
}

/** The codename is matched case-insensitively and unanchored, so only escaping applies. */
function codenamePattern(codename: string): RegExp {
  return new RegExp(escapeLiteral(codename), 'i')
}

/**
 * An absolute `http(s)` origin that is neither loopback, nor interpolated, nor one of the
 * RFC 6761 reserved TLDs fixtures are allowed to use.
 */
const REMOTE_ORIGIN =
  /https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\$\{|[^\s'"`)]*\.(?:test|example|invalid|localhost)\b)[a-z0-9-]+\.[a-z]/i

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
    const hits = scan(nameLiteralPattern(APPROVED_NAME), { allowlist: BRAND_SOURCES })

    expect(format(hits)).toBe('')
  })

  it('keeps the internal codename out of every source file but the constant and its test', () => {
    // The codename survives in `brand.ts` as the sentinel `isProvisional` compares
    // against — containing it to that one line is the whole point of the sentinel.
    const hits = scan(codenamePattern(INTERNAL_CODENAME), {
      allowlist: [...BRAND_SOURCES, ...CODENAME_EXCEPTIONS],
    })

    expect(format(hits)).toBe('')
  })

  // A rename is the one event this suite exists to survive, and the constants reach the
  // pattern by interpolation, so every plausible next name must still match itself and
  // still reject a near-miss. `Go!` is the row that matters: `\b` sits between a word and
  // a non-word character, so an unescaped `\bGo!\b` can never match, and the two cases
  // above would stay green on a tree with the literal pasted all over it. A guard that
  // fails *open* on a rename is worse than no guard, because by then it is trusted.
  //
  // The fixture names are synthetic rather than variations on the real constant because
  // this file is itself scanned by the cases above: a fixture spelling the approved name
  // would be a real hit, and allowlisting this file to dodge that would stop the strongest
  // guard covering the file that implements it.
  it.each([
    { name: 'Carrom', planted: 'Welcome to Carrom', decoy: 'Welcome to Carroms' },
    { name: 'Car.rom', planted: 'the Car.rom app', decoy: 'the CarXrom app' },
    { name: 'Carrom+', planted: 'Carrom+ members', decoy: 'Carromm members' },
    { name: 'Car(rom)', planted: '<h1>Car(rom)</h1>', decoy: '<h1>Carrom</h1>' },
    { name: 'Go!', planted: "title = 'Go!'", decoy: "title = 'Going'" },
    { name: 'Lobby[s]', planted: 'Lobby[s] rules', decoy: 'Lobbys rules' },
  ])('still finds the name after a rename to $name', ({ name, planted, decoy }) => {
    const hits = scanLines(nameLiteralPattern(name), 'planted.tsx', [decoy, planted])

    expect(hits).toEqual([{ file: 'planted.tsx', line: 2, text: planted }])
  })

  it('still finds a codename containing a metacharacter, and not its near-miss', () => {
    const hits = scanLines(codenamePattern('Car.rom'), 'planted.ts', ['CarXrom', 'car.rom'])

    expect(hits).toEqual([{ file: 'planted.ts', line: 2, text: 'car.rom' }])
  })

  it('still has exactly the two known codename exceptions, and no more', () => {
    // An allowlist that outlives its entries is how a gate goes quietly green. If the
    // testkit renames these, this case fails and the entry comes off the list.
    const stale = CODENAME_EXCEPTIONS.filter(
      (file) =>
        !new RegExp(INTERNAL_CODENAME, 'i').test(readFileSync(join(repoRoot, file), 'utf8')),
    )

    expect(stale).toEqual([])
  })

  it('bakes no remote origin into code, outside of a comment', () => {
    // The planned host is unregistered (M5, [PER-44]) and its TLD is HSTS-preloaded, so a
    // wrong literal is a hard TLS error with no fallback. Origins are derived at request
    // time; the only hosts a source file may name are the loopback fallback and the
    // RFC 6761 reserved test TLDs used by fixtures.
    //
    // The invariant is "no remote origin baked into a value that could be requested", so
    // it is about code, not prose. A `@see` link to MDN or to a spec is a citation, and
    // failing the build on one teaches the next author that the cheapest fix is deleting
    // the citation. A URL sitting *beside* code on the same line is still a hit, so the
    // exemption cannot be bought by appending `// …`.
    const hits = scan(REMOTE_ORIGIN, { skipComments: true })

    expect(format(hits)).toBe('')
  })

  it('exempts a cited origin in a comment but not one in code', () => {
    // Assembled at runtime for the same reason the rename fixtures are synthetic: this
    // file is scanned by the case above, so a fixture spelling a remote origin in one
    // piece would be a real hit on itself.
    const origin = (host: string) => `https:${'//'}${host}/css2?family=Inter`
    const hits = scanLines(
      REMOTE_ORIGIN,
      'planted.css',
      [
        ` * @see ${origin('developer.mozilla.org')}`,
        `// Spec: ${origin('www.w3.org')}`,
        `/* ${origin('fonts.googleapis.com')} */`,
        `@import url('${origin('fonts.googleapis.com')}');`,
      ],
      { skipComments: true },
    )

    expect(format(hits)).toBe(`planted.css:4: @import url('${origin('fonts.googleapis.com')}');`)
  })
})
