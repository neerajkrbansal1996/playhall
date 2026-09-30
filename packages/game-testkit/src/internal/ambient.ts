/**
 * Ambient non-determinism trap.
 *
 * The lint rule in `eslint.config.mjs` catches `Date.now()` and
 * `Math.random()` written literally inside `games/**`. It cannot catch a
 * transitive dependency that calls them, an indirect `const now = Date['now']`,
 * or a helper that lives outside the linted glob. So the conformance suite
 * closes the loop at runtime: while a game function is executing, the ambient
 * sources are replaced with functions that throw.
 *
 * The globals are reached through `trapMethod(Date, 'now', …)` rather than
 * written as `Date.now`, which is both what the swap needs and why this file
 * does not trip the repo's own `no-restricted-properties` rule.
 */

export class AmbientAccessError extends Error {
  constructor(readonly source: string) {
    super(
      `${source} was called inside a game module. Game code must be a pure function of (ctx, state, input): use ctx.now instead of Date.now() and ctx.rng instead of Math.random().`,
    )
    this.name = 'AmbientAccessError'
  }
}

interface Trap {
  readonly install: () => void
  readonly restore: () => void
}

function trapMethod(holder: object, key: string, label: string): Trap | null {
  const original = (holder as Record<string, unknown>)[key]
  if (typeof original !== 'function') return null
  const descriptor = Object.getOwnPropertyDescriptor(holder, key)
  if (
    descriptor !== undefined &&
    descriptor.configurable === false &&
    descriptor.writable !== true
  ) {
    return null
  }
  return {
    install: () => {
      ;(holder as Record<string, unknown>)[key] = () => {
        throw new AmbientAccessError(label)
      }
    },
    restore: () => {
      ;(holder as Record<string, unknown>)[key] = original
    },
  }
}

/**
 * Runs `body` with `Date.now`, `Math.random` and `performance.now` trapped.
 *
 * Always restores, including when `body` throws. Not re-entrant and not
 * safe under `test.concurrent` — the conformance runner calls it from a
 * single synchronous path on purpose.
 */
export function withoutAmbientSources<T>(body: () => T): T {
  const traps: Trap[] = []
  const dateTrap = trapMethod(Date, 'now', 'Date.now()')
  if (dateTrap !== null) traps.push(dateTrap)
  const mathTrap = trapMethod(Math, 'random', 'Math.random()')
  if (mathTrap !== null) traps.push(mathTrap)
  if (typeof performance === 'object') {
    const perfTrap = trapMethod(performance, 'now', 'performance.now()')
    if (perfTrap !== null) traps.push(perfTrap)
  }

  for (const trap of traps) trap.install()
  try {
    return body()
  } finally {
    for (const trap of traps) trap.restore()
  }
}
