/**
 * Unit tests for the machinery the checks are built on.
 *
 * These matter more than usual: a false negative in `deepEqual`,
 * `findScalar` or `findJsonSafetyProblems` does not produce a failing test,
 * it produces a silently passing conformance run — the exact failure mode the
 * suite exists to prevent.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  VALID,
  asSeatId,
  invalid,
  validateMatchResult,
  type GameContext,
  type GameEvent,
  type MatchResult,
  type SeatId,
} from '@playhall/game-sdk'
import { abortRun } from '../src/internal/driver.js'
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
  describeProblem,
  jsonRoundTrip,
  perturb,
  planPerturbations,
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

  it('adds a one-off offset without touching the step size, and defaults it to 0', () => {
    expect(contextAt(base, 3, 500).now).toBe(1530)
    expect(contextAt(base, 3).now).toBe(contextAt(base, 3, 0).now)
    // Still a pure function of its arguments — the determinism lens.
    expect(contextAt(base, 3, 500).now).toBe(contextAt(base, 3, 500).now)
    expect(contextAt(base, 3, 500).sequence).toBe(3)
  })
})

/**
 * `AbortScenario.advanceMs` at the driver seam.
 *
 * The scoping is the whole point of the affordance: an offset that leaked into
 * the preceding plies would be `nowStepMs` again, and raising `nowStepMs` is
 * what trips time-based endings mid-playout. So this records the `ctx.now` of
 * every mutation and pins which one moved.
 */
describe('abortRun scopes advanceMs to the abort dispatch', () => {
  const base = {
    gameId: 'g',
    gameVersion: '1.0.0',
    sdkContractVersion: 1,
    startNow: 1_000_000,
    nowStepMs: 1_000,
    seed: 'seed' as never,
  }

  interface ClockState {
    readonly startedAt: number
    readonly plays: number
    readonly aborted: boolean
  }
  type ClockAction = 'play' | 'abort'

  /**
   * The smallest deadline-gated game: `abort` only lands once `deadlineMs` has
   * passed, and before that it is a no-op — a first-move timeout in miniature.
   */
  function run(deadlineMs: number, advanceMs: number | undefined, gateInValidate = false) {
    const nows: number[] = []
    const server = {
      createInitialState: (ctx: GameContext) => {
        nows.push(ctx.now)
        return { state: { startedAt: ctx.now, plays: 0, aborted: false }, events: [] }
      },
      validateAction: (
        ctx: GameContext,
        state: ClockState,
        _seatId: SeatId,
        action: ClockAction,
      ) =>
        gateInValidate && action === 'abort' && ctx.now - state.startedAt < deadlineMs
          ? invalid('too_early')
          : VALID,
      applyAction: (ctx: GameContext, state: ClockState, _seatId: SeatId, action: ClockAction) => {
        nows.push(ctx.now)
        if (action === 'abort') {
          return ctx.now - state.startedAt >= deadlineMs
            ? { state: { ...state, aborted: true }, events: [] }
            : { state, events: [] }
        }
        return { state: { ...state, plays: state.plays + 1 }, events: [] }
      },
      getLegalActions: (): readonly ClockAction[] => ['play'],
      getResult: (state: ClockState): MatchResult | null =>
        state.aborted ? { reason: 'aborted', standings: [] } : null,
    }

    const roster = buildDefaultRoster(2, false)
    const outcome = abortRun<ClockState, ClockAction, Record<string, never>, GameEvent>({
      server,
      settings: {},
      variantLabel: 'v',
      roster,
      context: base,
      maxSteps: 50,
      chooseAction: defaultChooseAction,
      trapAmbient: false,
      afterSteps: 2,
      ...(advanceMs === undefined ? {} : { advanceMs }),
      abortAction: (_state: ClockState, seats) => {
        const host = seats[0]
        return host === undefined ? null : { seatId: host.seatId, action: 'abort' }
      },
    })
    return { outcome, nows }
  }

  it('leaves the plies before the abort on the plain step clock', () => {
    const plain = run(0, undefined)
    const offset = run(0, 30_000)

    // createInitialState at sequence 0, then two plies at 1 and 2.
    expect(plain.nows.slice(0, 3)).toEqual([1_000_000, 1_001_000, 1_002_000])
    expect(offset.nows.slice(0, 3)).toEqual(plain.nows.slice(0, 3))
    expect(plain.outcome.stepsPlayed).toBe(2)
    expect(offset.outcome.stepsPlayed).toBe(2)
  })

  it('moves the abort dispatch, and only it', () => {
    const { outcome, nows } = run(0, 30_000)

    // sequence 3 = afterSteps + 1, plus the declared offset.
    expect(nows.at(-1)).toBe(1_003_000 + 30_000)
    expect(outcome.abortNow).toBe(1_033_000)
  })

  it('defaults the offset to 0', () => {
    expect(run(0, undefined).outcome.abortNow).toBe(1_003_000)
  })

  it('is what makes a deadline-gated abort reachable at all', () => {
    // 30 s of deadline against a 1 s step: the step counter never gets there.
    expect(run(30_000, undefined).outcome.result).toBeNull()
    expect(run(30_000, 31_000).outcome.result).toEqual({ reason: 'aborted', standings: [] })
  })

  it('reports the same clock on a second run of the same scenario', () => {
    expect(run(30_000, 31_000).nows).toEqual(run(30_000, 31_000).nows)
  })

  it('validates and applies the abort at the same offset instant', () => {
    // The realistic shape: the game gates the deadline in `validateAction`, so
    // too early is a typed rejection rather than a silent no-op. A `validate`
    // that saw the plain clock while `apply` saw the offset one would make a
    // correct game unreachable, which is the scoping bug in its other form.
    const tooEarly = run(30_000, undefined, true)
    expect(tooEarly.outcome.unreachable).toContain("rejected the abort action with 'too_early'")
    expect(tooEarly.outcome.unreachable).toContain('AbortScenario.advanceMs')
    expect(tooEarly.outcome.abortNow).toBe(1_003_000)

    const inTime = run(30_000, 31_000, true)
    expect(inTime.outcome.unreachable).toBeNull()
    expect(inTime.outcome.result).toEqual({ reason: 'aborted', standings: [] })
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

/**
 * The standings *rules* are the SDK's (`validateMatchResult`, ADR-0006) and are
 * tested in `@playhall/game-sdk`. What is the testkit's own is the delegation:
 * that it asks the SDK rather than re-deriving, and renders what comes back.
 * So these pin the seam, not the rules — a second copy of the rule table here
 * is the drift ADR-0006 was written to stop.
 */
describe('standings validation is delegated to the SDK', () => {
  const seats = [asSeatId('s1'), asSeatId('s2'), asSeatId('s3')]

  it('accepts an aborted match with empty standings', () => {
    // The regression this seam was built for: validating `standings: []`
    // against the full roster read as "omitted every seat".
    expect(validateMatchResult({ reason: 'aborted', standings: [] }, seats)).toEqual([])
  })

  it('accepts a competition-ranked result', () => {
    expect(
      validateMatchResult(
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

  it('renders every problem the SDK can return', () => {
    const problems = validateMatchResult(
      {
        reason: 'completed',
        standings: [
          { seatId: seats[0]!, rank: 1, outcome: 'win' },
          { seatId: asSeatId('ghost'), rank: 2, outcome: 'loss' },
        ],
      },
      seats,
    )

    expect(problems.length).toBeGreaterThan(0)
    // Every code renders to a string that leads with the code itself; a
    // problem the renderer does not know would come back as `undefined`.
    for (const problem of problems) {
      expect(describeProblem(problem)).toContain(problem.code)
    }
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

/**
 * The `accepted ⊆ offered` corpus generator (ADR-0012).
 *
 * This one belongs here rather than only in `mutants.test.ts` for the reason at
 * the top of this file: its failure mode is not a failing test, it is an empty
 * corpus and a silently passing conformance run. The schema shapes below are
 * the ones that actually ship — chess's action is a discriminated union whose
 * optional `promotion` sits one level down, inside `move`.
 */
describe('planPerturbations', () => {
  function pathsOf(plan: ReturnType<typeof planPerturbations>): readonly string[] {
    return plan.fields.map((field) => field.path).sort()
  }

  it('reads a flat optional field with a representative value', () => {
    const plan = planPerturbations(
      z.object({ type: z.literal('play'), face: z.enum(['up', 'down']).optional() }),
      undefined,
    )
    expect(plan.schemaReadable).toBe(true)
    expect(plan.gaps).toEqual([])
    expect(plan.fields).toEqual([
      { path: 'face', segments: ['face'], value: 'up', source: 'actionSchema' },
    ])
  })

  it('reads every scalar type the ADR names, through every wrapper', () => {
    const plan = planPerturbations(
      z.object({
        lit: z.literal(7).optional(),
        str: z.string().optional(),
        num: z.number().optional(),
        bool: z.boolean().optional(),
        native: z.nativeEnum({ A: 'a', B: 'b' }).optional(),
        nullable: z.boolean().nullable().optional(),
        readonlyish: z.number().readonly().optional(),
        defaulted: z.string().default('d'),
        unioned: z.union([z.literal('first'), z.number()]).optional(),
      }),
      undefined,
    )
    expect(plan.gaps).toEqual([])
    expect(Object.fromEntries(plan.fields.map((field) => [field.path, field.value]))).toEqual({
      lit: 7,
      str: 'atrium-probe',
      num: 1,
      bool: true,
      native: 'a',
      nullable: true,
      readonlyish: 1,
      defaulted: 'atrium-probe',
      unioned: 'first',
    })
  })

  it('finds chess’s promotion: nested, inside a discriminated-union member', () => {
    // The exact shape of `chessActionSchema`. A collector that only read
    // top-level keys would report "nothing to cover" on the very defect
    // ADR-0012 was written about (PER-198).
    const plan = planPerturbations(
      z.discriminatedUnion('type', [
        z
          .object({
            type: z.literal('move'),
            move: z
              .object({
                from: z.string(),
                to: z.string(),
                promotion: z.enum(['q', 'r', 'b', 'n']).optional(),
              })
              .strict(),
          })
          .strict(),
        z.object({ type: z.literal('resign') }).strict(),
      ]),
      undefined,
    )
    expect(plan.schemaReadable).toBe(true)
    expect(plan.gaps).toEqual([])
    expect(pathsOf(plan)).toEqual(['move.promotion'])
    expect(plan.fields[0]?.value).toBe('q')
  })

  it('contributes a key declared by several union members exactly once', () => {
    const plan = planPerturbations(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('a'), note: z.string().optional() }),
        z.object({ type: z.literal('b'), note: z.string().optional() }),
      ]),
      undefined,
    )
    expect(pathsOf(plan)).toEqual(['note'])
  })

  it('names a schema it cannot introspect instead of returning nothing', () => {
    const plan = planPerturbations({ safeParse: () => ({ success: true }) }, undefined)
    expect(plan.schemaReadable).toBe(false)
    expect(plan.fields).toEqual([])
    expect(plan.gaps).toEqual([
      {
        subject: 'actionSchema',
        reason: 'an object with no zod v3 _def (a custom parser, or a hand-rolled schema)',
      },
    ])
  })

  it('names an optional field whose inner type it cannot sample', () => {
    const plan = planPerturbations(
      z.object({ type: z.literal('play'), meta: z.record(z.string()).optional() }),
      undefined,
    )
    expect(plan.schemaReadable).toBe(true)
    expect(plan.fields).toEqual([])
    expect(plan.gaps).toEqual([{ subject: "optional field 'meta'", reason: 'ZodRecord' }])
  })

  it('names a union variant that is not an object', () => {
    const plan = planPerturbations(
      z.union([z.object({ type: z.literal('a'), note: z.string().optional() }), z.string()]),
      undefined,
    )
    expect(plan.schemaReadable).toBe(true)
    expect(pathsOf(plan)).toEqual(['note'])
    expect(plan.gaps).toEqual([{ subject: 'a variant of actionSchema', reason: 'ZodString' }])
  })

  it('names a nested variant it cannot read, by the field it sits under', () => {
    const plan = planPerturbations(
      z.object({
        type: z.literal('move'),
        move: z.union([z.object({ to: z.string().optional() }), z.string()]),
      }),
      undefined,
    )
    expect(pathsOf(plan)).toEqual(['move.to'])
    expect(plan.gaps).toEqual([{ subject: "a variant of the field 'move'", reason: 'ZodString' }])
  })

  it('stops at the nesting bound instead of walking an arbitrary tree', () => {
    // Three path segments are in (chess needs two, so there is one level of
    // headroom); the fourth is out. The bound is what keeps the cost law in
    // ADR-0012 a law rather than a function of how deep a game nests.
    const plan = planPerturbations(
      z.object({
        a: z.object({
          flat: z.string().optional(),
          b: z.object({ c: z.string().optional(), d: z.object({ e: z.string().optional() }) }),
        }),
      }),
      undefined,
    )
    expect(pathsOf(plan)).toEqual(['a.b.c', 'a.flat'])
  })

  it('declines a union nested inside a union rather than searching forever', () => {
    const plan = planPerturbations(
      z.object({ u: z.union([z.union([z.string(), z.number()]), z.boolean()]).optional() }),
      undefined,
    )
    // The outer union's first option is itself a union, which the sampler stops
    // at; the second option is a boolean it can read.
    expect(plan.fields[0]).toMatchObject({ path: 'u', value: true })
  })

  it('names a non-object actionSchema by what it actually got', () => {
    expect(planPerturbations(undefined, undefined).gaps).toEqual([
      { subject: 'actionSchema', reason: 'a undefined' },
    ])
    expect(planPerturbations(z.string(), undefined).gaps).toEqual([
      { subject: 'actionSchema', reason: 'ZodString' },
    ])
  })

  it('ignores a declared perturbation with an empty key', () => {
    expect(planPerturbations(z.object({}), [{ key: '', values: ['x'] }]).fields).toEqual([])
  })

  it('lets a declared perturbation override the schema, and keeps the gap visible', () => {
    const plan = planPerturbations(
      z.object({ type: z.literal('play'), meta: z.record(z.string()).optional() }),
      [{ key: 'meta', values: [{ a: 'b' }, { c: 'd' }] }],
    )
    expect(plan.fields).toHaveLength(2)
    expect(plan.fields.every((field) => field.source === 'declared')).toBe(true)
    // The schema is still unreadable here; papering over it must not hide that.
    expect(plan.gaps).toEqual([{ subject: "optional field 'meta'", reason: 'ZodRecord' }])
  })

  it('accepts a dotted path in a declared perturbation', () => {
    const plan = planPerturbations({ safeParse: () => ({ success: true }) }, [
      { key: 'move.promotion', values: ['q'] },
    ])
    expect(plan.fields[0]).toMatchObject({
      path: 'move.promotion',
      segments: ['move', 'promotion'],
      value: 'q',
    })
  })
})

describe('perturb', () => {
  const field = { path: 'face', segments: ['face'], value: 'up', source: 'declared' } as const
  const nested = {
    path: 'move.promotion',
    segments: ['move', 'promotion'],
    value: 'q',
    source: 'declared',
  } as const

  it('adds the field without touching the original', () => {
    const action = { type: 'play', cardId: 'c01' }
    const result = perturb(action, field)
    expect(result).toEqual({ ok: true, value: { type: 'play', cardId: 'c01', face: 'up' } })
    expect(action).toEqual({ type: 'play', cardId: 'c01' })
  })

  it('declines when the action already carries the key', () => {
    // Adding a field that is already there is not a second spelling.
    expect(perturb({ type: 'play', face: 'down' }, field)).toEqual({ ok: false })
    // Even when it is explicitly undefined: the key is present on the wire.
    expect(perturb({ type: 'play', face: undefined }, field)).toEqual({ ok: false })
  })

  it('rebuilds a nested path, sharing nothing with the original', () => {
    const action = { type: 'move', move: { from: 'e2', to: 'e4' } }
    const result = perturb(action, nested)
    expect(result).toEqual({
      ok: true,
      value: { type: 'move', move: { from: 'e2', to: 'e4', promotion: 'q' } },
    })
    expect(action.move).toEqual({ from: 'e2', to: 'e4' })
  })

  it('declines when the parent on the path is absent', () => {
    // What a `resign` action looks like to a probe aimed at `move.promotion`.
    expect(perturb({ type: 'resign' }, nested)).toEqual({ ok: false })
    expect(perturb({ type: 'move', move: 'e2e4' }, nested)).toEqual({ ok: false })
  })

  it('refuses a non-plain-object target', () => {
    expect(perturb(null, field)).toEqual({ ok: false })
    expect(perturb('resign', field)).toEqual({ ok: false })
    expect(perturb([1, 2], field)).toEqual({ ok: false })
  })
})
