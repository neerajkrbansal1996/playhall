/**
 * The turn-based server contract.
 *
 * A turn-based game is a reducer. The room runner owns the socket, the clock,
 * the seats, the match log and persistence; the game owns the rules. The runner
 * calls these functions and nothing else.
 *
 * Call order for one player action:
 *
 *   1. runner parses the payload with `actionSchema` — a game never sees an
 *      unvalidated action, so `applyAction` may trust the shape of `action`;
 *   2. runner calls `validateAction`; a rejection is returned to that one
 *      client and the state is untouched;
 *   3. runner calls `applyAction`, persists `{ state, events }` to the match
 *      log, and applies any returned `timers`;
 *   4. runner fans out, building each recipient's payload with `getViewFor`
 *      and filtering events by `audience`;
 *   5. runner calls `getResult`; non-null ends the match.
 *
 * Steps 2 and 3 are separate on purpose. `getLegalActions` and the client's
 * optimistic move preview need to ask "is this legal?" without producing a
 * state, and a runner that only had `applyAction` would have to apply and
 * discard — which is wrong the moment a game consumes `ctx.rng`.
 */

import type { z } from 'zod'
import type { GameContext } from './context.js'
import type { DisconnectPolicy, DisconnectReason } from './disconnect.js'
import type {
  ActionError,
  MigrationError,
  Result,
  StandardActionErrorCode,
  ValidationResult,
} from './errors.js'
import type { GameEvent } from './events.js'
import type { SeatId, TimerId } from './ids.js'
import type { GameManifest } from './manifest.js'
import type { MatchRecord } from './record.js'
import type { MatchResult } from './result.js'
import type { SeatRoster } from './seats.js'
import type { TimerCommand } from './timers.js'
import type { Viewer } from './viewer.js'

/**
 * The result of any state mutation.
 *
 * `timers` is part of the return value rather than something the game calls,
 * so the whole function stays pure and replayable. See `timers.ts`.
 */
export interface ApplyResult<TState, TEvent extends GameEvent = GameEvent> {
  readonly state: TState
  readonly events: readonly TEvent[]
  readonly timers?: readonly TimerCommand[]
}

export interface TurnBasedGameServer<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent = GameEvent,
  TErrorCode extends string = StandardActionErrorCode,
> {
  /**
   * Validated by the platform before the game sees an action. Keep it tight —
   * this is the outer wall against a modified client.
   *
   * "Tight" includes *not* declaring a field you will ignore. Every optional
   * key here is a second wire spelling waiting to happen; see the
   * accepted ⊆ offered rule on `getLegalActions`.
   */
  readonly actionSchema: z.ZodType<TAction>

  /**
   * Optional schema for the game's own state. When present the platform
   * validates state loaded from Redis after a restart, so a corrupt or
   * stale-shaped blob fails loudly instead of producing a plausible lie.
   */
  readonly stateSchema?: z.ZodType<TState>

  /**
   * Builds the opening state. `settings` has already been parsed with
   * `manifest.settingsSchema`; `seats` is the final roster. Returned `timers`
   * start the first clock.
   */
  createInitialState(
    ctx: GameContext,
    settings: TSettings,
    seats: SeatRoster,
  ): ApplyResult<TState, TEvent>

  /**
   * Pure predicate: may `seatId` play `action` against `state` right now?
   * Must not mutate `state` and must not consume `ctx.rng`.
   */
  validateAction(
    ctx: GameContext,
    state: TState,
    seatId: SeatId,
    action: TAction,
  ): ValidationResult<TErrorCode>

  /**
   * Applies an action the runner has already validated. Must return a new
   * state rather than mutating the argument: the runner keeps the previous
   * state for rollback and for the match log.
   */
  applyAction(
    ctx: GameContext,
    state: TState,
    seatId: SeatId,
    action: TAction,
  ): ApplyResult<TState, TEvent>

  /**
   * **Nothing leaves the server without passing through this.**
   *
   * Return only what `viewer` is entitled to see. Redacting in the client, or
   * sending "hidden" fields the UI happens not to render, is a leak — a player
   * can read them in devtools.
   */
  getViewFor(state: TState, viewer: Viewer): TView

  /**
   * Optional. Powers move hints, bot seats and the conformance fuzzer.
   *
   * When present it must agree with `validateAction` **in both directions**:
   *
   *   - *offered ⊆ accepted* — every action returned here validates;
   *   - *accepted ⊆ offered* — every action `validateAction` accepts for
   *     `seatId` at `state` is **byte-identical** to one returned here, after
   *     both have been through `actionSchema`.
   *
   * The second direction is the one games get wrong, so it is worth stating
   * plainly: **one move has exactly one wire spelling.** If two distinct
   * payloads both validate and both play the same move, the extra spelling is
   * a bug even though nothing visibly breaks. A field your engine tolerates
   * and then ignores is the usual cause — a `promotion` letter on a move that
   * cannot promote, a `target` on an action that has no target, a flag that
   * only means something in another phase. `actionSchema` lets it through,
   * the rules layer drops it, and you now have a second spelling that
   * `getLegalActions` never lists.
   *
   * That is not a cosmetic disagreement. Move hints and bot seats drive off
   * this list, replays and the match log key off the action as sent, and the
   * conformance suite uses it to generate playouts — so a spelling it cannot
   * enumerate is a spelling nothing tests. Reject the tolerated field in
   * `validateAction`; do not widen `getLegalActions` to enumerate both.
   *
   * Only the game knows its own canonical spelling, so the platform cannot
   * enforce this for you. The testkit checks what it can — see ADR-0012 for
   * what it covers and what it provably does not.
   */
  getLegalActions?(state: TState, seatId: SeatId): readonly TAction[]

  /**
   * A timer the game asked for has fired. `timerId` always corresponds to a
   * `TimerSpec` declared in the manifest.
   */
  onTimer?(
    ctx: GameContext,
    state: TState,
    timerId: TimerId,
    seatId: SeatId | null,
  ): ApplyResult<TState, TEvent>

  /** Declarative; the platform runs the grace window and the countdown UI. */
  readonly disconnectPolicy: DisconnectPolicy

  /** Only needed when a disconnect changes *rules* state. Most games omit it. */
  onDisconnect?(
    ctx: GameContext,
    state: TState,
    seatId: SeatId,
    reason: DisconnectReason,
  ): ApplyResult<TState, TEvent>

  onReconnect?(ctx: GameContext, state: TState, seatId: SeatId): ApplyResult<TState, TEvent>

  /**
   * Null while the match is live; a result ends it. This is the only signal
   * the platform uses to decide a match is over.
   */
  getResult(state: TState): MatchResult | null

  /** Optional downloadable record. Called only after `getResult` is non-null. */
  exportRecord?(state: TState, events: readonly TEvent[]): MatchRecord

  /**
   * Brings a persisted state forward after a version change. Never called on a
   * running match — a match stays pinned to the version it started on.
   */
  migrateState?(state: unknown, fromVersion: string): Result<TState, MigrationError>
}

/** A turn-based game with its generics erased, for registries and runners. */
export type AnyTurnBasedGameServer = TurnBasedGameServer<
  unknown,
  unknown,
  unknown,
  unknown,
  GameEvent,
  string
>

/** Convenience alias for game authors writing their own error-code union. */
export type TurnBasedActionError<TErrorCode extends string = StandardActionErrorCode> =
  ActionError<TErrorCode>

/** Pairs a manifest with its server implementation. */
export interface TurnBasedGameDefinition<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent = GameEvent,
  TErrorCode extends string = StandardActionErrorCode,
> {
  readonly manifest: GameManifest<TSettings>
  readonly server: TurnBasedGameServer<TState, TAction, TView, TSettings, TEvent, TErrorCode>
}
