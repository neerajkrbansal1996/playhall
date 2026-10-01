/**
 * `result-standings-well-formed` (ADR-0006).
 *
 * `MatchResult` is persisted with the match and replayed from the match log,
 * so a malformed one is not a rendering bug — it is a wrong row in a player's
 * history that survives every restart. The contract has two halves and this
 * check enforces both:
 *
 *   - a **recorded** reason carries exactly one standing per seat, no seat
 *     repeated, ranks competition-ordered (1, 1, 3 — never 1, 1, 2);
 *   - an **unrecorded** reason (`UNRECORDED_RESULT_REASONS`) carries exactly
 *     zero standings, because "this did not count" is a fact about the match
 *     and there is nothing per-seat to say.
 *
 * The rules themselves live in `validateMatchResult` in the SDK, not here.
 * One source of truth: the runner, the match-record writer and this gate all
 * have to agree on what a well-formed result is, and a second copy in the
 * testkit is a copy that drifts.
 *
 * The check runs over two populations, and it needs both. Random playouts
 * cover every ending the rules reach on their own; they never reach an abort,
 * which is where empty standings are *required* and therefore where a game is
 * most likely to fill them in anyway. The abort half is driven from the
 * game's declared `abortScenarios`.
 *
 * The abort's clock is the scenario's to declare. `now` at the dispatch is
 * `startNow + (afterSteps + 1) * nowStepMs + advanceMs`, so an ending gated on
 * a real deadline — a first-move timeout, a lobby idle-kick — is reached by
 * declaring `advanceMs`, not by stretching the subject's `nowStepMs` (which is
 * shared by every check and would trip time-based endings mid-playout).
 */

import {
  type GameEvent,
  type MatchResult,
  type MatchResultProblem,
  type SeatId,
  RESULT_REASONS,
  UNRECORDED_RESULT_REASONS,
  isRecordedResult,
  validateMatchResult,
} from '@playhall/game-sdk'
import { CheckRecorder } from '../report.js'
import { abortRun, seedFor, type ContextOptions } from '../internal/driver.js'
import type { Prepared } from '../internal/prepare.js'
import { preview } from '../internal/value.js'

/**
 * Renders one problem for a CI annotation.
 *
 * The codes are the error text by design, so they are reproduced verbatim and
 * the fields are appended rather than prose-ified — `missing_seat` is what a
 * game author greps for, and a paraphrase is a string that does not match.
 */
export function describeProblem(problem: MatchResultProblem): string {
  switch (problem.code) {
    case 'standings_arity':
      return `standings_arity: reason '${problem.reason}' requires exactly ${String(problem.expected)} standing(s), got ${String(problem.actual)}`
    case 'unknown_seat':
      return `unknown_seat: ${String(problem.seatId)} has a standing but is not in this match`
    case 'duplicate_seat':
      return `duplicate_seat: ${String(problem.seatId)} has more than one standing`
    case 'missing_seat':
      return `missing_seat: ${String(problem.seatId)} is in the match but has no standing`
    case 'bad_rank':
      return `bad_rank: ${String(problem.seatId)} has rank ${String(problem.rank)}; ranks are integers >= 1`
    case 'rank_not_competition_ordered':
      return `rank_not_competition_ordered: found rank ${String(problem.rank)} where ${String(problem.expected)} was required; ties share a rank and the next rank skips (1, 1, 3)`
  }
}

export function checkResultStandingsWellFormed<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>): CheckRecorder {
  const recorder = new CheckRecorder(
    'result-standings-well-formed',
    'Every result is well-formed: one standing per seat, or empty for a reason that did not count',
  )

  checkCompletedMatches(prep, recorder)
  checkAbortedMatches(prep, recorder)

  if (recorder.assertionCount === 0) {
    recorder.skip('no match reached a result, so there was nothing to validate')
  }
  return recorder
}

/** The playout half: every match the suite drove to an ending of its own. */
function checkCompletedMatches<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(
  prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>,
  recorder: CheckRecorder,
): void {
  for (const run of prep.runs) {
    if (run.crash !== null) continue
    const result = run.playout.result
    if (result === null) continue // `random-playout-terminates` owns that failure.
    validate(
      recorder,
      result,
      run.scenario.roster.map((seat) => seat.seatId),
      `${run.scenario.label} seed=${String(run.context.seed)}`,
    )
  }
}

/** The abort half: matches the game itself says record no result. */
function checkAbortedMatches<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(
  prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>,
  recorder: CheckRecorder,
): void {
  const scenarios = prep.subject.abortScenarios ?? []
  if (scenarios.length === 0) {
    // Deliberately a note and not a failure: a game with no unrecorded ending
    // is legal. It is loud because the alternative is a suite that reports a
    // green `result-standings-well-formed` having never seen empty standings.
    recorder.note(
      'the game declares no abortScenarios, so the unrecorded half of ADR-0006 (empty standings) was never exercised; every abortable lobby should declare one',
    )
    return
  }

  for (const scenario of prep.scenarios) {
    const context = prep.runs.find((run) => run.scenario === scenario)?.context
    for (const abort of scenarios) {
      const where = `${scenario.label} · abort:${abort.label}`
      const afterSteps = abort.afterSteps ?? 0
      let outcome
      try {
        outcome = abortRun<TState, TAction, TSettings, TEvent>({
          server: prep.subject.server,
          settings: scenario.settings,
          variantLabel: scenario.label,
          roster: scenario.roster,
          context: contextFor(scenario, context, prep.baseSeed, abort.label),
          maxSteps: prep.maxSteps,
          chooseAction: prep.chooseAction,
          trapAmbient: prep.trapAmbient,
          afterSteps,
          // The declared one-dispatch clock offset. Scoped here and nowhere
          // else: the plies above still run on the subject's `nowStepMs`.
          advanceMs: abort.advanceMs ?? 0,
          abortAction: (state, roster) => abort.abortAction(state, roster),
        })
      } catch (error) {
        recorder.fail({
          message: `the game threw while reaching the abort: ${error instanceof Error ? error.message : String(error)}`,
          where,
        })
        continue
      }

      if (outcome.unreachable !== null) {
        recorder.fail({
          message: `the declared abort never ran (${outcome.unreachable}), so empty standings were not exercised`,
          where,
        })
        continue
      }

      const result = outcome.result
      recorder.assert(result !== null, () => ({
        // The clock is named because a deadline-gated abort is the common
        // reason for this failure and looks nothing like a bug from here: the
        // action ran, the game simply decided it was too early.
        message: `the abort action left getResult() null, so the match never ended (dispatched at ctx.now=${String(outcome.abortNow)}, ${String(abort.advanceMs ?? 0)} ms of declared advanceMs; an abort gated on a deadline needs AbortScenario.advanceMs)`,
        where,
        detail: preview(outcome.state, 300),
      }))
      if (result === null) continue

      // An abort scenario is the game's own claim that this ending does not
      // count. A recorded reason here means the claim and the result disagree,
      // and the standings check below would then pass for the wrong reason.
      recorder.assert(!isRecordedResult(result), () => ({
        message: `the abort produced reason '${result.reason}', which is recorded; an ending that does not count uses one of ${UNRECORDED_RESULT_REASONS.join(' | ')}`,
        where,
        detail: preview(result, 300),
      }))

      validate(
        recorder,
        result,
        scenario.roster.map((seat) => seat.seatId),
        where,
      )
    }
  }
}

function contextFor(
  scenario: { readonly label: string; readonly baseContext: Omit<ContextOptions, 'seed'> },
  sample: ContextOptions | undefined,
  baseSeed: string,
  abortLabel: string,
): ContextOptions {
  const seed = seedFor(baseSeed, scenario.label, 'abort', abortLabel)
  return sample === undefined ? { ...scenario.baseContext, seed } : { ...sample, seed }
}

function validate(
  recorder: CheckRecorder,
  result: MatchResult,
  seatIds: readonly SeatId[],
  where: string,
): void {
  // Typed as `ResultReason`, so only a JavaScript game or a hand-built blob
  // can get here — which is exactly the caller the SDK validator trusts.
  recorder.assert((RESULT_REASONS as readonly string[]).includes(result.reason), () => ({
    message: `result.reason '${result.reason}' is not one of ${RESULT_REASONS.join(' | ')}`,
    where,
    detail: preview(result, 300),
  }))

  const problems = validateMatchResult(result, seatIds)
  recorder.assert(problems.length === 0, () => ({
    message: problems.map(describeProblem).join('; '),
    where,
    detail: `seats [${seatIds.map(String).join(', ')}] · ${preview(result, 300)} · problems ${JSON.stringify(problems)}`,
  }))
}
