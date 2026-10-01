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

/**
 * What this check does and does not claim.
 *
 * **Claimed:** `validateAction`, `applyAction` and `getViewFor` do not mutate
 * the state they are given — that is the title, and it is the contract
 * `apps/realtime` relies on when it hands a live room's state to a game module
 * and then keeps using its own copy.
 *
 * **Not claimed: `getResult` and `getLegalActions`.** The driver calls both of
 * them once per loop iteration and deliberately hands them the *retained*
 * object rather than a copy (`handOver` in `driver.ts` explains why). An impure
 * one is therefore not invisible — it is reported by `determinism` as
 * *"replaying the action log did not reproduce the live states"*, because the
 * scribble lands on the live state and the replay's states never see it. That
 * message blames replay for a purity bug, and PER-275 measured it on the
 * testkit's own tic-tac-toe (`mutants.test.ts` pins both shapes so this
 * paragraph cannot rot).
 *
 * Bringing those two under the hand-over would widen what this check promises a
 * game author, which is an SDK-contract-adjacent change and needs a CTO ADR
 * first; it would also silence the signal entirely unless the verdict is
 * recorded, because the mutation would land on a copy nobody reads. So the
 * decision here is to document the boundary and pin the current behaviour, not
 * to move it.
 */
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

  // 1. The driver's own verdict on every call it handed a copy to.
  //
  // This is the half that does not sample. The driver watches the copy it hands
  // `applyAction` on every step of every run, so a reducer that writes onto its
  // input in *some* branches is caught at whatever depth the branch fires. The
  // probe loop below cannot do that job: it re-ran four steps per run on a fixed
  // stride, so 3 of tic-tac-toe's 9 depths were blind on every run, forever
  // (PER-275).
  //
  // One assertion per run, not per step: a reducer that mutates on every step
  // would otherwise emit hundreds of identical failures, and the count of
  // affected steps belongs in `detail` rather than in the failure list.
  for (const run of runs) {
    const where = `${run.scenario.label} seed=${String(run.context.seed)}`
    const impure = run.playout.steps.filter((step) => step.mutatedBy.length > 0)
    const first = impure[0]
    recorder.assert(first === undefined, () => ({
      message: `${first?.mutatedBy.join(' and ') ?? 'a pure call'} mutated the state it was given instead of returning a new one`,
      where: `${where}, sequence ${String(first?.sequence)}`,
      detail: `${String(impure.length)} of ${String(run.playout.steps.length)} steps mutated their input; state as the platform handed it over: ${preview(first?.before)}`,
    }))
  }

  // 2. Probes the driver does not make for itself.
  //
  // `validateAction` and `getViewFor` are not called once per step by the
  // playout, so there is no hand-over to watch and the check has to call them.
  // Those two are still a stride sample — `maxStepsPerPlayout` is 500 and
  // `getViewFor` is probed once per viewer kind, so probing every step is a
  // budget decision rather than a free one. The blindness this leaves is
  // narrower than PER-275's: it needs a game whose `validateAction` or
  // `getViewFor` mutates only at some depths.
  for (const run of runs.slice(0, 8)) {
    const where = `${run.scenario.label} seed=${String(run.context.seed)}`
    for (const step of sample(run.playout.steps, 4)) {
      const original = stableStringify(step.before)

      // Every probe below gets its own detached copy, including this one. The
      // driver keeps `step.before` pristine; if the check wrote into it, a
      // mutating `validateAction` would pollute the baseline that the
      // `applyAction` assertion reads, and the same mutation would be reported
      // twice — once against the wrong function.
      const validateProbe = detachedClone(step.before)
      prep.guard(() => {
        server.validateAction(
          contextAt(run.context, step.sequence),
          validateProbe,
          step.seatId,
          step.action,
        )
      })
      recorder.assert(stableStringify(validateProbe) === original, () => ({
        message: 'validateAction mutated the state it was given',
        where,
      }))

      // `applyAction` is probed here as well as watched above, and the overlap
      // is not redundant: the driver watches the *first* call for each step,
      // this probe is a *second* application of the same step. A reducer that
      // is pure until it is called twice with the same state — a memo written
      // on a cache hit rather than a miss — is only visible to the probe. The
      // clone is needed for the equality assertion anyway, so the extra cost is
      // one `stableStringify`.
      const probe = detachedClone(step.before)
      const applied = prep.guard(() =>
        server.applyAction(contextAt(run.context, step.sequence), probe, step.seatId, step.action),
      )
      recorder.assert(stableStringify(probe) === original, () => ({
        message: 'applyAction mutated the state it was given instead of returning a new one',
        where: `${where}, on a repeat application of sequence ${String(step.sequence)}`,
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
