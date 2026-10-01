/**
 * `illegal-action-rejected` and `legal-actions-agree`.
 *
 * Principle 5: the server is the single source of truth. Every rejection path
 * here is one a modified client will exercise on day one, so each of them has
 * to fail closed:
 *
 *   - **malformed** — `actionSchema` is the outer wall. The suite throws a
 *     standard battery of junk at it, including `__proto__` payloads, and
 *     requires every one to be rejected. A game never sees an unparsed action,
 *     so a schema that accepts junk turns into an `applyAction` crash.
 *   - **out of turn** — a legal move, submitted by a seat whose turn it is
 *     not. Only meaningful for sequential games, so it is skipped for
 *     simultaneous ones.
 *   - **not seated** — a seat id that is not in this match at all, which is
 *     what a spectator trying to play looks like on the wire.
 *   - **illegal** — well-formed, in turn, against the rules.
 *   - **after the match is over** — the tab that was left open and replays its
 *     last click.
 *
 * Every rejection is also checked for two things the code review usually
 * misses: that it is a *typed* rejection rather than a thrown error, and that
 * the state is byte-identical afterwards.
 *
 * `legal-actions-agree` closes the loop the other way. The contract says
 * `getLegalActions` must agree with `validateAction`; a disagreement in
 * either direction breaks move hints, bot seats and this very suite, which
 * uses `getLegalActions` to drive playouts.
 *
 * The reverse direction — `accepted ⊆ offered`, ADR-0012 — is the half that
 * needs more than sampling, because a spelling `getLegalActions` omits
 * *everywhere* cannot appear in a corpus drawn from what it offered. See
 * `../internal/perturb.ts` for the generator that closes that, and the coverage
 * notes at the end of the check for the number it reports.
 */

import { type GameEvent, STANDARD_ACTION_ERROR_CODES, type SeatId } from '@playhall/game-sdk'
import { CheckRecorder } from '../report.js'
import { type Prepared, healthyRuns } from '../internal/prepare.js'
import { contextAt, outsiderSeatId } from '../internal/driver.js'
import { type PerturbationPlan, perturb, planPerturbations } from '../internal/perturb.js'
import { preview, stableStringify } from '../internal/value.js'

/** Junk every `actionSchema` must reject, regardless of the game. */
export const STANDARD_MALFORMED_ACTIONS: readonly unknown[] = Object.freeze([
  undefined,
  null,
  0,
  -1,
  '',
  'place',
  true,
  [],
  {},
  { type: null },
  { type: 42 },
  { type: '__proto__' },
  { type: 'definitely-not-a-real-action-type' },
  JSON.parse('{"__proto__":{"polluted":true}}'),
  { type: 'place', cell: Number.NaN },
  { type: 'place', cell: Number.POSITIVE_INFINITY },
  { type: 'place', cell: '0' },
  { toString: 'not a function' },
])

export function checkIllegalActionRejected<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>): CheckRecorder {
  const recorder = new CheckRecorder(
    'illegal-action-rejected',
    'Illegal, out-of-turn and malformed actions are rejected with typed errors',
  )
  const { server, manifest } = prep.subject
  const allowedCodes = new Set<string>([
    ...STANDARD_ACTION_ERROR_CODES,
    ...(prep.subject.errorCodes ?? []),
  ])

  // 1. Schema wall. Independent of any state, so it runs once.
  for (const malformed of [
    ...STANDARD_MALFORMED_ACTIONS,
    ...(prep.subject.malformedActions ?? []),
  ]) {
    const parsed = server.actionSchema.safeParse(malformed)
    recorder.assert(!parsed.success, () => ({
      message: 'actionSchema accepted a malformed payload',
      detail: preview(malformed, 160),
    }))
  }

  const runs = healthyRuns(prep.runs)
  if (runs.length === 0) {
    recorder.skip('no playout completed, so state-dependent rejections could not be exercised')
    return recorder
  }

  // Unknown-key tolerance is a note, not a failure: zod's default `strip`
  // discards extra keys, and the game never reads them, so this is safe. It
  // is still worth saying out loud, because `.strict()` turns a
  // client-version mismatch into a loud rejection instead of a silent
  // no-op — and that is the kind of thing you want to know about on a phone.
  const sampleAction = runs.find((run) => run.playout.steps.length > 0)?.playout.steps[0]?.action
  if (sampleAction !== null && typeof sampleAction === 'object') {
    const withExtra = { ...(sampleAction as object), __atriumUnknownKey: 'probe' }
    if (server.actionSchema.safeParse(withExtra).success) {
      recorder.note(
        'actionSchema strips unknown keys instead of rejecting them; consider .strict() so a client sending an unrecognised field fails loudly',
      )
    }
  }

  const sequential = manifest.turnModel === 'sequential'
  if (!sequential) {
    recorder.note(
      'turnModel is not sequential, so the out-of-turn probe is skipped; simultaneous games legitimately accept actions from several seats at once',
    )
  }

  const getLegalActions = server.getLegalActions?.bind(server)

  for (const run of runs.slice(0, 12)) {
    const where0 = `${run.scenario.label} seed=${String(run.context.seed)}`
    const stranger = outsiderSeatId(run.scenario.roster)

    for (const step of sampleSteps(run.playout.steps, 5)) {
      const ctx = contextAt(run.context, step.sequence)
      const where = `${where0} step=${step.sequence}`
      const stateBefore = stableStringify(step.before)

      const probe = (
        seatId: SeatId,
        action: TAction,
        description: string,
        expectedCodes?: readonly string[],
      ): void => {
        let outcome: { readonly ok: boolean; readonly error?: { readonly code: string } }
        try {
          outcome = prep.guard(() => server.validateAction(ctx, step.before, seatId, action))
        } catch (error) {
          recorder.fail({
            message: `validateAction threw instead of returning a typed rejection for ${description}`,
            where,
            detail: error instanceof Error ? error.message : String(error),
          })
          return
        }
        recorder.assert(!outcome.ok, () => ({
          message: `${description} was accepted`,
          where,
          detail: preview(action, 160),
        }))
        if (outcome.ok) return
        const code = outcome.error?.code
        recorder.assert(typeof code === 'string' && allowedCodes.has(code), () => ({
          message: `${description} was rejected with an unrecognised error code '${String(code)}'`,
          where,
          detail: `allowed: ${[...allowedCodes].sort().join(', ')}`,
        }))
        if (expectedCodes !== undefined && typeof code === 'string') {
          recorder.assert(expectedCodes.includes(code), () => ({
            message: `${description} was rejected with '${code}'; expected one of ${expectedCodes.join(' | ')}`,
            where,
          }))
        }
        recorder.assert(stableStringify(step.before) === stateBefore, () => ({
          message: `state changed while rejecting ${description}`,
          where,
        }))
      }

      // Not seated: a seat id that is not in this match.
      probe(stranger, step.action, 'an action from a seat that is not in the match', [
        'not_seated',
        'not_your_turn',
      ])

      // Out of turn: the move that was about to be played, submitted by
      // somebody else. Only asserted when the other seat genuinely cannot
      // play it, which `getLegalActions` tells us.
      if (sequential) {
        for (const seat of run.scenario.roster) {
          if (seat.seatId === step.seatId) continue
          if (getLegalActions !== undefined) {
            const theirs = prep.guard(() => getLegalActions(step.before, seat.seatId))
            const sameAction = stableStringify(step.action)
            if (theirs.some((action) => stableStringify(action) === sameAction)) continue
          }
          probe(seat.seatId, step.action, `an out-of-turn action from seat ${String(seat.seatId)}`)
        }
      }

      // Illegal: subject-supplied, or drawn from the pool of actions this
      // game is known to produce and filtered down to the ones that are not
      // legal here. For tic-tac-toe that is "a cell already taken"; for a
      // card game, "a card you no longer hold". Both are exactly the replay
      // a modified client sends.
      const illegal =
        prep.subject.illegalActionsFor?.(step.before, step.seatId) ??
        notLegalHere(actionPool(run.playout), step.before, step.seatId, getLegalActions, prep)
      for (const action of illegal.slice(0, 4)) {
        probe(step.seatId, action, 'an illegal action')
      }
    }

    // Nothing is playable once the match is over.
    if (run.playout.result !== null) {
      const finalState = run.playout.finalState
      const finalStateText = stableStringify(finalState)
      const ctx = contextAt(run.context, run.playout.steps.length + 1)
      const lastStep = run.playout.steps[run.playout.steps.length - 1]
      if (lastStep !== undefined) {
        for (const seat of run.scenario.roster) {
          let outcome: { readonly ok: boolean; readonly error?: { readonly code: string } }
          try {
            outcome = prep.guard(() =>
              server.validateAction(ctx, finalState, seat.seatId, lastStep.action),
            )
          } catch (error) {
            recorder.fail({
              message: 'validateAction threw when called after the match ended',
              where: where0,
              detail: error instanceof Error ? error.message : String(error),
            })
            continue
          }
          recorder.assert(!outcome.ok, () => ({
            message: `seat ${String(seat.seatId)} could still act after getResult() went non-null`,
            where: where0,
            detail: preview(lastStep.action, 160),
          }))
          recorder.assert(stableStringify(finalState) === finalStateText, () => ({
            message: 'state changed while rejecting an action after the match ended',
            where: where0,
          }))
        }
      }
    }
  }

  return recorder
}

/**
 * Every distinct action the game produced anywhere in a playout: the moves it
 * actually played, plus everything `getLegalActions` offered at the opening
 * position. That is a well-typed corpus of real actions, which is what makes
 * the "illegal here" probe meaningful — random junk is already covered by the
 * schema battery.
 */
function actionPool<TAction>(play: {
  readonly steps: readonly { readonly action: TAction }[]
}): readonly TAction[] {
  const seen = new Map<string, TAction>()
  for (const step of play.steps) {
    const key = stableStringify(step.action)
    if (!seen.has(key)) seen.set(key, step.action)
  }
  return [...seen.values()]
}

function notLegalHere<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(
  pool: readonly TAction[],
  state: TState,
  seatId: SeatId,
  getLegalActions: ((state: TState, seatId: SeatId) => readonly TAction[]) | undefined,
  prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>,
): readonly TAction[] {
  if (getLegalActions === undefined) return []
  const legal = new Set(
    prep.guard(() => getLegalActions(state, seatId)).map((action) => stableStringify(action)),
  )
  return pool.filter((action) => !legal.has(stableStringify(action)))
}

export function checkLegalActionsAgree<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>): CheckRecorder {
  const recorder = new CheckRecorder(
    'legal-actions-agree',
    'getLegalActions agrees with validateAction in both directions',
  )
  const { server } = prep.subject
  const getLegalActions = server.getLegalActions?.bind(server)
  if (getLegalActions === undefined) {
    recorder.skip(
      'the game does not implement getLegalActions; move hints, bot seats and conformance playouts are unavailable',
    )
    return recorder
  }

  const runs = healthyRuns(prep.runs)
  if (runs.length === 0) {
    recorder.skip('no playout completed')
    return recorder
  }

  const probeActions = prep.subject.probeActions ?? []
  if (probeActions.length === 0) {
    recorder.note(
      'no probeActions declared, so the reverse direction is limited to actions getLegalActions itself offered; an action category it omits everywhere cannot be detected',
    )
  }

  // ADR-0012. The perturbation corpus is built relative to each position from
  // the actions the game offered *there*, so unlike `probeActions` it does not
  // need a playout to wander anywhere in particular.
  const plan = planPerturbations(server.actionSchema, prep.subject.actionPerturbations)
  let forwardCorpus = 0
  let perturbedCorpus = 0
  /**
   * Perturbations that survived the `listedKeys` skip and so reached
   * `validateAction`. Separate from the corpus size because they answer
   * different questions: the corpus is what ADR-0012's cost law counts, and
   * this is what the direction actually asserted. A corpus every member of
   * which `getLegalActions` already offers is a game that enumerates every
   * spelling — a pass, not a gap.
   */
  let perturbedAsserted = 0
  const probesByPath = new Map<string, number>()
  for (const field of plan.fields) probesByPath.set(field.path, 0)

  for (const run of runs.slice(0, 12)) {
    const where0 = `${run.scenario.label} seed=${String(run.context.seed)}`
    const states = [run.playout.initial.state, ...run.playout.steps.map((step) => step.after)]

    for (const [index, state] of sampleIndexed(states, 6)) {
      const ctx = contextAt(run.context, index)
      for (const seat of run.scenario.roster) {
        const listed = prep.guard(() => getLegalActions(state, seat.seatId))
        const listedKeys = new Set(listed.map((action) => stableStringify(action)))

        // Forward: everything listed must validate.
        forwardCorpus += listed.length
        for (const action of listed) {
          const outcome = prep.guard(() => server.validateAction(ctx, state, seat.seatId, action))
          recorder.assert(outcome.ok, () => ({
            message: `getLegalActions offered an action that validateAction rejects with '${outcome.ok ? '' : outcome.error.code}'`,
            where: `${where0} step=${index} seat=${String(seat.seatId)}`,
            detail: preview(action, 160),
          }))
        }

        // Reverse: an action that validates must be listed. Probed with the
        // other seats' legal actions plus the subject's declared
        // `probeActions`, which is where a "forgot to include resign" bug
        // actually shows up.
        const reverseCorpus: TAction[] = [...probeActions]
        for (const other of run.scenario.roster) {
          if (other.seatId === seat.seatId) continue
          reverseCorpus.push(...prep.guard(() => getLegalActions(state, other.seatId)))
        }

        // …and with perturbations of this seat's own offered actions, which is
        // the only source that can contain a spelling `getLegalActions` omits
        // everywhere. The *parsed* value goes into the corpus, because the
        // contract is about the action after `actionSchema`, and a perturbation
        // the schema rejects never reaches the game at all.
        for (const action of listed) {
          for (const field of plan.fields) {
            const candidate = perturb(action, field)
            if (!candidate.ok) continue
            const parsed = server.actionSchema.safeParse(candidate.value)
            if (!parsed.success) continue
            reverseCorpus.push(parsed.data)
            perturbedCorpus += 1
            if (!listedKeys.has(stableStringify(parsed.data))) perturbedAsserted += 1
            probesByPath.set(field.path, (probesByPath.get(field.path) ?? 0) + 1)
          }
        }

        for (const action of reverseCorpus) {
          if (listedKeys.has(stableStringify(action))) continue
          const outcome = prep.guard(() => server.validateAction(ctx, state, seat.seatId, action))
          recorder.assert(!outcome.ok, () => ({
            message: `validateAction accepts an action that getLegalActions does not list for seat ${String(seat.seatId)}`,
            where: `${where0} step=${index}`,
            detail: preview(action, 160),
          }))
        }
      }
    }
  }

  reportPerturbationCoverage(recorder, plan, {
    forwardCorpus,
    perturbedCorpus,
    perturbedAsserted,
    probesByPath,
  })

  return recorder
}

interface PerturbationTally {
  readonly forwardCorpus: number
  readonly perturbedCorpus: number
  readonly perturbedAsserted: number
  readonly probesByPath: ReadonlyMap<string, number>
}

/**
 * Says what the perturbation direction actually did.
 *
 * This is the condition ADR-0012's approval rests on. A direction that
 * generates zero probes and reports a pass reproduces the `passWithNoTests`
 * failure mode on a check whose entire purpose is to stop a silent pass, so a
 * green run has to be distinguishable from a run that never happened. Only the
 * `covered:` line claims coverage, and it is emitted only when probes were
 * actually generated.
 */
function reportPerturbationCoverage(
  recorder: CheckRecorder,
  plan: PerturbationPlan,
  tally: PerturbationTally,
): void {
  const PREFIX = '`accepted ⊆ offered` perturbation direction'
  const { forwardCorpus, perturbedCorpus, perturbedAsserted, probesByPath } = tally

  for (const gap of plan.gaps) {
    recorder.note(
      `${PREFIX} NOT covered for ${gap.subject}: the schema introspector cannot read ${gap.reason}; declare it in actionPerturbations on the conformance subject so the direction runs (ADR-0012)`,
    )
  }

  const paths = [...probesByPath.keys()]
  if (plan.fields.length === 0) {
    if (plan.gaps.length === 0) {
      recorder.note(
        `${PREFIX} has nothing to cover: actionSchema declares no optional field, so there is no tolerated-field spelling to probe`,
      )
    }
  } else if (perturbedCorpus === 0) {
    recorder.note(
      `${PREFIX} NOT covered: ${String(plan.fields.length)} perturbation(s) over field(s) ${paths.join(', ')} produced 0 surviving probes — every candidate was either already carried by the offered action or rejected by actionSchema, so the direction did not run`,
    )
  } else {
    const breakdown = paths.map((path) => `${path}=${String(probesByPath.get(path) ?? 0)}`)
    const reached =
      perturbedAsserted === 0
        ? 'none of which needed asserting: getLegalActions already offers every one of them'
        : `${String(perturbedAsserted)} of which reached validateAction`
    recorder.note(
      `${PREFIX} covered: ${String(perturbedCorpus)} probes from ${String(plan.fields.length)} perturbation(s) over field(s) ${breakdown.join(', ')}, ${reached}`,
    )
  }

  // The number ADR-0012 pins, in the format its evidence section uses, plus the
  // `validateAction` calls the direction actually added.
  //
  // The law is `perturbed <= forward × fields`, with equality when no offered
  // action already carries the field and the schema accepts every
  // representative value. A ratio below 1 is informative rather than wrong:
  // chess's real promotions already carry `promotion`, so they contribute no
  // probe, and a regex-constrained string rejects the sampler's placeholder.
  const ceiling = forwardCorpus * plan.fields.length
  const ratio = ceiling === 0 ? 'n/a' : (perturbedCorpus / ceiling).toFixed(3)
  recorder.note(
    `[cost law] fields=${String(plan.fields.length)} forward=${String(forwardCorpus)} perturbed=${String(perturbedCorpus)} asserted=${String(perturbedAsserted)} ratio=${ratio}`,
  )
}

function sampleSteps<T>(items: readonly T[], count: number): readonly T[] {
  if (items.length <= count) return items
  const stride = Math.max(1, Math.floor(items.length / count))
  const picked: T[] = []
  for (let i = 0; i < items.length && picked.length < count; i += stride) {
    const item = items[i]
    if (item !== undefined) picked.push(item)
  }
  return picked
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
