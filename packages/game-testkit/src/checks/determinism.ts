/**
 * `determinism` and `reducer-purity`.
 *
 * Determinism is the property every other guarantee is built on: replay,
 * crash recovery from the match log, reproducible bug reports, and the
 * server being the single source of truth all collapse without it.
 *
 * Three independent attacks, because each catches something the others miss:
 *
 *   1. **Re-run the whole playout.** Same seed in, same states out. Catches
 *      anything that varies run to run, including iteration over a `Set` that
 *      was built from ambient data.
 *   2. **Replay the action log.** Rebuild the match from `createInitialState`
 *      plus the recorded `(sequence, seat, action)` triples, the way the room
 *      runner does after a restart. Catches a reducer that depends on state
 *      the log does not carry.
 *   3. **Trap the ambient sources.** `Date.now`, `Math.random` and
 *      `performance.now` throw while game code runs, so a violation is caught
 *      even when it happens not to change the outcome on this seed. (The
 *      playouts in `prepare` already run under the trap; this check reports
 *      the crash.)
 */

import type { GameEvent } from '@playhall/game-sdk'
import { CheckRecorder } from '../report.js'
import { type Prepared, healthyRuns } from '../internal/prepare.js'
import { contextAt, playout, replay, statesOf } from '../internal/driver.js'
import { deepEqual, detachedClone, preview, stableStringify } from '../internal/value.js'

export function checkDeterminism<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>): CheckRecorder {
  const recorder = new CheckRecorder(
    'determinism',
    'Same seed and same actions reproduce the state',
  )
  const { server } = prep.subject

  for (const run of prep.runs) {
    if (run.crash !== null) {
      recorder.fail({
        message: `the game threw during a playout: ${run.crash.message}`,
        where: `${run.scenario.label} seed=${String(run.context.seed)}`,
        detail: run.crash.name === 'AmbientAccessError' ? run.crash.stack : undefined,
      })
      continue
    }

    const first = run.playout
    const second = playout<TState, TAction, TSettings, TEvent>({
      server,
      settings: run.scenario.settings,
      variantLabel: run.scenario.label,
      roster: run.scenario.roster,
      context: run.context,
      maxSteps: prep.maxSteps,
      chooseAction: prep.chooseAction,
      trapAmbient: prep.trapAmbient,
    })

    const where = `${run.scenario.label} seed=${String(run.context.seed)}`

    recorder.assert(first.steps.length === second.steps.length, () => ({
      message: `a repeated playout took a different number of steps (${first.steps.length} vs ${second.steps.length})`,
      where,
    }))
    recorder.assert(deepEqual(statesOf(first), statesOf(second)), () => ({
      message: 'a repeated playout produced different states',
      where,
      detail: firstDivergence(statesOf(first), statesOf(second)),
    }))
    recorder.assert(
      deepEqual(
        first.steps.map((step) => step.events),
        second.steps.map((step) => step.events),
      ),
      () => ({ message: 'a repeated playout produced different events', where }),
    )
    recorder.assert(
      deepEqual(
        first.steps.map((step) => step.timers),
        second.steps.map((step) => step.timers),
      ),
      () => ({ message: 'a repeated playout produced different timer commands', where }),
    )
    recorder.assert(deepEqual(first.result, second.result), () => ({
      message: 'a repeated playout produced a different result',
      where,
      detail: `${preview(first.result)} vs ${preview(second.result)}`,
    }))

    // 2. Rebuild from the match log alone, as the runner does after a restart.
    const log = first.steps.map((step) => ({
      sequence: step.sequence,
      seatId: step.seatId,
      action: step.action,
    }))
    const replayed = replay<TState, TAction, TSettings, TEvent>(
      server,
      run.scenario.settings,
      run.scenario.roster,
      run.context,
      log,
      prep.trapAmbient,
    )
    recorder.assert(deepEqual(replayed.states, statesOf(first)), () => ({
      message: 'replaying the action log did not reproduce the live states',
      where,
      detail: firstDivergence(statesOf(first), replayed.states),
    }))

    // 3. Resume from the middle, as a crash recovery would.
    if (first.steps.length >= 2) {
      const resumeIndex = Math.floor(first.steps.length / 2)
      const resumeStep = first.steps[resumeIndex]
      if (resumeStep !== undefined) {
        const resumed = replay<TState, TAction, TSettings, TEvent>(
          server,
          run.scenario.settings,
          run.scenario.roster,
          run.context,
          log,
          prep.trapAmbient,
          { state: resumeStep.before, fromSequence: resumeStep.sequence },
        )
        const expected = statesOf(first).slice(resumeIndex)
        recorder.assert(deepEqual(resumed.states, expected), () => ({
          message: `resuming from sequence ${resumeStep.sequence} did not reproduce the live states`,
          where,
          detail: firstDivergence(expected, resumed.states),
        }))
      }
    }
  }

  if (prep.runs.length === 0) recorder.skip('no scenarios were generated')
  return recorder
}

export function checkReducerPurity<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>): CheckRecorder {
  const recorder = new CheckRecorder(
    'reducer-purity',
    'validateAction, applyAction and getViewFor do not mutate state',
  )
  const { server } = prep.subject
  const runs = healthyRuns(prep.runs)
  if (runs.length === 0) {
    recorder.skip('no playout completed, so there are no states to probe')
    return recorder
  }

  // Sampling: purity is a property of the code, not of the position, so a
  // handful of states per scenario finds a mutating reducer just as reliably
  // as all of them and keeps the suite inside a CI budget.
  for (const run of runs.slice(0, 8)) {
    const where = `${run.scenario.label} seed=${String(run.context.seed)}`
    for (const step of sample(run.playout.steps, 4)) {
      const original = stableStringify(step.before)

      prep.guard(() => {
        server.validateAction(
          contextAt(run.context, step.sequence),
          step.before,
          step.seatId,
          step.action,
        )
      })
      recorder.assert(stableStringify(step.before) === original, () => ({
        message: 'validateAction mutated the state it was given',
        where,
      }))

      const probe = detachedClone(step.before)
      const applied = prep.guard(() =>
        server.applyAction(contextAt(run.context, step.sequence), probe, step.seatId, step.action),
      )
      recorder.assert(stableStringify(probe) === original, () => ({
        message: 'applyAction mutated the state it was given instead of returning a new one',
        where,
        detail: `before: ${preview(step.before)}`,
      }))
      recorder.assert(deepEqual(applied.state, step.after), () => ({
        message: 'applyAction on a detached copy produced a different state',
        where,
      }))

      for (const { label, viewer } of prep.viewersFor(run.scenario.roster)) {
        const viewProbe = detachedClone(step.after)
        const before = stableStringify(viewProbe)
        const view = prep.guard(() => server.getViewFor(viewProbe, viewer))
        recorder.assert(stableStringify(viewProbe) === before, () => ({
          message: 'getViewFor mutated the state it was given',
          where: `${where}, ${label}`,
        }))
        const again = prep.guard(() => server.getViewFor(viewProbe, viewer))
        recorder.assert(deepEqual(view, again), () => ({
          message:
            'getViewFor is not deterministic: two calls with the same state and viewer disagreed',
          where: `${where}, ${label}`,
          detail: `${preview(view)} vs ${preview(again)}`,
        }))
      }
    }
  }

  return recorder
}

function firstDivergence(expected: readonly unknown[], actual: readonly unknown[]): string {
  const length = Math.max(expected.length, actual.length)
  for (let i = 0; i < length; i += 1) {
    if (!deepEqual(expected[i], actual[i])) {
      return `first divergence at index ${i}: expected ${preview(expected[i], 200)}, got ${preview(actual[i], 200)}`
    }
  }
  return 'sequences are equal element-wise but compared unequal'
}

function sample<T>(items: readonly T[], count: number): readonly T[] {
  if (items.length <= count) return items
  const stride = Math.max(1, Math.floor(items.length / count))
  const picked: T[] = []
  for (let i = 0; i < items.length && picked.length < count; i += stride) {
    const item = items[i]
    if (item !== undefined) picked.push(item)
  }
  return picked
}
