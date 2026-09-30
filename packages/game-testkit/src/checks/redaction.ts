/**
 * `no-hidden-info-leak` — the check that exists because inspection does not
 * work.
 *
 * A leak is never written on purpose. It arrives as `getViewFor` returning
 * the whole state "for now", as a debug field nobody removed, as an event
 * payload that carries what the view carefully redacted, or as a message
 * string that names a card. None of those survive a fuzzer that knows what
 * the secret values are and searches for them by value.
 *
 * So the subject declares its secrets, and this check sweeps:
 *
 *   - every state the playouts passed through,
 *   - × every viewer kind (each seat, a spectator, a seat that is not in the
 *     match at all, and replay),
 *   - × every declared secret,
 *
 * asserting that a secret value never appears in the view of a viewer that is
 * not entitled to it — as a leaf, as an object key, or as a substring of a
 * string. Events get the same treatment, routed by `audience`, because a game
 * that redacts the view and then broadcasts `card_drawn` has leaked anyway.
 *
 * `replay` is exempt: the platform may only build a replay viewer after
 * `getResult` is non-null, which the reconnect and playout checks cover.
 */

import {
  type GameEvent,
  type SeatId,
  type Viewer,
  audienceIncludesSeat,
  audienceIncludesSpectators,
} from '@playhall/game-sdk'
import { CheckRecorder } from '../report.js'
import { type Prepared, healthyRuns } from '../internal/prepare.js'
import { findJsonSafetyProblems, findScalar, preview } from '../internal/value.js'
import type { SecretDescriptor, SecretHolding } from '../subject.js'

export function checkNoHiddenInfoLeak<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>): CheckRecorder {
  const recorder = new CheckRecorder(
    'no-hidden-info-leak',
    'getViewFor leaks no hidden information',
  )
  const { server } = prep.subject
  const secrets = prep.subject.secrets ?? []
  const runs = healthyRuns(prep.runs)

  if (runs.length === 0) {
    recorder.skip('no playout completed, so there are no states to fuzz')
    return recorder
  }
  if (secrets.length === 0) {
    recorder.note(
      'the game declares no hidden information, so only the structural view checks run; `manifest-valid` enforces that this matches the manifest',
    )
  }

  for (const run of runs) {
    const viewers = prep.viewersFor(run.scenario.roster)
    const states = [run.playout.initial.state, ...run.playout.steps.map((step) => step.after)]

    for (let index = 0; index < states.length; index += 1) {
      const state = states[index]
      if (state === undefined) continue
      const where = `${run.scenario.label} seed=${String(run.context.seed)} step=${index}`

      for (const { label, viewer } of viewers) {
        let view: TView
        try {
          view = prep.guard(() => server.getViewFor(state, viewer))
        } catch (error) {
          recorder.fail({
            message: `getViewFor threw for ${label}: ${error instanceof Error ? error.message : String(error)}`,
            where,
          })
          continue
        }

        // A view that is not JSON-safe cannot reach a client intact, and the
        // parts that silently disappear are exactly the parts nobody tested.
        const problems = findJsonSafetyProblems(view)
        recorder.assert(problems.length === 0, () => ({
          message: `the view for ${label} is not JSON-safe`,
          where,
          detail: problems
            .slice(0, 5)
            .map((problem) => `${problem.path || '<root>'}: ${problem.reason}`)
            .join('; '),
        }))

        if (viewer.kind === 'replay') continue

        for (const secret of secrets) {
          for (const holding of secret.holdings(state)) {
            if (isEntitled(secret, holding, viewer)) continue
            for (const value of holding.values) {
              const hit = findScalar(view, value)
              recorder.assert(hit === null, () => ({
                message: `the view for ${label} leaks '${secret.label}'`,
                where,
                detail: `value ${preview(value, 80)} found at ${hit ?? '?'} in ${preview(view, 300)}`,
              }))
            }
          }
        }
      }
    }

    // Events are the second way state reaches a client.
    const eventBatches = [
      { index: 0, events: run.playout.initial.events, state: run.playout.initial.state },
      ...run.playout.steps.map((step, stepIndex) => ({
        index: stepIndex + 1,
        events: step.events,
        // The state the event describes is the one it was produced with.
        state: step.after,
      })),
    ]

    for (const batch of eventBatches) {
      for (const event of batch.events) {
        const where = `${run.scenario.label} seed=${String(run.context.seed)} step=${batch.index} event='${event.type}'`

        const problems = findJsonSafetyProblems(event.payload)
        recorder.assert(problems.length === 0, () => ({
          message: `event '${event.type}' has a payload that is not JSON-safe`,
          where,
          detail: problems
            .slice(0, 5)
            .map((problem) => `${problem.path || '<root>'}: ${problem.reason}`)
            .join('; '),
        }))

        if (event.audience.kind === 'server') continue

        for (const secret of secrets) {
          for (const holding of secret.holdings(batch.state)) {
            if (holding.values.length === 0) continue
            const entitled = new Set(holding.entitledSeats.map(String))

            for (const seat of run.scenario.roster) {
              if (!audienceIncludesSeat(event.audience, seat.seatId)) continue
              if (entitled.has(String(seat.seatId))) continue
              for (const value of holding.values) {
                const hit = findScalar(event.payload, value)
                recorder.assert(hit === null, () => ({
                  message: `event '${event.type}' delivers '${secret.label}' to seat ${String(seat.seatId)}, which is not entitled to it`,
                  where,
                  detail: `value ${preview(value, 80)} found at ${hit ?? '?'}`,
                }))
              }
            }

            if (audienceIncludesSpectators(event.audience) && secret.visibleToSpectators !== true) {
              for (const value of holding.values) {
                const hit = findScalar(event.payload, value)
                recorder.assert(hit === null, () => ({
                  message: `event '${event.type}' delivers '${secret.label}' to spectators`,
                  where,
                  detail: `value ${preview(value, 80)} found at ${hit ?? '?'}`,
                }))
              }
            }
          }
        }
      }
    }
  }

  return recorder
}

function isEntitled<TState>(
  secret: SecretDescriptor<TState>,
  holding: SecretHolding,
  viewer: Viewer,
): boolean {
  if (viewer.kind === 'replay') return true
  if (viewer.kind === 'spectator') return secret.visibleToSpectators === true
  const entitled: readonly SeatId[] = holding.entitledSeats
  return entitled.some((seatId) => String(seatId) === String(viewer.seatId))
}
