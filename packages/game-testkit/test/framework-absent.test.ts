/**
 * ADR-0001 §4.2 condition 2 — "no game imports the framework" — proved
 * behaviourally rather than by pattern.
 *
 * The boundary gate (`no-platform-framework-in-games` in
 * `.dependency-cruiser.cjs` and `tools/boundaries/check-declared-deps.mjs`)
 * already catches the import and the manifest declaration. Both are regex
 * rules over a dependency graph, so both are only as good as the spellings
 * they anticipated: a specifier built at runtime, a `createRequire` inside a
 * helper, an indirection through a package whose name says nothing about
 * Colyseus. That is what this file is for. It does not look at the text of a
 * game; it takes the framework away and requires the game to run anyway.
 *
 * Three assertions, because each one is worthless without the others:
 *
 *   1. **Absent from the dependency tree.** Nothing in the testkit's
 *      resolution root can reach `colyseus` or `@colyseus/*` at all. If this
 *      ever passes for the wrong reason — the packages quietly arriving as a
 *      transitive dependency — assertions 2 and 3 are still meaningful, but
 *      the claim in this file's title has stopped being true.
 *   2. **A game runs to completion without it.** Two real game modules are
 *      driven through the full turn-based conformance run while every load of
 *      the framework throws, and both still pass every check. "Runs to
 *      completion" is the whole claim: a game that needed Colyseus would not.
 *   3. **The trap fires.** A deliberate reach for the framework, run through
 *      the same trap, must throw. Without this, assertion 2 would pass just as
 *      happily with a trap that does nothing — the failure mode that makes a
 *      gate decorative.
 *
 * Known limit, stated rather than papered over: the trap hooks CommonJS
 * loading (`Module._load`), which is what `require` and `createRequire` go
 * through. A *static* ESM `import` of the framework resolves when the module
 * graph is built, before any test body runs, so it is caught by assertion 1
 * and by the boundary gate, not by the trap.
 */

import { createRequire } from 'node:module'
import Module from 'node:module'
import { describe, expect, it } from 'vitest'

import { formatReport, runTurnBasedConformance } from '../src/index.js'
import { hiddenHandSubject } from '../src/reference/index.js'
import { ticTacToeSubject } from './subjects.js'

/**
 * The denylist, kept identical to the boundary rule's. Duplicated on purpose:
 * this file must keep working when run without the repo around it, and a
 * shared constant would make the behavioural check inherit any blind spot the
 * pattern-based one develops.
 *
 * All three of Colyseus' published names, not two. `colyseus.js` is the browser
 * client: not a subpath of `colyseus`, not under the `@colyseus` scope, a third
 * npm name — so a pattern written from the server packages alone misses the
 * form a game's client-side code reaches for first (ADR-0002 §2 rev 2.1).
 */
const PLATFORM_FRAMEWORK = /^(colyseus|colyseus\.js|@colyseus\/[^/]+)(\/.*)?$/

class PlatformFrameworkAccessError extends Error {
  constructor(readonly specifier: string) {
    super(
      `"${specifier}" was loaded while a game module was running. The server framework is a platform choice (ADR-0001 §4.2 condition 2): a game may never learn which one was picked. Keep game state as plain TypeScript and carry it through the SDK.`,
    )
    this.name = 'PlatformFrameworkAccessError'
  }
}

type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown
interface LoaderInternals {
  _load: LoadFn
}

/**
 * Runs `body` with every CommonJS load of the platform framework throwing.
 * Always restores, including when `body` throws — a leaked trap would poison
 * every test that ran afterwards.
 */
function withoutPlatformFramework<T>(body: () => T): T {
  const loader = Module as unknown as LoaderInternals
  const original = loader._load
  loader._load = function trapped(request: string, parent: unknown, isMain: boolean): unknown {
    if (PLATFORM_FRAMEWORK.test(request)) throw new PlatformFrameworkAccessError(request)
    return original.call(this, request, parent, isMain)
  }
  try {
    return body()
  } finally {
    loader._load = original
  }
}

const require = createRequire(import.meta.url)

describe('the platform netcode framework is absent from the game path', () => {
  it.each(['colyseus', 'colyseus.js', '@colyseus/schema', '@colyseus/core'])(
    'cannot resolve %s from the testkit',
    (specifier) => {
      // pnpm's strict node_modules is doing the work here: a package that is
      // not declared by this package, or by something this package depends on,
      // simply is not reachable. That makes an unresolvable specifier a real
      // statement about the dependency tree rather than about spelling.
      expect(() => require.resolve(specifier)).toThrow(/Cannot find module/)
    },
  )

  // The negative control for the trap itself, run once per published name. Every
  // name the trap claims to cover needs its own case: with only `colyseus` here,
  // deleting `colyseus.js` from the pattern above broke nothing, because the
  // resolve assertions test the dependency tree rather than the trap. A branch of
  // the denylist with no case asserting it is a branch that can be removed
  // silently, which is the failure mode this whole file exists to rule out.
  //
  // Specifiers are assembled at runtime so this file never contains a literal
  // import of the framework for the boundary gate to flag.
  it.each([
    ['coly', 'seus', ''],
    ['coly', 'seus', '.js'],
    ['@coly', 'seus', '/schema'],
  ])('fails loudly when something does reach for %s%s%s', (head, tail, suffix) => {
    const specifier = `${head}${tail}${suffix}`
    // Assert on the error type, not just that something threw: a `Cannot find
    // module` from the real loader would look identical from the outside and
    // would prove nothing.
    expect(() => withoutPlatformFramework(() => require(specifier) as unknown)).toThrow(
      PlatformFrameworkAccessError,
    )
  })

  it('restores the loader even when the body throws', () => {
    const before = (Module as unknown as LoaderInternals)._load
    expect(() =>
      withoutPlatformFramework(() => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect((Module as unknown as LoaderInternals)._load).toBe(before)
  })
})

/**
 * Cast at the boundary: the two subjects are different generic instantiations,
 * which `describe.each` cannot express as one type. Everything inside
 * `runTurnBasedConformance` stays fully typed.
 */
type AnySubject = Parameters<typeof runTurnBasedConformance>[0]
type Options = Parameters<typeof runTurnBasedConformance>[1]

describe.each([
  ['tic-tac-toe', ticTacToeSubject as AnySubject, {} as Options],
  ['hidden-hand', hiddenHandSubject as AnySubject, { playoutsPerVariant: 8 } as Options],
])('a game module runs to completion with the framework absent: %s', (_name, subject, options) => {
  const report = withoutPlatformFramework(() => runTurnBasedConformance(subject, options))

  it('passes every check', () => {
    for (const check of report.checks) {
      expect
        .soft(check.status, `${check.id}: ${JSON.stringify(check.failures, null, 2)}`)
        .toBe('passed')
    }
    expect(formatReport(report)).toContain('PASS')
    expect(report.passed).toBe(true)
  })

  it('actually drove the game rather than short-circuiting', () => {
    // A trap that took the run down would leave a report with no assertions
    // in it, which would satisfy "passed" vacuously on a skipped check.
    for (const check of report.checks) {
      expect.soft(check.assertions, `${check.id} asserted nothing`).toBeGreaterThan(0)
    }
    const terminates = report.checks.find((check) => check.id === 'random-playout-terminates')
    expect(terminates?.status).toBe('passed')
  })

  it('produces the same report as a run without the trap', () => {
    // The framework being absent must be invisible to the game, not merely
    // survivable. A differing report would mean some code path noticed.
    const untrapped = runTurnBasedConformance(subject, options)
    expect(formatReport(report)).toBe(formatReport(untrapped))
  })
})
