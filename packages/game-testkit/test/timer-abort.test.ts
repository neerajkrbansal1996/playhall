/**
 * The timer arm of `result-standings-well-formed` (ADR-0010).
 *
 * `result-standings.test.ts` covers the action arm against `race`. This file
 * covers the arm where nobody acts: a deadline the game itself armed passes,
 * the platform calls `onTimer`, and the match ends without recording a result.
 *
 * The planted regression is `never arms the timer it declares`. A harness that
 * synthesised the `onTimer` call would pass that mutant — certifying a
 * first-move timeout for a game whose first-move timer does not exist — so it
 * is asserted to fail, and asserted to say *why* in those words.
 */

import { describe, expect, it } from 'vitest'
import { asTimerId } from '@playhall/game-sdk'
import { TURN_BASED_CHECKS } from '../src/report.js'
import { runTurnBasedConformance } from '../src/turn-based.js'
import { failedChecks, type ConformanceReport } from '../src/report.js'
import { standoffSubject } from '../src/reference/standoff-subject.js'
import { FIRST_MOVE_TIMER } from '../src/reference/standoff.js'
import {
  GHOST_TIMER,
  GRACE_TIMER,
  makeStandoff,
  type StandoffBreakage,
  type StandoffSubject,
} from './fixtures/standoff-mutants.js'

const CHECK = 'result-standings-well-formed'

function runSubject(subject: StandoffSubject, seed?: string): ConformanceReport {
  return runTurnBasedConformance(subject, {
    playoutsPerVariant: 2,
    only: [CHECK],
    ...(seed === undefined ? {} : { seed }),
  })
}

function run(breakage: StandoffBreakage = {}): ConformanceReport {
  return runSubject(makeStandoff(breakage))
}

function check(report: ConformanceReport) {
  const result = report.checks.find((entry) => entry.id === CHECK)
  if (result === undefined) throw new Error(`the suite did not run '${CHECK}'`)
  return result
}

function messages(report: ConformanceReport): string {
  return check(report)
    .failures.map((failure) => `${failure.message} @ ${failure.where ?? ''}`)
    .join('\n')
}

describe('the timer arm reaches an unrecorded ending', () => {
  it('passes the reference game, whose only abort is a first-move timeout', () => {
    const report = runSubject(standoffSubject)

    expect(check(report).status).toBe('passed')
    expect(report.passed).toBe(true)
    // Not a vacuous pass: playouts and the timer abort, across both variants.
    expect(check(report).assertions).toBeGreaterThan(4)
  })

  it('reaches standings: [] through the queue, not through a hand-built state', () => {
    // The ending is only reachable by firing the timer `createInitialState`
    // armed, so a passing run is proof the queue delivered the expiry.
    const report = runSubject(standoffSubject)

    expect(check(report).status).toBe('passed')
    expect(check(report).notes.join('\n')).not.toContain('declares no abortScenarios')
  })

  it('runs the whole reference suite, not just this check', () => {
    const report = runTurnBasedConformance(standoffSubject, { playoutsPerVariant: 2 })

    expect(failedChecks(report)).toEqual([])
    expect(report.passed).toBe(true)
  })
})

describe('the planted regression: a declared timer the game never arms', () => {
  it('FAILS, rather than certifying an ending production cannot reach', () => {
    const report = run({ neverArms: true })

    expect(check(report).status).toBe('failed')
    expect(report.passed).toBe(false)
  })

  it('says the timer was never armed, and names the missing setTimer', () => {
    const text = messages(run({ neverArms: true }))

    expect(text).toContain('was never armed')
    expect(text).toContain("setTimer('first-move'")
    expect(text).toContain('unreachable in production')
    // And it still frames the consequence in ADR-0006's terms.
    expect(text).toContain('empty standings were not exercised')
  })

  it('reports what was armed instead, so a typo in the id is obvious', () => {
    // The game arms nothing at all here, so the report says so rather than
    // leaving the author to guess.
    expect(messages(run({ neverArms: true }))).toContain('armed instead: nothing')
  })
})

describe('mis-declared timers fail the scenario', () => {
  it('fails a set for a timerId absent from manifest.timers', () => {
    const text = messages(run({ undeclaredSet: true }))

    expect(check(run({ undeclaredSet: true })).status).toBe('failed')
    expect(text).toContain('manifest.timers does not declare')
    expect(text).toContain(String(GHOST_TIMER))
  })

  it('fails a scenario whose timerId the manifest does not declare', () => {
    const report = runSubject(
      makeStandoff({}, { label: 'ghost expiry', trigger: 'timer', timerId: GHOST_TIMER }),
    )

    expect(check(report).status).toBe('failed')
    // The game arms `first-move` quite correctly; it is the scenario that is
    // wrong, and the message distinguishes the two by listing what is armed.
    expect(messages(report)).toContain('was never armed')
    expect(messages(report)).toContain('first-move@')
  })

  it('fails a timer scenario on a game with no onTimer — a failure, not a skip', () => {
    const report = run({ noOnTimer: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('has no onTimer')
    expect(messages(report)).toContain("'first-move' can never end a match")
  })
})

describe('a timer that is armed but never comes due', () => {
  it('fails when the game clears it before it can fire', () => {
    // `afterSteps: 1` plays one move, and the mutant clears on every move.
    const report = runSubject(
      makeStandoff(
        { clearsBeforeFiring: true },
        {
          label: 'cleared before firing',
          trigger: 'timer',
          timerId: FIRST_MOVE_TIMER,
          afterSteps: 1,
        },
      ),
    )

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('was armed but never came due')
    expect(messages(report)).toContain('cleared or paused')
  })

  it('fails when the game pauses it and never resumes', () => {
    const report = run({ pausesForever: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('was armed but never came due')
    expect(messages(report)).toContain('still armed: first-move (paused)')
  })

  it('fails when the expiry runs but leaves the match live', () => {
    const report = run({ expiryDoesNotEnd: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('left getResult() null')
    // The timer arm's message names the deadline, not an advanceMs the author
    // does not have on this arm.
    expect(messages(report)).toContain('deadline')
    expect(messages(report)).not.toContain('advanceMs')
  })
})

describe('the ADR-0006 assertions still run on the timer arm', () => {
  it('fails an aborted match that carries standings anyway', () => {
    const report = run({ abortHasStandings: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('standings_arity')
    expect(messages(report)).toContain("reason 'aborted' requires exactly 0 standing(s)")
  })
})

describe('fire order', () => {
  it('breaks a deadline tie by timerId ascending', () => {
    // `grace` and `first-move` share a deadline, and `grace` is armed first.
    // `first-move` sorts earlier, so it fires first and ends the match; the
    // declared scenario therefore passes.
    const report = runSubject(
      makeStandoff({ tiedGrace: true }, {
        label: 'first-move wins the tie',
        trigger: 'timer',
        timerId: FIRST_MOVE_TIMER,
      }),
    )

    expect(check(report).status).toBe('passed')
  })

  it('reports which timer got there first when the other one ends the match', () => {
    // Same two timers, but now `grace` is due a second earlier and produces a
    // *recorded* result. A scenario that said only "some timer fires" could
    // not tell this apart from success.
    const report = runSubject(
      makeStandoff({ earlyGraceEnds: true }, {
        label: 'grace beats first-move',
        trigger: 'timer',
        timerId: FIRST_MOVE_TIMER,
      }),
    )

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain(`the match ended on '${String(GRACE_TIMER)}'`)
    expect(messages(report)).toContain("before the declared 'first-move' fired")
  })

  it('fires the declared timer within a raised maxFires budget', () => {
    const report = runSubject(
      makeStandoff({ earlyGraceEnds: true }, {
        label: 'grace first, then first-move',
        trigger: 'timer',
        timerId: FIRST_MOVE_TIMER,
        maxFires: 2,
      }),
    )

    // `grace` ends the match, so even two fires cannot reach `first-move` —
    // the budget is not a way around an ending that already happened.
    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('the match ended on')
  })

  it('spends a budget of 1 before a two-fire cascade completes', () => {
    const report = runSubject(
      makeStandoff({ tiedGrace: true }, {
        label: 'grace needs the second fire',
        trigger: 'timer',
        timerId: GRACE_TIMER,
      }),
    )

    // `first-move` sorts first and ends the match, so the single default fire
    // is spent on it. The message points at `maxFires`.
    expect(check(report).status).toBe('failed')
    expect(messages(report)).toMatch(/budget of 1 fire|match ended on/)
  })
})

describe('reproducibility', () => {
  it('produces an identical report across two invocations with the same seed', () => {
    const first = runSubject(standoffSubject, 'per-175-fixed-seed')
    const second = runSubject(standoffSubject, 'per-175-fixed-seed')

    expect(second.checks).toEqual(first.checks)
    expect(second.passed).toBe(first.passed)
  })

  it('reproduces a tie-break run too, so fire order is not insertion order', () => {
    const subject = makeStandoff({ tiedGrace: true }, {
      label: 'first-move wins the tie',
      trigger: 'timer',
      timerId: FIRST_MOVE_TIMER,
    })

    const first = runSubject(subject, 'per-175-tie-seed')
    const second = runSubject(subject, 'per-175-tie-seed')

    expect(check(second).status).toBe(check(first).status)
    expect(second.checks).toEqual(first.checks)
  })

  it('reproduces a failing run, so a planted regression is not flaky', () => {
    const first = messages(runSubject(makeStandoff({ neverArms: true }), 'per-175-fail-seed'))
    const second = messages(runSubject(makeStandoff({ neverArms: true }), 'per-175-fail-seed'))

    expect(second).toBe(first)
    expect(first).toContain('was never armed')
  })
})

describe('the check registry is unchanged', () => {
  it('still has 11 turn-based checks', () => {
    // ADR-0010 adds a trigger, not a check: the thing asserted is still
    // ADR-0006's encoding of a result.
    expect(TURN_BASED_CHECKS).toHaveLength(11)
  })

  it('keeps the result-standings check id and title', () => {
    expect(TURN_BASED_CHECKS).toContain(CHECK)
    // Pinned by position too: a check renamed in place would still satisfy
    // `toContain` if something else had been appended.
    expect(TURN_BASED_CHECKS[10]).toBe(CHECK)

    const report = runSubject(standoffSubject)
    expect(check(report).id).toBe(CHECK)
    // The title is what a game author reads in CI, so ADR-0010 leaving the
    // check alone means this string is unchanged as well.
    expect(check(report).title).toBe(
      'Every result is well-formed: one standing per seat, or empty for a reason that did not count',
    )
  })
})

describe('the no-scenarios note names both arms', () => {
  it('tells a timer-driven game how to declare its ending', () => {
    const report = runTurnBasedConformance(
      { ...standoffSubject, abortScenarios: [] },
      { playoutsPerVariant: 2, only: [CHECK] },
    )

    const notes = check(report).notes.join('\n')
    expect(notes).toContain('declares no abortScenarios')
    // The gap ADR-0010 §5 closes: a note mentioning only `abortAction` leaves
    // "my ending is timer-driven and there is no way to say so" true.
    expect(notes).toContain("trigger:'timer'")
    expect(notes).toContain("trigger:'action'")
    expect(notes).toContain('timerId')
  })
})

describe('existing action-arm declarations are untouched', () => {
  it('accepts a scenario with no trigger at all', () => {
    // The compile-level promise of the union: `trigger` is optional on the
    // action arm and nowhere else, so a pre-ADR-0010 declaration is still an
    // `AbortScenario`. Asserted at runtime too, since a type-only claim would
    // not notice the driver dropping the arm.
    const report = runSubject(
      makeStandoff({}, {
        label: 'no trigger, abortAction only',
        abortAction: (state) => {
          const seatId = state.order[0]
          return seatId === undefined ? null : { seatId, action: { type: 'fire' as const } }
        },
      }),
    )

    // `fire` is a legal move, not an abort, so the match stays live — the
    // action arm ran and reported in its own vocabulary.
    expect(messages(report)).toContain('advanceMs')
    expect(messages(report)).not.toContain('was never armed')
  })

  it('narrows on trigger, so the timer arm has no abortAction to call', () => {
    const timer = { label: 't', trigger: 'timer' as const, timerId: asTimerId('first-move') }
    const action = { label: 'a', abortAction: () => null }

    // @ts-expect-error — `abortAction` is not on the timer arm.
    void timer.abortAction
    // @ts-expect-error — `timerId` is not on the action arm.
    void action.timerId
    expect(timer.trigger).toBe('timer')
  })
})
