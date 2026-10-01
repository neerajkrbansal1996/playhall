/**
 * `serialization-round-trip` and `reconnect-snapshot-matches-live`.
 *
 * These two are the same worry seen from two ends. Live room state lives in
 * Redis as JSON and the match log replays from Postgres, so every state a
 * game produces makes at least one `JSON.stringify` / `JSON.parse` trip
 * before a player sees it again. A `Map`, a `Set`, a `Date`, a class
 * instance, `undefined` or `NaN` all survive in memory and quietly change
 * shape on the way back — which is why this never shows up in a unit test
 * and always shows up after a deploy.
 *
 * `reconnect-snapshot-matches-live` then asserts the thing the player
 * actually cares about: the snapshot you get when your phone drops the socket
 * and reconnects is the same game you were looking at. The platform builds
 * that snapshot as `getViewFor(restoredState, viewer)`, so the check compares
 * it against `getViewFor(liveState, viewer)` for every viewer kind.
 */

import type { GameEvent, MatchLog } from '@playhall/game-sdk'
import { CheckRecorder } from '../report.js'
import { type Prepared, healthyRuns } from '../internal/prepare.js'
import { contextAt, replay, statesOf } from '../internal/driver.js'
import {
  deepEqual,
  findJsonSafetyProblems,
  jsonRoundTrip,
  preview,
  stableStringify,
} from '../internal/value.js'

export function checkSerializationRoundTrip<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>): CheckRecorder {
  const recorder = new CheckRecorder(
    'serialization-round-trip',
    'State survives JSON serialization identically',
  )
  const { server } = prep.subject
  const runs = healthyRuns(prep.runs)
  if (runs.length === 0) {
    recorder.skip('no playout completed, so there are no states to round-trip')
    return recorder
  }

  for (const run of runs) {
    const where0 = `${run.scenario.label} seed=${String(run.context.seed)}`
    const states = statesOf(run.playout)

    for (let index = 0; index < states.length; index += 1) {
      const state = states[index]
      if (state === undefined) continue
      const where = `${where0} step=${index}`

      const problems = findJsonSafetyProblems(state)
      recorder.assert(problems.length === 0, () => ({
        message: 'state is not JSON-safe',
        where,
        detail: problems
          .slice(0, 5)
          .map((problem) => `${problem.path || '<root>'}: ${problem.reason}`)
          .join('; '),
      }))

      let restored: TState
      try {
        restored = jsonRoundTrip(state)
      } catch (error) {
        recorder.fail({
          message: `state could not be serialized: ${error instanceof Error ? error.message : String(error)}`,
          where,
        })
        continue
      }
      recorder.assert(deepEqual(restored, state), () => ({
        message: 'state changed across a JSON round trip',
        where,
        detail: `live: ${preview(state, 240)}\n        restored: ${preview(restored, 240)}`,
      }))

      // `stateSchema` is what the platform uses to reject a corrupt blob from
      // Redis. If it rejects the game's own state, a restart loses the match.
      if (server.stateSchema !== undefined) {
        const parsed = server.stateSchema.safeParse(restored)
        recorder.assert(parsed.success, () => ({
          message: 'stateSchema rejects the game’s own state after a round trip',
          where,
          detail: parsed.success ? '' : preview(parsed.error.issues.slice(0, 3)),
        }))
      }

      // A result computed from the restored state must match the live one:
      // this is what decides whether a recovered match is over.
      recorder.assert(
        deepEqual(
          prep.guard(() => server.getResult(restored)),
          prep.guard(() => server.getResult(state)),
        ),
        () => ({ message: 'getResult disagrees between live and restored state', where }),
      )
    }

    // Resuming from the restored mid-match state must reproduce the rest of
    // the game exactly — the crash-recovery path, end to end.
    const midIndex = Math.floor(run.playout.steps.length / 2)
    const midStep = run.playout.steps[midIndex]
    if (midStep !== undefined) {
      const log: MatchLog<TAction> = run.playout.steps.map((step) => ({
        kind: 'action' as const,
        sequence: step.sequence,
        nowMs: contextAt(run.context, step.sequence).now,
        seatId: step.seatId,
        action: step.action,
      }))
      const resumed = replay<TState, TAction, TSettings, TEvent>(
        server,
        run.scenario.settings,
        run.scenario.roster,
        run.context,
        log,
        prep.trapAmbient,
        { state: jsonRoundTrip(midStep.before), fromSequence: midStep.sequence },
      )
      recorder.assert(deepEqual(resumed.states, states.slice(midIndex)), () => ({
        message: 'resuming from a JSON-restored state did not reproduce the live match',
        where: `${where0} resumed from sequence ${midStep.sequence}`,
      }))
    }
  }

  return recorder
}

export function checkReconnectSnapshot<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>): CheckRecorder {
  const recorder = new CheckRecorder(
    'reconnect-snapshot-matches-live',
    'The reconnect snapshot equals the live view for every viewer',
  )
  const { server } = prep.subject
  const runs = healthyRuns(prep.runs)
  if (runs.length === 0) {
    recorder.skip('no playout completed, so there is nothing to reconnect to')
    return recorder
  }

  const hasOnReconnect = server.onReconnect !== undefined
  if (!hasOnReconnect) {
    recorder.note(
      'the game does not implement onReconnect, so reconnection is purely a platform concern for it (the common case)',
    )
  }

  for (const run of runs.slice(0, 12)) {
    const where0 = `${run.scenario.label} seed=${String(run.context.seed)}`
    const states = statesOf(run.playout)
    const viewers = prep.viewersFor(run.scenario.roster)

    for (let index = 0; index < states.length; index += 1) {
      const live = states[index]
      if (live === undefined) continue
      const restored = jsonRoundTrip(live)
      const where = `${where0} step=${index}`

      for (const { label, viewer } of viewers) {
        const liveView = prep.guard(() => server.getViewFor(live, viewer))
        const snapshot = prep.guard(() => server.getViewFor(restored, viewer))
        recorder.assert(deepEqual(liveView, snapshot), () => ({
          message: `the reconnect snapshot for ${label} differs from the live view`,
          where,
          detail: `live: ${preview(liveView, 240)}\n        snapshot: ${preview(snapshot, 240)}`,
        }))
      }
    }

    // `onReconnect` must be deterministic, must not change what any other
    // seat sees, and must not resurrect a finished match.
    const onReconnect = server.onReconnect?.bind(server)
    if (onReconnect !== undefined) {
      // Probe several positions, not just the midpoint: a hook that resets
      // the current trick or phase is a no-op at exactly the moments when
      // there is nothing in flight, which is most of them.
      for (const [midIndex, state] of sampleIndexed(states, 5)) {
        for (const seat of run.scenario.roster) {
          const ctx = contextAt(run.context, midIndex)
          const before = stableStringify(state)
          const first = prep.guard(() => onReconnect(ctx, state, seat.seatId))
          const second = prep.guard(() => onReconnect(ctx, state, seat.seatId))
          const where = `${where0} step=${midIndex} seat=${String(seat.seatId)}`

          recorder.assert(stableStringify(state) === before, () => ({
            message: 'onReconnect mutated the state it was given',
            where,
          }))
          recorder.assert(deepEqual(first.state, second.state), () => ({
            message: 'onReconnect is not deterministic',
            where,
          }))
          recorder.assert(
            deepEqual(
              prep.guard(() => server.getResult(first.state)),
              prep.guard(() => server.getResult(state)),
            ),
            () => ({ message: 'onReconnect changed the match result', where }),
          )
          for (const other of run.scenario.roster) {
            if (other.seatId === seat.seatId) continue
            recorder.assert(
              deepEqual(
                prep.guard(() =>
                  server.getViewFor(first.state, { kind: 'seat', seatId: other.seatId }),
                ),
                prep.guard(() => server.getViewFor(state, { kind: 'seat', seatId: other.seatId })),
              ),
              () => ({
                message: `one seat reconnecting changed what seat ${String(other.seatId)} sees`,
                where,
              }),
            )
          }
        }
      }
    }
  }

  return recorder
}

function sampleIndexed<T>(items: readonly T[], count: number): readonly (readonly [number, T])[] {
  const stride = items.length <= count ? 1 : Math.max(1, Math.floor(items.length / count))
  const picked: (readonly [number, T])[] = []
  for (let i = 0; i < items.length && picked.length < count; i += stride) {
    const item = items[i]
    if (item !== undefined) picked.push([i, item])
  }
  return picked
}
