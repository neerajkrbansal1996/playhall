import { describe, expect, it } from 'vitest'

import {
  SourcePathEscapedError,
  assertResolvable,
  normaliseSourceMap,
  rewriteSources,
} from '../../../scripts/release/sourcemap-paths.mjs'

/**
 * These cover the source-map path invariant behind the release build
 * (`apps/realtime/build.mjs`, `docs/ENVIRONMENTS.md` §10).
 *
 * The escape branch is unit-tested rather than driven through a real build on
 * purpose: normalising the map makes the outfile's location irrelevant, so a
 * build cannot produce an escaping path any more — which is the point, and also
 * means the only way to keep the guard falsifiable is to feed it the shape it
 * guards against. A guard nothing ever exercises is a comment.
 */

const repoRoot = '/repo'
const outDir = '/repo/apps/realtime/dist'

describe('rewriteSources', () => {
  it('maps outfile-relative sources to repo-relative ones', () => {
    const { sources, offenders } = rewriteSources(
      ['../src/index.ts', '../../../packages/shared/src/telemetry/log.ts'],
      { outDir, repoRoot },
    )

    expect(sources).toEqual(['apps/realtime/src/index.ts', 'packages/shared/src/telemetry/log.ts'])
    expect(offenders).toEqual([])
  })

  it('accepts an absolute source that is inside the repository', () => {
    const { sources, offenders } = rewriteSources(['/repo/apps/realtime/src/env.ts'], {
      outDir,
      repoRoot,
    })

    expect(sources).toEqual(['apps/realtime/src/env.ts'])
    expect(offenders).toEqual([])
  })

  it('flags a source that climbs out of the repository', () => {
    // The exact shape that reached Sentry as
    // `../../../../../../../Users/<name>/…/apps/realtime/src/index.ts`
    // and became the issue culprit.
    const { sources, offenders } = rewriteSources(
      ['../../../../../Users/someone/elsewhere/apps/realtime/src/index.ts'],
      { outDir, repoRoot },
    )

    expect(offenders).toHaveLength(1)
    expect(offenders[0].rewritten.startsWith('../')).toBe(true)
    expect(sources[0]).toContain('Users/someone')
  })

  it('flags an absolute source outside the repository', () => {
    const { offenders } = rewriteSources(['/Users/someone/linked-dep/src/index.ts'], {
      outDir,
      repoRoot,
    })

    expect(offenders).toHaveLength(1)
  })

  it('leaves synthetic sources alone rather than inventing a file for them', () => {
    const { sources, offenders } = rewriteSources(['<stdin>', 'sentry:instrument'], {
      outDir,
      repoRoot,
    })

    expect(sources).toEqual(['<stdin>', 'sentry:instrument'])
    expect(offenders).toEqual([])
  })
})

describe('normaliseSourceMap', () => {
  it('rewrites sources and drops sourceRoot', () => {
    // A leftover sourceRoot is re-prefixed onto every source by Sentry, which
    // breaks artifact matching for the whole release at once.
    const map = { sources: ['../src/index.ts'], sourceRoot: '/repo/apps/realtime' }

    normaliseSourceMap(map, { outDir, repoRoot })

    expect(map.sources).toEqual(['apps/realtime/src/index.ts'])
    expect('sourceRoot' in map).toBe(false)
  })

  it('throws rather than emitting a map that leaks a build path', () => {
    const map = { sources: ['../../../../../Users/someone/x/src/index.ts'] }

    expect(() => normaliseSourceMap(map, { outDir, repoRoot })).toThrow(SourcePathEscapedError)
  })

  it('tolerates a map with no sources', () => {
    const map = {}
    normaliseSourceMap(map, { outDir, repoRoot })
    expect(map.sources).toEqual([])
  })
})

describe('assertResolvable', () => {
  const present = new Set(['apps/realtime/src/index.ts', 'packages/shared/src/telemetry/log.ts'])
  const fileExists = (source) => present.has(source)

  it('passes when every source exists and the entry is present', () => {
    const map = { sources: [...present] }

    expect(
      assertResolvable(map, { expectEntry: 'apps/realtime/src/index.ts', fileExists }),
    ).toEqual([])
  })

  it('reports a source that is not a file in the repository', () => {
    const map = { sources: ['apps/realtime/src/gone.ts'] }

    const problems = assertResolvable(map, { expectEntry: undefined, fileExists })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('gone.ts')
  })

  it('reports a missing entry module even when every source is clean', () => {
    // The failure this catches: a map whose paths all look right but which
    // symbolicates nothing the reader will actually click.
    const map = { sources: ['packages/shared/src/telemetry/log.ts'] }

    const problems = assertResolvable(map, {
      expectEntry: 'apps/realtime/src/index.ts',
      fileExists,
    })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('apps/realtime/src/index.ts')
  })

  it('does not demand that a synthetic source exist on disk', () => {
    const map = { sources: ['<stdin>'] }

    expect(assertResolvable(map, { expectEntry: undefined, fileExists })).toEqual([])
  })
})
