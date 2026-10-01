/**
 * The fake room runner.
 *
 * This is the smallest thing that can host a turn-based game: it builds
 * contexts, holds the seat roster, plays actions and stops when `getResult`
 * goes non-null. It deliberately mirrors the real runner's call order (see
 * `turn-based.ts` in the SDK) so that a game which passes conformance is
 * actually being exercised the way `apps/realtime` will exercise it.
 *
 * It owns no clock and no randomness of its own beyond a seeded `Rng`, so a
 * playout is a pure function of `(subject, settings, roster, seed)`.
 */

import {
  type ApplyResult,
  type GameContext,
  type GameEvent,
  type MatchResult,
  type MatchSeed,
  type Rng,
  type Seat,
  type SeatId,
  type SeatRoster,
  type TimerCommand,
  type TimerId,
  type ValidationResult,
  asGameId,
  asMatchId,
  asMatchSeed,
  asPlayerId,
  asSeatId,
  asTeamId,
  createGameContext,
  createRng,
  deriveSeed,
} from '@playhall/game-sdk'
import { withoutAmbientSources } from './ambient.js'
import { TimerQueue } from './timer-queue.js'
import { detachedClone } from './value.js'
import type { ActionCandidate } from '../subject.js'

export const FAKE_MATCH_ID = asMatchId('conformance-match')

/**
 * The copy a mutating call gets, so the driver's own record of the state
 * cannot be rewritten behind its back.
 *
 * Without this, `step.before` is the very object the playout passed to
 * `applyAction`, so an `applyAction` that writes onto its input has already
 * edited the driver's log entry by the time a check reads it. Every purity
 * baseline is then taken from a polluted state, and the one class of mutation
 * that matters most — memoising a computed value, `state.cache = analyse(…)`,
 * which writes the *same* value every call — compares equal and passes
 * (PER-269). Recording the pristine value is what turns "does a second
 * application change anything?" back into "did the reducer mutate its input?".
 *
 * Only the calls the contract requires to be pure go through this:
 * `applyAction`, `validateAction` and `onTimer`. `getResult` and
 * `getLegalActions` keep the retained object, because no check claims they are
 * pure and cloning on every loop iteration would buy nothing.
 *
 * A state `structuredClone` cannot copy (a function, a symbol) falls back to
 * the retained object rather than throwing: that state fails
 * `serialization-round-trip` on its own terms, and a driver crash there would
 * be reported as "the game threw during a playout", which is the wrong
 * attribution.
 *
 * Exported because a *check* that calls one of those three functions has the
 * same obligation as the driver: `illegal-action-rejected` calls
 * `validateAction` many times per step, and a raw `step.before` there rewrites
 * the driver's log entry for every check that runs afterwards (PER-278). The
 * fallback matters more in a check than in the driver — a `structuredClone`
 * failure must not turn a rejection probe into a thrown-error report.
 */
export function handOver<T>(state: T): T {
  try {
    return detachedClone(state)
  } catch {
    return state
  }
}

export interface ClockOptions {
  readonly startNow: number
  readonly nowStepMs: number
}

export const DEFAULT_CLOCK: ClockOptions = { startNow: 1_700_000_000_000, nowStepMs: 1_000 }

export interface ContextOptions extends ClockOptions {
  readonly gameId: string
  readonly gameVersion: string
  readonly sdkContractVersion: number
  readonly seed: MatchSeed
}

/**
 * The single place a context is built for a conformance run. `now` is derived
 * from `sequence`, so two runs of the same action log see the same clock and
 * a game that reads `ctx.now` is still deterministic.
 *
 * `advanceMs` pushes `now` forward for **this one context** without touching
 * the step size. It exists so a single dispatch can land past a deadline the
 * step counter would never reach (see `AbortScenario.advanceMs`); it is a
 * declared constant, so `now` stays a pure function of its arguments.
 */
export function contextAt(options: ContextOptions, sequence: number, advanceMs = 0): GameContext {
  return createGameContext({
    matchId: FAKE_MATCH_ID,
    gameId: asGameId(options.gameId),
    gameVersion: options.gameVersion,
    sdkContractVersion: options.sdkContractVersion,
    now: options.startNow + sequence * options.nowStepMs + advanceMs,
    seed: options.seed,
    sequence,
  })
}

/** A roster of filled human seats. Teams alternate when the manifest has them. */
export function buildDefaultRoster(playerCount: number, teamed: boolean): SeatRoster {
  return Array.from({ length: playerCount }, (_unused, index): Seat => {
    const seatId = asSeatId(`seat-${index + 1}`)
    return {
      seatId,
      index,
      teamId: teamed ? asTeamId(index % 2 === 0 ? 'team-a' : 'team-b') : null,
      occupant: {
        playerId: asPlayerId(`player-${index + 1}`),
        displayName: `Player ${index + 1}`,
        isBot: false,
      },
    }
  })
}

/** A seat id that is guaranteed not to be in the roster. */
export function outsiderSeatId(roster: SeatRoster): SeatId {
  const taken = new Set(roster.map((seat) => String(seat.seatId)))
  let candidate = 'seat-not-in-this-match'
  let suffix = 0
  while (taken.has(candidate)) {
    suffix += 1
    candidate = `seat-not-in-this-match-${suffix}`
  }
  return asSeatId(candidate)
}

export interface PlayoutStep<TState, TAction, TEvent extends GameEvent> {
  /** The `ctx.sequence` this mutation ran at. */
  readonly sequence: number
  readonly seatId: SeatId
  readonly action: TAction
  /**
   * The state as the platform handed it over, not the object the game was
   * handed. `handOver` below is what makes those two different things, and
   * why `before` is still pristine after an impure reducer has run.
   */
  readonly before: TState
  readonly after: TState
  readonly events: readonly TEvent[]
  readonly timers: readonly TimerCommand[]
}

export interface Playout<TState, TAction, TEvent extends GameEvent> {
  readonly seed: MatchSeed
  readonly variantLabel: string
  readonly playerCount: number
  readonly roster: SeatRoster
  readonly initial: ApplyResult<TState, TEvent>
  readonly steps: readonly PlayoutStep<TState, TAction, TEvent>[]
  readonly finalState: TState
  readonly result: MatchResult | null
  /** True when the step budget ran out before `getResult` went non-null. */
  readonly truncated: boolean
  /** Set when the driver could not pick a move even though the match was live. */
  readonly stalledAt: number | null
}

/** Every state the playout passed through, oldest first. */
export function statesOf<TState, TAction, TEvent extends GameEvent>(
  playout: Playout<TState, TAction, TEvent>,
): readonly TState[] {
  return [playout.initial.state, ...playout.steps.map((step) => step.after)]
}

/**
 * Minimal surface the driver needs. Narrower than `TurnBasedGameServer` on
 * purpose: the checks pass mutated copies of a server in, and a narrow type
 * keeps that honest.
 */
export interface DriverServer<TState, TAction, TSettings, TEvent extends GameEvent> {
  createInitialState(
    ctx: GameContext,
    settings: TSettings,
    seats: SeatRoster,
  ): ApplyResult<TState, TEvent>
  /**
   * `ValidationResult<string>` rather than `{ ok: boolean }`: a rejection's
   * `code` is the only thing that tells a game author *why* the runner would
   * have refused their action, so the driver has to be able to read it.
   */
  validateAction(
    ctx: GameContext,
    state: TState,
    seatId: SeatId,
    action: TAction,
  ): ValidationResult<string>
  applyAction(
    ctx: GameContext,
    state: TState,
    seatId: SeatId,
    action: TAction,
  ): ApplyResult<TState, TEvent>
  getLegalActions?(state: TState, seatId: SeatId): readonly TAction[]
  /**
   * Optional, like the contract. The driver only ever calls it for a timer the
   * game's own commands armed — see `timerAbortRun`.
   */
  onTimer?(
    ctx: GameContext,
    state: TState,
    timerId: TimerId,
    seatId: SeatId | null,
  ): ApplyResult<TState, TEvent>
  getResult(state: TState): MatchResult | null
}

export type ActionChooser<TState, TAction> = (
  state: TState,
  candidates: readonly ActionCandidate<TAction>[],
  rng: Rng,
) => { readonly seatId: SeatId; readonly action: TAction } | null

/**
 * Uniform pick among the actions of the seat with the most options.
 *
 * In a sequential game that is the seat to move: an off-turn seat in chess or
 * tic-tac-toe can usually only resign, so picking across all seats uniformly
 * would end most playouts on move one and leave the rules untested.
 */
export function defaultChooseAction<TState, TAction>(
  _state: TState,
  candidates: readonly ActionCandidate<TAction>[],
  rng: Rng,
): { readonly seatId: SeatId; readonly action: TAction } | null {
  let best: ActionCandidate<TAction> | null = null
  for (const candidate of candidates) {
    if (candidate.actions.length === 0) continue
    if (best === null || candidate.actions.length > best.actions.length) best = candidate
  }
  if (best === null) return null
  return { seatId: best.seatId, action: rng.pick(best.actions) }
}

export interface PlayoutOptions<TState, TAction, TSettings, TEvent extends GameEvent> {
  readonly server: DriverServer<TState, TAction, TSettings, TEvent>
  readonly settings: TSettings
  readonly variantLabel: string
  readonly roster: SeatRoster
  readonly context: ContextOptions
  readonly maxSteps: number
  readonly chooseAction: ActionChooser<TState, TAction>
  /** Trap ambient clock/randomness while game code runs. */
  readonly trapAmbient: boolean
}

/**
 * Plays one match to completion (or to the step budget).
 *
 * Throws only if the game itself throws — a game that throws where the
 * contract says to return a typed rejection is a conformance failure, and the
 * caller turns the exception into one.
 */
export function playout<TState, TAction, TSettings, TEvent extends GameEvent>(
  options: PlayoutOptions<TState, TAction, TSettings, TEvent>,
): Playout<TState, TAction, TEvent> {
  const { server, roster, context, maxSteps } = options
  const run = <T>(body: () => T): T => (options.trapAmbient ? withoutAmbientSources(body) : body())

  const initial = run(() =>
    server.createInitialState(contextAt(context, 0), options.settings, roster),
  )

  const driverRng = createRng(deriveSeed(String(context.seed), 'conformance-driver'))
  const steps: PlayoutStep<TState, TAction, TEvent>[] = []
  let state = initial.state
  let sequence = 1
  let truncated = false
  let stalledAt: number | null = null

  for (;;) {
    if (run(() => server.getResult(state)) !== null) break
    if (steps.length >= maxSteps) {
      truncated = true
      break
    }

    const candidates: ActionCandidate<TAction>[] = []
    const getLegalActions = server.getLegalActions?.bind(server)
    if (getLegalActions === undefined) {
      stalledAt = sequence
      break
    }
    for (const seat of roster) {
      const current = state
      const actions = run(() => getLegalActions(current, seat.seatId))
      if (actions.length > 0) candidates.push({ seatId: seat.seatId, actions })
    }

    const chosen = options.chooseAction(state, candidates, driverRng)
    if (chosen === null) {
      stalledAt = sequence
      break
    }

    const ctx = contextAt(context, sequence)
    const before = state
    const applied = run(() =>
      server.applyAction(ctx, handOver(before), chosen.seatId, chosen.action),
    )
    steps.push({
      sequence,
      seatId: chosen.seatId,
      action: chosen.action,
      before,
      after: applied.state,
      events: applied.events,
      timers: applied.timers ?? [],
    })
    state = applied.state
    sequence += 1
  }

  return {
    seed: context.seed,
    variantLabel: options.variantLabel,
    playerCount: roster.length,
    roster,
    initial,
    steps,
    finalState: state,
    result: run(() => server.getResult(state)),
    truncated,
    stalledAt,
  }
}

export interface AbortRunOptions<
  TState,
  TAction,
  TSettings,
  TEvent extends GameEvent,
> extends PlayoutOptions<TState, TAction, TSettings, TEvent> {
  /** Normal moves to play before the abort action. */
  readonly afterSteps: number
  /**
   * `manifest.timers` ids. A `set` outside this list fails the scenario — the
   * platform would drop it, so a game relying on it is broken in production
   * whichever arm the scenario uses.
   */
  readonly declaredTimerIds: readonly string[]
  /**
   * Milliseconds added to `ctx.now` for the abort dispatch only. The
   * `afterSteps` plies before it keep the subject's `nowStepMs` clock, so a
   * deadline-gated abort becomes reachable without stretching the playout.
   */
  readonly advanceMs?: number
  /** The action that ends the match without recording a result. */
  abortAction(
    state: TState,
    roster: SeatRoster,
  ): { readonly seatId: SeatId; readonly action: TAction } | null
}

export interface AbortRun<TState> {
  readonly state: TState
  readonly result: MatchResult | null
  /** Normal moves actually played before the abort was attempted. */
  readonly stepsPlayed: number
  /**
   * The `ctx.now` the abort was dispatched at, or `null` if it never ran. A
   * deadline-gated abort that silently did nothing is indistinguishable from a
   * broken abort action without this number.
   */
  readonly abortNow: number | null
  /**
   * Why the abort never happened, or `null` if it did. A scenario that cannot
   * reach its own abort is a hole in the gate, not a pass, so the caller
   * reports this rather than skipping.
   */
  readonly unreachable: string | null
}

/**
 * Plays `afterSteps` normal moves and then the game's own abort action.
 *
 * The suite needs a match that ends with no recorded result, and random
 * playouts never produce one — they only reach endings the rules arrive at on
 * their own. This is the smallest driver that gets there while still going
 * through `applyAction` like the real runner, so the abort is exercised as a
 * game action rather than as a state the test hand-builds.
 */
/**
 * The part both abort arms share: build the opening state, play `afterSteps`
 * ordinary moves, and feed every `ApplyResult.timers` the game returned into a
 * queue.
 *
 * Collecting those commands is what ADR-0010 changed here. The driver used to
 * take `createInitialState(...).state` and drop the rest of the `ApplyResult`,
 * so the harness was already carrying the data a timer-driven ending needs and
 * throwing it away.
 */
interface Prologue<TState> {
  readonly state: TState
  /** `ctx.sequence` the next mutation should use. */
  readonly sequence: number
  /** `ctx.now` of the last mutation that ran. */
  readonly now: number
  readonly stepsPlayed: number
  readonly queue: TimerQueue
  /** Set when the scenario cannot proceed; the caller turns it into a failure. */
  readonly unreachable: string | null
  readonly result: MatchResult | null
}

function runPrologue<TState, TAction, TSettings, TEvent extends GameEvent>(
  options: AbortRunOptions<TState, TAction, TSettings, TEvent>,
  seedTag: string,
): Prologue<TState> {
  const { server, roster, context } = options
  const run = <T>(body: () => T): T => (options.trapAmbient ? withoutAmbientSources(body) : body())
  const queue = new TimerQueue(options.declaredTimerIds)

  const openingCtx = contextAt(context, 0)
  const initial = run(() => server.createInitialState(openingCtx, options.settings, roster))
  let state = initial.state
  let now = openingCtx.now

  try {
    queue.apply(initial.timers ?? [], openingCtx.now)
  } catch (error) {
    return {
      state,
      sequence: 1,
      now,
      stepsPlayed: 0,
      queue,
      result: null,
      unreachable: error instanceof Error ? error.message : String(error),
    }
  }

  const driverRng = createRng(deriveSeed(String(context.seed), seedTag))
  const getLegalActions = server.getLegalActions?.bind(server)

  let sequence = 1
  let stepsPlayed = 0
  while (stepsPlayed < options.afterSteps) {
    if (run(() => server.getResult(state)) !== null) break
    if (getLegalActions === undefined) break

    const candidates: ActionCandidate<TAction>[] = []
    for (const seat of roster) {
      const current = state
      const actions = run(() => getLegalActions(current, seat.seatId))
      if (actions.length > 0) candidates.push({ seatId: seat.seatId, actions })
    }
    const chosen = options.chooseAction(state, candidates, driverRng)
    if (chosen === null) break

    const ctx = contextAt(context, sequence)
    const before = state
    const applied = run(() =>
      server.applyAction(ctx, handOver(before), chosen.seatId, chosen.action),
    )
    state = applied.state
    now = ctx.now
    sequence += 1
    stepsPlayed += 1
    try {
      queue.apply(applied.timers ?? [], ctx.now)
    } catch (error) {
      return {
        state,
        sequence,
        now,
        stepsPlayed,
        queue,
        result: null,
        unreachable: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const early = run(() => server.getResult(state))
  if (early !== null) {
    return {
      state,
      sequence,
      now,
      stepsPlayed,
      queue,
      result: early,
      unreachable: `the match was already over after ${String(stepsPlayed)} of the requested ${String(options.afterSteps)} moves`,
    }
  }

  // The undershoot direction. The loop above also stops when the game has no
  // `getLegalActions` (it is optional) or when `chooseAction` declines, and an
  // abort from move 0 is not the abort a scenario asking for `afterSteps` moves
  // declared — `afterSteps` is exactly what separates "abort is legal here"
  // from "abort is legal somewhere else".
  if (stepsPlayed < options.afterSteps) {
    return {
      state,
      sequence,
      now,
      stepsPlayed,
      queue,
      result: null,
      unreachable: `played ${String(stepsPlayed)} of the requested ${String(options.afterSteps)} moves before the driver ran out of moves`,
    }
  }

  return { state, sequence, now, stepsPlayed, queue, result: null, unreachable: null }
}

export function abortRun<TState, TAction, TSettings, TEvent extends GameEvent>(
  options: AbortRunOptions<TState, TAction, TSettings, TEvent>,
): AbortRun<TState> {
  const { server, roster, context } = options
  const run = <T>(body: () => T): T => (options.trapAmbient ? withoutAmbientSources(body) : body())

  const prologue = runPrologue(options, 'conformance-abort')
  let state = prologue.state
  const { sequence, stepsPlayed } = prologue
  if (prologue.unreachable !== null) {
    return {
      state,
      result: prologue.result,
      stepsPlayed,
      abortNow: null,
      unreachable: prologue.unreachable,
    }
  }

  const chosen = run(() => options.abortAction(state, roster))
  if (chosen === null) {
    return {
      state,
      result: null,
      stepsPlayed,
      abortNow: null,
      unreachable: `abortAction returned null after ${String(stepsPlayed)} moves`,
    }
  }

  // The one dispatch the scenario's `advanceMs` applies to. Everything above
  // ran on the plain step clock, which is the whole point of scoping it here.
  // Validate and apply share it, because the real runner does both at one
  // instant and a deadline-gated abort reads that instant.
  const ctx = contextAt(context, sequence, options.advanceMs ?? 0)

  // The abort is deliberately outside `getLegalActions`, so it is the one
  // action in the suite that no other check cross-references against
  // `validateAction`. The real runner validates before it applies, and it is
  // this call that keeps the driver on the runner's call sequence: without it
  // a game can ship green conformance and an abort production refuses.
  let verdict: ValidationResult<string>
  try {
    verdict = run(() => server.validateAction(ctx, handOver(state), chosen.seatId, chosen.action))
  } catch (error) {
    return {
      state,
      result: null,
      stepsPlayed,
      abortNow: ctx.now,
      unreachable: `validateAction threw on the abort action instead of returning a typed rejection: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!verdict.ok) {
    return {
      state,
      result: null,
      stepsPlayed,
      abortNow: ctx.now,
      unreachable: `the game's own validateAction rejected the abort action with '${verdict.error.code}' at ctx.now=${String(ctx.now)} (${String(options.advanceMs ?? 0)} ms of declared advanceMs); an abort that only opens after a deadline needs AbortScenario.advanceMs`,
    }
  }

  const before = state
  const applied = run(() => server.applyAction(ctx, handOver(before), chosen.seatId, chosen.action))
  state = applied.state
  try {
    // Nothing fires after an abort, but a `set` for an id the manifest never
    // declared is a bug in either arm and the platform would drop it.
    prologue.queue.apply(applied.timers ?? [], ctx.now)
  } catch (error) {
    return {
      state,
      result: run(() => server.getResult(state)),
      stepsPlayed,
      abortNow: ctx.now,
      unreachable: error instanceof Error ? error.message : String(error),
    }
  }

  return {
    state,
    result: run(() => server.getResult(state)),
    stepsPlayed,
    abortNow: ctx.now,
    unreachable: null,
  }
}

/** One expiry the driver delivered, for the report and for failure messages. */
export interface TimerFire {
  readonly timerId: TimerId
  /** From the `set` command the game emitted, never from the scenario. */
  readonly seatId: SeatId | null
  /** `ctx.now` of the emitting call plus its `delayMs`. */
  readonly deadline: number
  /** `max(deadline, now of the previous mutation)` — the clock `onTimer` saw. */
  readonly now: number
  readonly sequence: number
}

export interface TimerAbortRunOptions<
  TState,
  TAction,
  TSettings,
  TEvent extends GameEvent,
> extends Omit<AbortRunOptions<TState, TAction, TSettings, TEvent>, 'abortAction' | 'advanceMs'> {
  /** The expiry the scenario declared. Must be in `declaredTimerIds`. */
  readonly timerId: TimerId
  /** Fires to allow before giving up. */
  readonly maxFires: number
}

export interface TimerAbortRun<TState> {
  readonly state: TState
  readonly result: MatchResult | null
  readonly stepsPlayed: number
  /** Every expiry delivered, oldest first. Empty when none came due. */
  readonly fires: readonly TimerFire[]
  /** `ctx.now` of the declared timer's fire, or `null` if it never fired. */
  readonly abortNow: number | null
  readonly unreachable: string | null
}

/**
 * Plays `afterSteps` normal moves and then fires the game's own timers until
 * the declared one expires (ADR-0010).
 *
 * The driver never synthesises an `onTimer` call. Every expiry here traces back
 * to a `setTimer` the game returned from `createInitialState` or `applyAction`,
 * which is the whole point: a game that declares a `trigger: 'timer'` scenario
 * for a timer it never arms fails, rather than certifying an ending the
 * platform can never reach.
 *
 * **The clock.** A fire runs at `max(deadline, now of the previous mutation)`
 * and the resulting offset is carried forward for the rest of the scenario, so
 * a later sequence cannot rewind behind a fire that jumped the clock forward.
 * `max(...)` rather than the real service's `dueAtMs`: under load `dueAtMs` can
 * be behind the last action's `ctx.now`, and a harness that could rewind the
 * clock would make a failure depend on a jitter value no fixture can pin.
 * Inside a conformance run the two coincide — the harness is never late.
 */
export function timerAbortRun<TState, TAction, TSettings, TEvent extends GameEvent>(
  options: TimerAbortRunOptions<TState, TAction, TSettings, TEvent>,
): TimerAbortRun<TState> {
  const { server, context } = options
  const run = <T>(body: () => T): T => (options.trapAmbient ? withoutAmbientSources(body) : body())
  const wanted = String(options.timerId)

  const prologue = runPrologue({ ...options, abortAction: () => null }, 'conformance-timer-abort')
  let state = prologue.state
  const { queue, stepsPlayed } = prologue
  const fires: TimerFire[] = []

  const stop = (unreachable: string | null, abortNow: number | null): TimerAbortRun<TState> => ({
    state,
    result: run(() => server.getResult(state)),
    stepsPlayed,
    fires,
    abortNow,
    unreachable,
  })

  if (prologue.unreachable !== null) return stop(prologue.unreachable, null)

  const onTimer = server.onTimer?.bind(server)
  if (onTimer === undefined) {
    // A declared ending the game cannot produce. ADR-0010 §5: a failure, not a
    // skip — same rule as an `abortAction` that returns `null`.
    return stop(
      `the game has no onTimer, so the declared timer '${wanted}' can never end a match`,
      null,
    )
  }

  if (!queue.wasEverArmed(options.timerId)) {
    // The bug ADR-0010 §1 exists to reject. A harness that called `onTimer`
    // directly would go green here on an ending production can never reach.
    return stop(
      `the timer '${wanted}' was never armed: the game returned no setTimer('${wanted}', …) from createInitialState or the ${String(stepsPlayed)} move(s) before the fire, so this ending is unreachable in production (armed instead: ${queue.describe()})`,
      null,
    )
  }

  let sequence = prologue.sequence
  let previousNow = prologue.now
  // Carried, not per-dispatch. `advanceMs` can be per-dispatch because the
  // abort action is the last thing that happens; a timer fire is not.
  let carriedOffset = 0

  for (let fired = 0; fired < options.maxFires; fired += 1) {
    if (run(() => server.getResult(state)) !== null) break

    const due = queue.takeNext()
    if (due === null) break

    const now = Math.max(due.deadline, previousNow)
    carriedOffset = now - (context.startNow + sequence * context.nowStepMs)
    const ctx = contextAt(context, sequence, carriedOffset)

    let applied: ApplyResult<TState, TEvent>
    try {
      applied = run(() => onTimer(ctx, handOver(state), due.timerId, due.seatId))
    } catch (error) {
      return stop(
        `the game threw from onTimer('${String(due.timerId)}') at ctx.now=${String(ctx.now)} instead of returning an ApplyResult: ${error instanceof Error ? error.message : String(error)}`,
        null,
      )
    }

    state = applied.state
    fires.push({
      timerId: due.timerId,
      seatId: due.seatId,
      deadline: due.deadline,
      now: ctx.now,
      sequence,
    })
    previousNow = ctx.now
    sequence += 1

    try {
      // `onTimer`'s own commands are applied, so a fire may re-arm or clear.
      queue.apply(applied.timers ?? [], ctx.now)
    } catch (error) {
      return stop(error instanceof Error ? error.message : String(error), null)
    }

    if (String(due.timerId) === wanted) return stop(null, ctx.now)
  }

  const observed =
    fires.length === 0
      ? 'nothing fired'
      : `fired: ${fires.map((fire) => `${String(fire.timerId)}@${String(fire.now)}`).join(', ')}`

  const ended = run(() => server.getResult(state))
  if (ended !== null) {
    const last = fires.at(-1)
    return stop(
      last === undefined
        ? `the match ended before the declared timer '${wanted}' could fire (${observed})`
        : `the match ended on '${String(last.timerId)}' before the declared '${wanted}' fired (${observed})`,
      null,
    )
  }

  if (fires.length >= options.maxFires) {
    return stop(
      `the budget of ${String(options.maxFires)} fire(s) was spent before '${wanted}' fired (${observed}); raise TimerAbortScenario.maxFires if the ending is at the end of a cascade`,
      null,
    )
  }

  return stop(
    `the declared timer '${wanted}' was armed but never came due — it was cleared or paused before it could fire (${observed}; still armed: ${queue.describe()})`,
    null,
  )
}

/**
 * Replays a recorded action log against the same contexts, without consulting
 * `getLegalActions`. This is what the platform does when it rebuilds a match
 * from the match log after a restart, and it is how the determinism check
 * proves that the log alone is enough.
 */
export function replay<TState, TAction, TSettings, TEvent extends GameEvent>(
  server: DriverServer<TState, TAction, TSettings, TEvent>,
  settings: TSettings,
  roster: SeatRoster,
  context: ContextOptions,
  log: readonly { readonly sequence: number; readonly seatId: SeatId; readonly action: TAction }[],
  trapAmbient: boolean,
  from?: { readonly state: TState; readonly fromSequence: number },
): { readonly states: readonly TState[]; readonly events: readonly (readonly TEvent[])[] } {
  const run = <T>(body: () => T): T => (trapAmbient ? withoutAmbientSources(body) : body())

  const states: TState[] = []
  const events: (readonly TEvent[])[] = []

  let state: TState
  if (from === undefined) {
    const initial = run(() => server.createInitialState(contextAt(context, 0), settings, roster))
    state = initial.state
    states.push(state)
    events.push(initial.events)
  } else {
    state = from.state
    states.push(state)
    events.push([])
  }

  for (const entry of log) {
    if (from !== undefined && entry.sequence < from.fromSequence) continue
    const ctx = contextAt(context, entry.sequence)
    const current = state
    const applied = run(() =>
      server.applyAction(ctx, handOver(current), entry.seatId, entry.action),
    )
    state = applied.state
    states.push(state)
    events.push(applied.events)
  }

  return { states, events }
}

export function seedFor(base: string, ...parts: readonly (string | number)[]): MatchSeed {
  return asMatchSeed(deriveSeed(base, ...parts))
}
