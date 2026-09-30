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
 * budget. Whether the result it reached is *well-formed* is a separate
 * question with a separate answer, and `result-standings-well-formed` owns it
 * — one check per property, so a failure names the thing that broke.
 */

import type { GameEvent } from '@playhall/game-sdk'
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

    recorder.assert(run.playout.result !== null, () => ({
      message: 'the playout ended without a result',
      where,
    }))
  }

  recorder.note(`longest playout: ${longest} steps (budget ${prep.maxSteps})`)
  return recorder
}
