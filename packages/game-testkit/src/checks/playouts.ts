/**
 * `random-playout-terminates`.
 *
 * A game that can reach a position with no legal move and no result is a room
 * that never closes: two players stuck, a Redis key that outlives its TTL
 * logic, and a rematch button that does nothing. It is also the single
 * cheapest bug to find, because a few hundred random games find it and a
 * human reading the rules does not.
 *
 * So every seeded playout must reach a non-null `getResult` inside the step
 * budget, and the result it reaches must be well-formed: one standing per
 * seat, ranks that start at 1 and leave no gaps a tie does not explain, and a
 * reason from the declared set.
 */

import { type GameEvent, type MatchResult, RESULT_REASONS, type SeatId } from '@playhall/game-sdk'
import { CheckRecorder } from '../report.js'
import type { Prepared } from '../internal/prepare.js'
import { preview } from '../internal/value.js'

export function checkRandomPlayoutTerminates<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>): CheckRecorder {
  const recorder = new CheckRecorder(
    'random-playout-terminates',
    'Random playouts all reach a valid result',
  )

  if (
    prep.subject.server.getLegalActions === undefined &&
    prep.subject.chooseAction === undefined
  ) {
    recorder.skip(
      'the game implements neither getLegalActions nor a chooseAction override, so playouts cannot be generated',
    )
    return recorder
  }
  if (prep.runs.length === 0) {
    recorder.skip('no scenarios were generated')
    return recorder
  }

  let longest = 0
  for (const run of prep.runs) {
    const where = `${run.scenario.label} seed=${String(run.context.seed)}`

    if (run.crash !== null) {
      recorder.fail({ message: `the game threw during a playout: ${run.crash.message}`, where })
      continue
    }

    longest = Math.max(longest, run.playout.steps.length)

    recorder.assert(run.playout.stalledAt === null, () => ({
      message: `the playout stalled at sequence ${String(run.playout.stalledAt)}: no seat had a legal action but getResult() was still null`,
      where,
      detail: preview(run.playout.finalState, 300),
    }))
    recorder.assert(!run.playout.truncated, () => ({
      message: `the playout hit the ${prep.maxSteps}-step budget without reaching a result`,
      where,
    }))
    if (run.playout.stalledAt !== null || run.playout.truncated) continue

    const result = run.playout.result
    recorder.assert(result !== null, () => ({
      message: 'the playout ended without a result',
      where,
    }))
    if (result === null) continue

    for (const problem of resultProblems(
      result,
      run.scenario.roster.map((seat) => seat.seatId),
    )) {
      recorder.fail({ message: problem, where, detail: preview(result, 300) })
    }
  }

  recorder.note(`longest playout: ${longest} steps (budget ${prep.maxSteps})`)
  return recorder
}

/** Structural rules every `MatchResult` must satisfy. */
export function resultProblems(result: MatchResult, seatIds: readonly SeatId[]): readonly string[] {
  const problems: string[] = []

  if (!(RESULT_REASONS as readonly string[]).includes(result.reason)) {
    problems.push(`result.reason '${result.reason}' is not one of ${RESULT_REASONS.join(' | ')}`)
  }

  const standingSeats = result.standings.map((standing) => String(standing.seatId))
  const expected = seatIds.map(String)
  const missing = expected.filter((seatId) => !standingSeats.includes(seatId))
  const extra = standingSeats.filter((seatId) => !expected.includes(seatId))
  if (missing.length > 0) problems.push(`result omits standings for ${missing.join(', ')}`)
  if (extra.length > 0) problems.push(`result has standings for unknown seats ${extra.join(', ')}`)
  if (new Set(standingSeats).size !== standingSeats.length) {
    problems.push('result has duplicate standings for a seat')
  }

  const ranks = result.standings.map((standing) => standing.rank).sort((a, b) => a - b)
  if (ranks.some((rank) => !Number.isInteger(rank) || rank < 1)) {
    problems.push(`ranks must be integers >= 1, got ${ranks.join(', ')}`)
  } else if (ranks.length > 0) {
    // Ties share a rank and then skip: 1, 1, 3 is valid; 1, 1, 2 is not.
    let position = 1
    let index = 0
    while (index < ranks.length) {
      const rank = ranks[index]
      if (rank !== position) {
        problems.push(
          `ranks are not competition-ranked (expected ${position}, got ${String(rank)} in ${ranks.join(', ')})`,
        )
        break
      }
      let tied = 0
      while (index + tied < ranks.length && ranks[index + tied] === rank) tied += 1
      position += tied
      index += tied
    }
  }

  return problems
}
