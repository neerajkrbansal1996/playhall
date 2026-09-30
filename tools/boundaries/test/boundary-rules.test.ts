/**
 * The negative case PER-5 asks for: "a deliberately added illegal import in a game package
 * fails CI with a readable error naming the rule, and that negative case is committed as a
 * test."
 *
 * Every fixture in `tools/boundary-fixtures` is copied into a scratch miniature of the
 * workspace, cruised by the **committed** `.dependency-cruiser.cjs`, and asserted on three
 * things:
 *
 *   1. the checker exits non-zero — the build really does fail;
 *   2. the expected rule name appears in the output — the *right* rule fired, which is the
 *      whole point. A test that only asserts "something failed" passes just as happily when
 *      the wrong rule fires for the wrong reason;
 *   3. no *other* error-level rule fired — the rule is precise, not a blanket reject.
 *
 * Plus two suite-level guards: a positive control (the legal shapes stay legal) and a coverage
 * check that no error-level rule exists without a fixture. ADR-0002 §2: "a rule with no fixture
 * is a rule we have not proven works."
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import { loadFixtures, type Fixture } from '../src/fixtures.js'
import { applyScope, createMiniRepo, workspaceScope } from '../src/mini-repo.js'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const fixtureDir = join(repoRoot, 'tools', 'boundary-fixtures')

// Addressed by path rather than `require.resolve`: dependency-cruiser's `exports` map does not
// publish its bin subpath, and we deliberately want the same binary the root `pnpm boundaries`
// script runs.
const DEPCRUISE_BIN = join(
  repoRoot,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruiser.mjs',
)
const DECLARED_DEPS_SCRIPT = join(repoRoot, 'tools', 'boundaries', 'check-declared-deps.mjs')

interface Rule {
  name: string
  severity: string
  comment?: string
}

const ruleSet = require(join(repoRoot, '.dependency-cruiser.cjs')) as { forbidden: Rule[] }
const rulesByName = new Map(ruleSet.forbidden.map((rule) => [rule.name, rule]))
const errorRules = ruleSet.forbidden
  .filter((rule) => rule.severity === 'error')
  .map((rule) => rule.name)

/** `err-long` wraps its output to the terminal width, so compare on collapsed whitespace. */
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

const fixtures = loadFixtures(fixtureDir)

/** Fixtures write `@scope/...`; the real scope is read from the SDK manifest (see mini-repo). */
const scope = workspaceScope(repoRoot)

/**
 * Rules `check-declared-deps.mjs` enforces, mapped to the explanation it prints for each.
 * `no-illegal-declared-dep` lives there only; `no-platform-framework-in-games` is enforced in both
 * places — dependency-cruiser catches the import, the script catches the manifest declaration — so
 * it appears here *and* in the dependency-cruiser rule set, with a fixture for each half.
 */
const SCRIPT_ENFORCED_EXPLANATIONS: Record<string, string> = {
  'no-illegal-declared-dep': `A game package may declare exactly one ${scope} dependency`,
  'no-platform-framework-in-games': 'ADR-0001 §4.2 condition 2: no game imports the framework',
}
const SCRIPT_ENFORCED_RULES = Object.keys(SCRIPT_ENFORCED_EXPLANATIONS)

/**
 * Every rule name that can appear as `error <name>` in either checker's output. The precision
 * assertion below has to consider both sets, not just dependency-cruiser's: a `declared-deps`
 * fixture that tripped `no-illegal-declared-dep` as well as the rule it targets would otherwise
 * pass, because `no-illegal-declared-dep` is not a dependency-cruiser rule and so is absent from
 * `errorRules`. That is exactly the imprecision this assertion exists to catch.
 */
const ALL_ENFORCED_RULES = [...new Set([...errorRules, ...SCRIPT_ENFORCED_RULES])]

interface RunResult {
  readonly status: number
  readonly output: string
}

function run(fixture: Fixture): RunResult {
  const miniRepo = createMiniRepo(repoRoot)
  try {
    for (const [relPath, contents] of fixture.files) {
      const target = join(miniRepo, relPath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, applyScope(contents, scope))
    }

    const [command, args] =
      fixture.tool === 'declared-deps'
        ? [DECLARED_DEPS_SCRIPT, []]
        : [
            DEPCRUISE_BIN,
            [
              'apps',
              'packages',
              'games',
              '--config',
              join(miniRepo, '.dependency-cruiser.cjs'),
              // Same reporter as the root `pnpm boundaries` script: `err-long` prints the rule's
              // comment alongside the rule name, which is what makes a CI failure self-explaining.
              '--output-type',
              'err-long',
            ],
          ]

    const result = spawnSync(process.execPath, [command, ...args], {
      cwd: miniRepo,
      encoding: 'utf8',
    })

    return {
      status: result.status ?? -1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    }
  } finally {
    // `KEEP_BOUNDARY_SCRATCH=1` leaves the scratch repo behind, which is the fastest way to
    // debug a fixture that is not firing: cd into it and run depcruise by hand.
    if (process.env.KEEP_BOUNDARY_SCRATCH === '1') {
      console.log(`kept scratch repo for ${fixture.name}: ${miniRepo}`)
    } else {
      rmSync(miniRepo, { recursive: true, force: true })
    }
  }
}

describe('boundary rule set', () => {
  it('has a fixture for every error-level rule', () => {
    const covered = new Set(fixtures.map((fixture) => fixture.expectRule))
    const uncovered = ALL_ENFORCED_RULES.filter((rule) => !covered.has(rule))
    expect(
      uncovered,
      'every error-level rule needs a fixture in tools/boundary-fixtures — an unproven rule is a rule that may not fire at all',
    ).toEqual([])
  })

  it('has no fixture for a rule that no longer exists', () => {
    const known = new Set(ALL_ENFORCED_RULES)
    const stale = fixtures
      .filter((fixture) => fixture.expectRule !== null && !known.has(fixture.expectRule))
      .map((fixture) => fixture.name)
    expect(stale, 'fixture targets a rule that is not in the rule set').toEqual([])
  })
})

describe('legal dependency shapes', () => {
  const control = fixtures.find((fixture) => fixture.expectRule === null)

  it('is covered by a positive control fixture', () => {
    expect(control, 'tools/boundary-fixtures needs an "# expect: none" fixture').toBeDefined()
  })

  it('pass the gate', () => {
    const { status, output } = run(control as Fixture)
    expect(output).not.toMatch(/^\s*error /m)
    expect(status, `expected a clean cruise, got:\n${output}`).toBe(0)
  })
})

describe.each(fixtures.filter((fixture) => fixture.expectRule !== null))(
  'illegal import: $name',
  (fixture) => {
    const expectedRule = fixture.expectRule as string

    // One cruise per fixture, in `beforeAll` rather than assigned by the first `it`: three of the
    // four assertions below read `result`, and a vitest run that filters or reorders tests (`-t`,
    // `.only`, a future `sequence.shuffle`) would leave them reading an unassigned variable. The
    // fixture is also the expensive part — a scratch repo plus a real depcruise — so running it
    // once is both correct and faster.
    let result: RunResult

    beforeAll(() => {
      result = run(fixture)
    })

    it(`fails the build (${fixture.why})`, () => {
      expect(result.status, `expected a non-zero exit code, got ${result.status}`).not.toBe(0)
    })

    it(`names ${expectedRule} in the output`, () => {
      expect(result.output).toContain(expectedRule)
    })

    it('does not trip any other error-level rule', () => {
      const alsoFired = ALL_ENFORCED_RULES.filter(
        (rule) => rule !== expectedRule && result.output.includes(`error ${rule}`),
      )
      expect(alsoFired, `fixture is not precise; it also fired: ${alsoFired.join(', ')}`).toEqual(
        [],
      )
    })

    it('explains why, not just what', () => {
      // The rule's `comment` is the only explanation an engineer gets the first time CI stops
      // them, so printing it is part of the contract rather than a nicety. `check-declared-deps`
      // prints its own explanation; dependency-cruiser prints the rule's comment under err-long.
      const comment = rulesByName.get(expectedRule)?.comment
      const expectedExplanation =
        fixture.tool === 'declared-deps'
          ? (SCRIPT_ENFORCED_EXPLANATIONS[expectedRule] ?? '')
          : collapse(comment ?? '').slice(0, 60)

      expect(expectedExplanation.length, `rule ${expectedRule} has no comment`).toBeGreaterThan(20)
      expect(collapse(result.output)).toContain(expectedExplanation)
    })
  },
)
