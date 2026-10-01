/**
 * Unit tests for the machinery the checks are built on.
 *
 * These matter more than usual: a false negative in `deepEqual`,
 * `findScalar` or `findJsonSafetyProblems` does not produce a failing test,
 * it produces a silently passing conformance run — the exact failure mode the
 * suite exists to prevent.
 */

import { describe, expect, it } from 'vitest'
import {
  VALID,
  asSeatId,
  asTimerId,
  invalid,
  setTimer,
  validateMatchResult,
  type ApplyResult,
  type GameContext,
  type GameEvent,
  type MatchResult,
  type SeatId,
  type TimerCommand,
  type TimerId,
} from '@playhall/game-sdk'
import { abortRun, timerAbortRun } from '../src/internal/driver.js'
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
  playout,
  replay,
  stableStringify,
  statesOf,
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
      // This game arms no timers at all, so the allowlist is empty. It is a
      // required option rather than a defaulted one on purpose: an omitted
      // allowlist would silently reject every legal `set` a game emitted.
      declaredTimerIds: [],
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

/**
 * `timerAbortRun` at the driver seam (ADR-0010 §1–§2).
 *
 * Every timer-arm test above this one reaches the driver through
 * `runTurnBasedConformance`, whose subject reads neither `ctx.now` nor the
 * `seatId` in `onTimer` — so the queue is pinned by `test/timer-queue.test.ts`
 * while the driver's *wiring into* the queue is not. The queue can be right
 * while the driver hands it the wrong clock, and nothing goes red. These assert
 * the returned `TimerFire`s directly, which is what that record exists for.
 */
describe('timerAbortRun fires the game’s own timers on the ADR-0010 §2 clock', () => {
  const base = {
    gameId: 'g',
    gameVersion: '1.0.0',
    sdkContractVersion: 1,
    startNow: 1_000_000,
    nowStepMs: 1_000,
    seed: 'seed' as never,
  }

  const TICK = asTimerId('tick')
  const FINAL = asTimerId('final')
  /** The second seat, so a dropped `seatId` cannot pass as the default one. */
  const OWNER = asSeatId('seat-2')
  const ABORTED: MatchResult = { reason: 'aborted', standings: [] }

  interface TimedState {
    /** The opening `ctx.now`, so the game can measure elapsed time itself. */
    readonly startedAt: number
    readonly plays: number
    readonly endedAt: number | null
  }
  type TimedAction = 'play'

  /**
   * A miniature game whose timer commands the caller supplies, so each case
   * differs only in which call arms what and in what `onTimer` decides.
   */
  function drive(options: {
    readonly declaredTimerIds: readonly string[]
    readonly timerId: TimerId
    readonly afterSteps: number
    readonly maxFires?: number
    /** Returned from `createInitialState`, resolved against its own `ctx.now`. */
    readonly openingTimers?: readonly TimerCommand[]
    /** Keyed by 1-based ply, resolved against that ply's `ctx.now`. */
    readonly timersOnPly?: ReadonlyMap<number, readonly TimerCommand[]>
    readonly onTimer: (
      ctx: GameContext,
      state: TimedState,
      timerId: TimerId,
      seatId: SeatId | null,
    ) => ApplyResult<TimedState, GameEvent>
  }) {
    const nows: number[] = []
    const server = {
      createInitialState: (ctx: GameContext): ApplyResult<TimedState, GameEvent> => {
        nows.push(ctx.now)
        return {
          state: { startedAt: ctx.now, plays: 0, endedAt: null },
          events: [],
          timers: options.openingTimers ?? [],
        }
      },
      validateAction: () => VALID,
      applyAction: (ctx: GameContext, state: TimedState): ApplyResult<TimedState, GameEvent> => {
        nows.push(ctx.now)
        const plays = state.plays + 1
        return {
          state: { ...state, plays },
          events: [],
          timers: options.timersOnPly?.get(plays) ?? [],
        }
      },
      getLegalActions: (): readonly TimedAction[] => ['play'],
      onTimer: options.onTimer,
      getResult: (state: TimedState): MatchResult | null =>
        state.endedAt === null ? null : ABORTED,
    }

    const outcome = timerAbortRun<TimedState, TimedAction, Record<string, never>, GameEvent>({
      server,
      settings: {},
      variantLabel: 'v',
      roster: buildDefaultRoster(2, false),
      context: base,
      maxSteps: 50,
      chooseAction: defaultChooseAction,
      trapAmbient: false,
      afterSteps: options.afterSteps,
      declaredTimerIds: options.declaredTimerIds,
      timerId: options.timerId,
      maxFires: options.maxFires ?? 1,
    })
    return { outcome, nows }
  }

  /** Ends the match unconditionally, recording the clock the fire ran at. */
  const endOnFire = (ctx: GameContext, state: TimedState): ApplyResult<TimedState, GameEvent> => ({
    state: { ...state, endedAt: ctx.now },
    events: [],
  })

  it('resolves an opening set against createInitialState’s own ctx.now', () => {
    const { outcome } = drive({
      declaredTimerIds: ['final'],
      timerId: FINAL,
      afterSteps: 0,
      openingTimers: [setTimer(FINAL, 5_000, OWNER)],
      onTimer: endOnFire,
    })

    expect(outcome.unreachable).toBeNull()
    expect(outcome.fires).toHaveLength(1)
    // startNow + delayMs. A deadline measured from a zero epoch would be 5_000,
    // which the clamp below would then silently absorb into the step clock.
    expect(outcome.fires[0]?.deadline).toBe(1_005_000)
    expect(outcome.fires[0]?.now).toBe(1_005_000)
    expect(outcome.fires[0]?.sequence).toBe(1)
    expect(outcome.abortNow).toBe(1_005_000)
    expect(outcome.result).toEqual(ABORTED)
  })

  it('resolves a mid-match set against that ply’s ctx.now, not the opening one', () => {
    const { outcome, nows } = drive({
      declaredTimerIds: ['final'],
      timerId: FINAL,
      afterSteps: 2,
      timersOnPly: new Map([[2, [setTimer(FINAL, 3_000, OWNER)]]]),
      onTimer: endOnFire,
    })

    // createInitialState at sequence 0, then two plies at 1 and 2.
    expect(nows).toEqual([1_000_000, 1_001_000, 1_002_000])
    expect(outcome.stepsPlayed).toBe(2)
    expect(outcome.unreachable).toBeNull()
    // The arming ply ran at 1_002_000, so the deadline is that plus 3_000 —
    // the "deadline is a pure function of the log" clause in miniature.
    expect(outcome.fires[0]?.deadline).toBe(1_005_000)
    expect(outcome.fires[0]?.now).toBe(1_005_000)
    expect(outcome.fires[0]?.sequence).toBe(3)
  })

  it('clamps a deadline behind the last mutation up to that mutation’s now', () => {
    const { outcome, nows } = drive({
      declaredTimerIds: ['final'],
      timerId: FINAL,
      afterSteps: 3,
      // 500 ms armed on ply 1 against three 1 s plies: the deadline is 1.5 s
      // behind the last action by the time the fire is dispatched.
      timersOnPly: new Map([[1, [setTimer(FINAL, 500, OWNER)]]]),
      // A game that measures elapsed time from its own state, the way
      // `test/fixtures/race.ts` does via `startedAt`. An unclamped fire rewinds
      // `ctx.now` behind the last action, this game then refuses to end, and the
      // suite reports a false failure against a correct game — which ADR-0010 §1
      // calls worse than having no check at all.
      onTimer: (ctx, state) =>
        ctx.now - state.startedAt >= 3_000 ? endOnFire(ctx, state) : { state, events: [] },
    })

    expect(outcome.fires[0]?.deadline).toBe(1_001_500)
    expect(outcome.fires[0]?.now).toBe(nows.at(-1))
    expect(outcome.fires[0]?.now).toBe(1_003_000)
    expect(outcome.abortNow).toBe(1_003_000)
    expect(outcome.result).toEqual(ABORTED)
  })

  it('passes onTimer the seat from the game’s own set command', () => {
    const seen: (SeatId | null)[] = []
    const { outcome } = drive({
      declaredTimerIds: ['final'],
      timerId: FINAL,
      afterSteps: 0,
      openingTimers: [setTimer(FINAL, 5_000, OWNER)],
      // Only the owning seat's expiry ends this match. A driver that passed
      // `null` — or the wrong seat — would report this correct game as one
      // whose declared timer ending production can never reach.
      onTimer: (ctx, state, _timerId, seatId) => {
        seen.push(seatId)
        return String(seatId) === 'seat-2' ? endOnFire(ctx, state) : { state, events: [] }
      },
    })

    expect(seen).toEqual([OWNER])
    expect(outcome.fires[0]?.seatId).toBe(OWNER)
    expect(outcome.unreachable).toBeNull()
    expect(outcome.result).toEqual(ABORTED)
  })

  it('applies onTimer’s own commands, so one expiry can re-arm the next', () => {
    const { outcome } = drive({
      declaredTimerIds: ['tick', 'final'],
      timerId: FINAL,
      afterSteps: 0,
      maxFires: 2,
      // `final` is armed up front — `wasEverArmed` is checked before the first
      // fire, so a timer only armed from inside the cascade is unreachable by
      // construction. `tick`'s expiry then pulls it 48.5 s forward, which is
      // the part a driver that dropped onTimer's commands would lose.
      openingTimers: [setTimer(TICK, 1_000, OWNER), setTimer(FINAL, 50_000, OWNER)],
      onTimer: (ctx, state, timerId) =>
        String(timerId) === 'tick'
          ? { state, events: [], timers: [setTimer(FINAL, 500, OWNER)] }
          : endOnFire(ctx, state),
    })

    expect(outcome.unreachable).toBeNull()
    expect(outcome.fires).toHaveLength(2)
    expect(outcome.fires[0]).toEqual({
      timerId: TICK,
      seatId: OWNER,
      deadline: 1_001_000,
      now: 1_001_000,
      sequence: 1,
    })
    // 1_001_000 (the `tick` fire's own clock) + 500, replacing 1_050_000.
    expect(outcome.fires[1]).toEqual({
      timerId: FINAL,
      seatId: OWNER,
      deadline: 1_001_500,
      now: 1_001_500,
      sequence: 2,
    })
    expect(outcome.abortNow).toBe(1_001_500)
    expect(outcome.result).toEqual(ABORTED)
  })
})

/**
 * PER-269. Every purity baseline in the suite is `stableStringify(step.before)`,
 * so if the driver's own record is the object it handed to `applyAction`, an
 * impure reducer has already rewritten the baseline before any check reads it.
 * These pin the driver-level invariant directly, so the guarantee survives a
 * refactor of the checks that read it.
 */
describe('the driver keeps its record of a state out of the game’s hands', () => {
  const context = {
    gameId: 'g',
    gameVersion: '1.0.0',
    sdkContractVersion: 1,
    startNow: 1_000_000,
    nowStepMs: 1_000,
    seed: 'seed' as never,
  }

  interface CountState {
    readonly plays: number
  }

  /** Writes a constant onto its input — the memoisation shape, idempotent. */
  function memoisingServer() {
    return {
      createInitialState: () => ({ state: { plays: 0 }, events: [] }),
      validateAction: () => VALID,
      applyAction: (_ctx: GameContext, state: CountState) => {
        ;(state as unknown as Record<string, unknown>).memo = 'written in place'
        return { state: { plays: state.plays + 1 }, events: [] }
      },
      getLegalActions: (): readonly 'play'[] => ['play'],
      getResult: (state: CountState): MatchResult | null =>
        state.plays >= 3
          ? {
              reason: 'completed' as const,
              standings: [{ seatId: asSeatId('seat-1'), rank: 1, outcome: 'win' as const }],
            }
          : null,
    }
  }

  const options = {
    settings: {},
    variantLabel: 'v',
    roster: buildDefaultRoster(1, false),
    context,
    maxSteps: 10,
    chooseAction: () => ({ seatId: asSeatId('seat-1'), action: 'play' as const }),
    trapAmbient: false,
  }

  function strayKeys(state: unknown): readonly string[] {
    return Object.keys(state as Record<string, unknown>).filter((key) => key !== 'plays')
  }

  it('records a pristine before and after even when applyAction writes in place', () => {
    const result = playout({ ...options, server: memoisingServer() })

    expect(result.steps.length).toBe(3)
    for (const step of result.steps) {
      expect(strayKeys(step.before)).toEqual([])
      expect(strayKeys(step.after)).toEqual([])
    }
    // `statesOf` is what determinism, serialization and reconnect all compare.
    expect(statesOf(result).flatMap(strayKeys)).toEqual([])
  })

  /**
   * `abortRun` validates before it applies, against the same retained state.
   * So a `validateAction` that writes onto its input poisons the state the
   * abort's `applyAction` then spreads into `AbortRun.state`, which
   * `result-standings-well-formed` reads.
   *
   * This is the only one of the four abort-driver hand-overs whose removal is
   * observable: the other three write onto an input the game immediately
   * replaces with its own output, so nothing the driver returns carries the
   * scribble. They are kept anyway, because they are where a future change that
   * starts recording an intermediate abort state would silently reopen this.
   */
  it('returns a pristine state from abortRun when validateAction writes in place', () => {
    interface AbortState {
      readonly plays: number
      readonly aborted: boolean
    }
    const server = {
      createInitialState: () => ({ state: { plays: 0, aborted: false }, events: [] }),
      validateAction: (_ctx: GameContext, state: AbortState) => {
        ;(state as unknown as Record<string, unknown>).fromValidate = 'written in place'
        return VALID
      },
      applyAction: (_ctx: GameContext, state: AbortState, _seatId: SeatId, action: string) =>
        action === 'abort'
          ? { state: { ...state, aborted: true }, events: [] }
          : { state: { ...state, plays: state.plays + 1 }, events: [] },
      getLegalActions: (): readonly string[] => ['play'],
      getResult: (state: AbortState): MatchResult | null =>
        state.aborted ? { reason: 'aborted' as const, standings: [] } : null,
    }

    const outcome = abortRun<AbortState, string, Record<string, never>, GameEvent>({
      server,
      settings: {},
      variantLabel: 'v',
      roster: buildDefaultRoster(1, false),
      context,
      maxSteps: 10,
      chooseAction: defaultChooseAction,
      trapAmbient: false,
      afterSteps: 2,
      declaredTimerIds: [],
      abortAction: () => ({ seatId: asSeatId('seat-1'), action: 'abort' }),
    })

    expect(outcome.unreachable).toBeNull()
    expect(Object.keys(outcome.state).sort()).toEqual(['aborted', 'plays'])
  })

  /**
   * The documented degradation. A state carrying a function cannot be
   * `structuredClone`d, and that state's real problem is that it does not
   * survive Redis — which is `serialization-round-trip`'s verdict to give. A
   * driver that threw here would pre-empt it with "the game threw during a
   * playout", so the hand-over falls back to the retained object instead.
   */
  it('does not crash the playout on a state structuredClone cannot copy', () => {
    const server = {
      createInitialState: () => ({ state: { plays: 0, notJson: () => 1 }, events: [] }),
      validateAction: () => VALID,
      applyAction: (_ctx: GameContext, state: { readonly plays: number }) => ({
        state: { ...state, plays: state.plays + 1 },
        events: [],
      }),
      getLegalActions: (): readonly string[] => ['play'],
      getResult: (state: { readonly plays: number }): MatchResult | null =>
        state.plays >= 2 ? { reason: 'aborted' as const, standings: [] } : null,
    }

    const result = playout({ ...options, server, chooseAction: defaultChooseAction })

    expect(result.steps.length).toBe(2)
    expect(findJsonSafetyProblems(result.finalState)[0]?.reason).toContain('not JSON-safe')
  })

  it('replays the log without letting the reducer edit the replayed states', () => {
    const server = memoisingServer()
    const first = playout({ ...options, server })
    const log = first.steps.map((step) => ({
      sequence: step.sequence,
      seatId: step.seatId,
      action: step.action,
    }))

    const replayed = replay(server, {}, options.roster, context, log, false)

    // Both sides pristine. If only one of the two call sites cloned, these
    // would diverge and determinism would report a replay failure for what is
    // really a purity bug.
    expect(replayed.states.flatMap(strayKeys)).toEqual([])
    expect(replayed.states).toEqual(statesOf(first))
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
