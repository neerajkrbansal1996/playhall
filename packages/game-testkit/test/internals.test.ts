/**
 * Unit tests for the machinery the checks are built on.
 *
 * These matter more than usual: a false negative in `deepEqual`,
 * `findScalar` or `findJsonSafetyProblems` does not produce a failing test,
 * it produces a silently passing conformance run — the exact failure mode the
 * suite exists to prevent.
 */

import { describe, expect, it } from 'vitest'
import { asSeatId } from '@playhall/game-sdk'
import {
  AmbientAccessError,
  CheckRecorder,
  buildDefaultRoster,
  contextAt,
  deepEqual,
  defaultChooseAction,
  failedChecks,
  findJsonSafetyProblems,
  findScalar,
  formatReport,
  jsonRoundTrip,
  resultProblems,
  stableStringify,
  withoutAmbientSources,
} from '../src/index.js'

describe('deepEqual', () => {
  it('distinguishes a missing key from an undefined one', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(false)
  })

  it('compares nested structures by value', () => {
    expect(deepEqual({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] })).toBe(true)
    expect(deepEqual({ a: [1, { b: 'x' }] }, { a: [1, { b: 'y' }] })).toBe(false)
  })

  it('does not treat an array as an object with numeric keys', () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false)
  })

  it('treats NaN as equal to itself, since JSON turns both into null', () => {
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true)
    expect(deepEqual(0, -0)).toBe(false)
  })

  it('does not confuse null with an object', () => {
    expect(deepEqual(null, {})).toBe(false)
    expect(deepEqual({}, null)).toBe(false)
  })
})

describe('stableStringify', () => {
  it('is independent of key insertion order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })

  it('renders the values JSON silently destroys, rather than hiding them', () => {
    expect(stableStringify(undefined)).toBe('<undefined>')
    expect(stableStringify(Number.NaN)).toBe('<NaN>')
    expect(stableStringify(() => 1)).toBe('<function>')
    expect(stableStringify(10n)).toBe('<bigint:10>')
  })
})

describe('findJsonSafetyProblems', () => {
  it('accepts plain JSON', () => {
    expect(findJsonSafetyProblems({ a: [1, 'x', true, null], b: { c: 0 } })).toEqual([])
  })

  it('catches the four things that survive memory but not Redis', () => {
    const reasons = (value: unknown): string =>
      findJsonSafetyProblems(value)
        .map((problem) => `${problem.path}:${problem.reason}`)
        .join('|')

    expect(reasons({ at: new Date(0) })).toContain('Date instance')
    expect(reasons({ seen: new Set([1]) })).toContain('Set instance')
    expect(reasons({ byId: new Map() })).toContain('Map instance')
    expect(reasons({ missing: undefined })).toContain('undefined is dropped')
    expect(reasons({ ratio: Number.POSITIVE_INFINITY })).toContain('does not survive JSON')
  })

  it('reports the path, so a failure is actionable', () => {
    const problems = findJsonSafetyProblems({ board: [{ owner: new Date(0) }] })
    expect(problems[0]?.path).toBe('board[0].owner')
  })

  it('does not hang on a cycle', () => {
    const node: Record<string, unknown> = {}
    node['self'] = node
    expect(findJsonSafetyProblems(node)[0]?.reason).toBe('circular reference')
  })
})

describe('findScalar', () => {
  it('finds a value as a leaf, a key, or inside a string', () => {
    expect(findScalar({ hand: ['c07'] }, 'c07')).toBe('hand[0]')
    expect(findScalar({ c07: true }, 'c07')).toContain('as a key')
    expect(findScalar({ log: 'you drew c07 just now' }, 'c07')).toContain('inside a string')
  })

  it('returns null when the value is genuinely absent', () => {
    expect(findScalar({ hand: ['c08'], count: 7 }, 'c07')).toBeNull()
  })

  it('matches numbers and booleans exactly, not by coercion', () => {
    expect(findScalar({ n: 7 }, 7)).toBe('n')
    expect(findScalar({ n: '7' }, 7)).toBeNull()
    expect(findScalar({ flag: true }, true)).toBe('flag')
  })

  it('does not substring-match a single character, which would be all noise', () => {
    expect(findScalar({ label: 'spectator' }, 'c')).toBeNull()
  })
})

describe('withoutAmbientSources', () => {
  it('makes the ambient clock and RNG throw, then restores them', () => {
    const before = Date.now
    expect(() => withoutAmbientSources(() => Date.now())).toThrow(AmbientAccessError)
    expect(() => withoutAmbientSources(() => Math.random())).toThrow(/Math.random/)
    expect(Date.now).toBe(before)
    expect(typeof Date.now()).toBe('number')
  })

  it('restores the globals even when the body throws', () => {
    const before = Math.random
    expect(() =>
      withoutAmbientSources(() => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(Math.random).toBe(before)
  })

  it('lets deterministic code through untouched', () => {
    expect(withoutAmbientSources(() => [3, 1, 2].sort().join(''))).toBe('123')
  })
})

describe('jsonRoundTrip', () => {
  it('reproduces what Redis does to state', () => {
    expect(jsonRoundTrip({ a: 1, b: [null, 'x'] })).toEqual({ a: 1, b: [null, 'x'] })
    expect(jsonRoundTrip({ when: new Date(0) })).toEqual({ when: '1970-01-01T00:00:00.000Z' })
  })
})

describe('contextAt', () => {
  const base = {
    gameId: 'g',
    gameVersion: '1.0.0',
    sdkContractVersion: 1,
    startNow: 1000,
    nowStepMs: 10,
    seed: 'seed' as never,
  }

  it('derives now from the sequence, so replay lands on the same clock', () => {
    expect(contextAt(base, 0).now).toBe(1000)
    expect(contextAt(base, 3).now).toBe(1030)
  })

  it('gives the same sequence the same RNG stream', () => {
    expect(contextAt(base, 3).rng.next()).toBe(contextAt(base, 3).rng.next())
    expect(contextAt(base, 3).rng.next()).not.toBe(contextAt(base, 4).rng.next())
  })
})

describe('buildDefaultRoster', () => {
  it('fills every seat and numbers them from zero', () => {
    const roster = buildDefaultRoster(3, false)
    expect(roster.map((seat) => seat.index)).toEqual([0, 1, 2])
    expect(roster.every((seat) => seat.occupant !== null)).toBe(true)
    expect(roster.every((seat) => seat.teamId === null)).toBe(true)
  })

  it('alternates teams when the manifest has them', () => {
    expect(buildDefaultRoster(4, true).map((seat) => String(seat.teamId))).toEqual([
      'team-a',
      'team-b',
      'team-a',
      'team-b',
    ])
  })
})

describe('defaultChooseAction', () => {
  const rng = { pick: <T>(items: readonly T[]): T => items[0] as T } as never

  it('picks the seat with the most options — the seat to move in a sequential game', () => {
    const chosen = defaultChooseAction(
      null,
      [
        { seatId: asSeatId('a'), actions: ['resign'] },
        { seatId: asSeatId('b'), actions: ['x', 'y', 'z'] },
      ],
      rng,
    )
    expect(String(chosen?.seatId)).toBe('b')
  })

  it('returns null when nobody can move', () => {
    expect(defaultChooseAction(null, [{ seatId: asSeatId('a'), actions: [] }], rng)).toBeNull()
    expect(defaultChooseAction(null, [], rng)).toBeNull()
  })
})

describe('resultProblems', () => {
  const seats = [asSeatId('s1'), asSeatId('s2'), asSeatId('s3')]

  it('accepts a competition-ranked result', () => {
    expect(
      resultProblems(
        {
          reason: 'completed',
          standings: [
            { seatId: seats[0]!, rank: 1, outcome: 'win' },
            { seatId: seats[1]!, rank: 1, outcome: 'win' },
            { seatId: seats[2]!, rank: 3, outcome: 'loss' },
          ],
        },
        seats,
      ),
    ).toEqual([])
  })

  it('rejects dense ranks, which hide a tie', () => {
    const problems = resultProblems(
      {
        reason: 'completed',
        standings: [
          { seatId: seats[0]!, rank: 1, outcome: 'win' },
          { seatId: seats[1]!, rank: 1, outcome: 'win' },
          { seatId: seats[2]!, rank: 2, outcome: 'loss' },
        ],
      },
      seats,
    )
    expect(problems.join(' ')).toContain('competition-ranked')
  })

  it('rejects a missing seat, an extra seat and a bad reason', () => {
    const problems = resultProblems(
      {
        reason: 'gave-up' as never,
        standings: [
          { seatId: seats[0]!, rank: 1, outcome: 'win' },
          { seatId: asSeatId('ghost'), rank: 2, outcome: 'loss' },
        ],
      },
      seats,
    )
    expect(problems.join(' ')).toContain('omits standings for s2, s3')
    expect(problems.join(' ')).toContain('unknown seats ghost')
    expect(problems.join(' ')).toContain("reason 'gave-up'")
  })
})

describe('CheckRecorder and the report', () => {
  it('reports skipped only when nothing failed', () => {
    const skipped = new CheckRecorder('determinism', 'x')
    skipped.skip('not applicable')
    expect(skipped.finish().status).toBe('skipped')

    const skippedButBroken = new CheckRecorder('determinism', 'x')
    skippedButBroken.skip('not applicable')
    skippedButBroken.fail({ message: 'but it did fail' })
    expect(skippedButBroken.finish().status).toBe('failed')
  })

  it('truncates a flood of identical failures but keeps the count', () => {
    const recorder = new CheckRecorder('determinism', 'x')
    for (let i = 0; i < 25; i += 1) recorder.fail({ message: `failure ${i}` })
    const result = recorder.finish()
    expect(result.failures).toHaveLength(21)
    expect(result.failures.at(-1)?.message).toContain('5 more failures')
  })

  it('formats a report a human can read in CI', () => {
    const recorder = new CheckRecorder('determinism', 'Determinism')
    recorder.note('a note')
    recorder.fail({ message: 'broke', where: 'seed=1', detail: 'expected x got y' })
    const report = {
      kind: 'turn-based' as const,
      subject: 'g@1.0.0',
      sdkVersion: '0.1.0',
      sdkContractVersion: 1,
      seeds: ['s'],
      checks: [recorder.finish()],
      passed: false,
    }
    const text = formatReport(report)
    expect(text).toContain('FAIL  g@1.0.0')
    expect(text).toContain('✗ determinism')
    expect(text).toContain('note: a note')
    expect(text).toContain('at seed=1')
    expect(failedChecks(report)).toEqual(['determinism'])
  })
})
