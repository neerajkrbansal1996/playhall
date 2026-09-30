/**
 * `result-standings-well-formed` (ADR-0006).
 *
 * The suite's own gate. Each mutant below violates exactly one clause of the
 * `MatchResult` contract, and the test asserts the check *fails* and names the
 * problem code — a conformance check that has only ever been seen passing is
 * an untested assertion, and this is the one standing between a game and a
 * phantom win in a player's match history.
 */

import { describe, expect, it } from 'vitest'
import { asSeatId, validateMatchResult } from '@playhall/game-sdk'
import { runTurnBasedConformance } from '../src/turn-based.js'
import { describeProblem } from '../src/checks/result-standings.js'
import { formatReport, type ConformanceReport } from '../src/report.js'
import { makeRace, type RaceBreakage } from './fixtures/race.js'

const CHECK = 'result-standings-well-formed'

/** Small and fixed: the fixture is deterministic, so extra playouts buy nothing. */
function run(breakage: RaceBreakage = {}): ConformanceReport {
  return runTurnBasedConformance(makeRace(breakage), {
    playoutsPerVariant: 2,
    only: [CHECK],
  })
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

describe('result-standings-well-formed', () => {
  it('is part of the turn-based suite and passes a correct game', () => {
    const report = runTurnBasedConformance(makeRace(), { playoutsPerVariant: 2 })
    const result = check(report)

    expect(result.status).toBe('passed')
    // Playouts *and* aborts, across two player counts — not a vacuous pass.
    expect(result.assertions).toBeGreaterThan(4)
    expect(report.checks.map((entry) => entry.id)).toContain(CHECK)
  })

  it('fails an aborted match that carries standings anyway', () => {
    const report = run({ abortHasStandings: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('standings_arity')
    expect(messages(report)).toContain("reason 'aborted' requires exactly 0 standing(s)")
    expect(report.passed).toBe(false)
  })

  it('fails a completed match that is missing a seat', () => {
    const report = run({ dropLastSeat: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('missing_seat')
    expect(messages(report)).toContain('standings_arity')
  })

  it('fails a standing for a seat that is not in the match', () => {
    expect(messages(run({ unknownSeat: true }))).toContain('unknown_seat')
  })

  it('fails a seat with two standings', () => {
    expect(messages(run({ duplicateSeat: true }))).toContain('duplicate_seat')
  })

  it('fails a rank below 1', () => {
    expect(messages(run({ zeroRank: true }))).toContain('bad_rank')
  })

  it('fails ranks 1, 1, 2 — a tie must skip the next rank', () => {
    // Only reachable at three seats; at two, 1, 1 is a legal draw. The suite
    // expands player counts, so the 3p scenario is what catches it.
    const messagesText = messages(run({ tieThenTwo: true }))
    expect(messagesText).toContain('rank_not_competition_ordered')
    expect(messagesText).toContain('3p')
  })

  it('fails an abort that reports a reason which does count', () => {
    const report = run({ abortReason: 'completed' })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('which is recorded')
    // And the arity rule bites too: 'completed' wants one standing per seat.
    expect(messages(report)).toContain('standings_arity')
  })

  it('fails a declared abort the game cannot actually reach', () => {
    const report = run({ abortUnreachable: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('the declared abort never ran')
  })

  it('notes, loudly, a game that declares no abort scenarios', () => {
    const report = run({ omitAbortScenarios: true })
    const result = check(report)

    expect(result.status).toBe('passed')
    expect(result.notes.join(' ')).toContain('declares no abortScenarios')
  })

  it('reaches the abort path: the abort half asserts more than the playout half', () => {
    const withAborts = check(run()).assertions
    const withoutAborts = check(run({ omitAbortScenarios: true })).assertions

    expect(withAborts).toBeGreaterThan(withoutAborts)
  })

  it('fails an abort action that leaves the match running', () => {
    const report = run({ abortDoesNothing: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('left getResult() null')
  })

  it('fails, rather than crashing the run, when the game throws during the abort', () => {
    const report = run({ abortThrows: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('race: abort blew up')
  })

  it('fails an abort scheduled past the end of the match', () => {
    // `afterSteps` overshoots, so the game finishes before the abort fires.
    // Silently passing here is how the abort half stops testing anything.
    const report = run({ abortAfterSteps: 50 })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('the match was already over')
  })

  it('defaults afterSteps to 0 — an abort from the opening position', () => {
    expect(check(run({ abortAfterSteps: 'omit' })).status).toBe('passed')
  })

  it('fails an abort the driver could not reach, because the game has no getLegalActions', () => {
    // The undershoot direction of `afterSteps`. `getLegalActions` is optional,
    // so the driver has no moves to play and aborts from the opening position
    // instead — a different position from the one the scenario declared.
    const report = run({ omitGetLegalActions: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('played 0 of the requested 1 moves')
  })

  it('fails an abort the driver could not reach, because chooseAction declined', () => {
    const report = run({ declineMoves: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('played 0 of the requested 1 moves')
  })

  it("fails an abort the game's own validateAction rejects, naming the code", () => {
    // The real runner validates before it applies, so it would refuse this
    // abort outright. A suite that applies it anyway certifies an abort that
    // does nothing in production.
    const report = run({ abortNotAllowed: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain("rejected the abort action with 'not_allowed'")
  })

  it('fails, rather than crashing the run, when validateAction throws on the abort', () => {
    const report = run({ abortValidateThrows: true })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('race: validateAction blew up on the abort')
  })

  it('fails a reason that is not a ResultReason at all', () => {
    // Only a JavaScript game or a hand-built blob gets here; the SDK validator
    // trusts the type, so this check is the thing that does not.
    const report = run({ bogusReason: 'victory_royale' })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain("result.reason 'victory_royale' is not one of")
  })

  it('leaves a truncated playout to random-playout-terminates', () => {
    // No result to validate, so this check must not invent a failure for it.
    const report = runTurnBasedConformance(makeRace(), {
      playoutsPerVariant: 1,
      maxStepsPerPlayout: 1,
      only: [CHECK],
    })

    expect(check(report).status).toBe('passed')
  })

  it('ignores a crashed playout, which random-playout-terminates reports', () => {
    const report = runTurnBasedConformance(makeRace({ crashOnMove: true }), {
      playoutsPerVariant: 1,
      only: [CHECK],
    })

    expect(
      check(report)
        .failures.map((failure) => failure.message)
        .join('\n'),
    ).not.toContain('blew up')
  })

  it('skips, rather than passing, when nothing reached a result at all', () => {
    const report = runTurnBasedConformance(makeRace({ omitAbortScenarios: true }), {
      playoutsPerVariant: 0,
      only: [CHECK],
    })

    expect(check(report).status).toBe('skipped')
  })

  it('still runs the abort half when there are no playouts to borrow a context from', () => {
    const report = runTurnBasedConformance(makeRace({ abortHasStandings: true }), {
      playoutsPerVariant: 0,
      only: [CHECK],
    })

    expect(check(report).status).toBe('failed')
    expect(messages(report)).toContain('standings_arity')
  })

  it('renders the failure so the report is readable in CI', () => {
    const text = formatReport(run({ dropLastSeat: true }))

    expect(text).toContain('FAIL')
    expect(text).toContain(CHECK)
    expect(text).toContain('missing_seat')
  })
})

describe('describeProblem', () => {
  const a = asSeatId('seat-1')
  const b = asSeatId('seat-2')

  // Every code is rendered starting with the code itself, because that is the
  // string a game author greps for after a red CI run.
  it.each([
    [{ code: 'standings_arity', reason: 'aborted', expected: 0, actual: 2 } as const],
    [{ code: 'unknown_seat', seatId: a } as const],
    [{ code: 'duplicate_seat', seatId: a } as const],
    [{ code: 'missing_seat', seatId: b } as const],
    [{ code: 'bad_rank', seatId: a, rank: 0 } as const],
    [{ code: 'rank_not_competition_ordered', rank: 2, expected: 3 } as const],
  ])('renders %j verbatim', (problem) => {
    expect(describeProblem(problem)).toContain(problem.code)
  })

  it('agrees with the SDK validator about a valid result', () => {
    expect(
      validateMatchResult(
        {
          reason: 'completed',
          standings: [
            { seatId: a, rank: 1, outcome: 'win' },
            { seatId: b, rank: 2, outcome: 'loss' },
          ],
        },
        [a, b],
      ),
    ).toEqual([])
  })
})
