/**
 * What a game hands the conformance suite.
 *
 * The suite drives a game through nothing but the public
 * `TurnBasedGameServer` contract, so most games need to supply only
 * `{ manifest, server }`. The optional fields exist for the two things the
 * contract cannot tell us:
 *
 *   - **what counts as a secret.** `getViewFor` can only be fuzzed for leaks
 *     if the suite knows which values are hidden from whom. A game with
 *     `hasHiddenInformation: true` must declare its secrets; the suite fails
 *     a game that claims hidden information and then declares none, because a
 *     vacuous leak check is worse than no leak check.
 *   - **how to drive a playout.** `getLegalActions` is optional in the
 *     contract. Without it (or a `chooseAction` override) the suite cannot
 *     generate a game and has to skip the playout-based checks.
 */

import type {
  GameEvent,
  GameManifest,
  JsonValue,
  Rng,
  SeatId,
  SeatRoster,
  StandardActionErrorCode,
  TurnBasedGameServer,
} from '@playhall/game-sdk'

/**
 * One parcel of hidden information: some values, and the seats entitled to
 * them.
 *
 * `entitledSeats: []` means no live viewer may see it at all — a face-down
 * deck, an unrevealed traitor. (The `replay` viewer is exempt everywhere; the
 * platform may only build one after `getResult` is non-null.)
 */
export interface SecretHolding {
  readonly entitledSeats: readonly SeatId[]
  /**
   * The concrete scalars that must not reach anyone else.
   *
   * **Use distinctive values.** The fuzzer searches for these by value, so a
   * secret that is the bare number `2` collides with every score, index and
   * count in the view and produces false positives. Identify a hidden card as
   * `"c07"`, not as `7`.
   */
  readonly values: readonly (string | number | boolean)[]
}

/**
 * One kind of hidden information in a game.
 *
 * The suite calls `holdings(state)` and then asserts that no holding's values
 * appear anywhere in the view of, or an event delivered to, a viewer outside
 * that holding's `entitledSeats` — as a leaf, as an object key, or as a
 * substring of a string. Only scalars are usable as needles, so decompose a
 * hidden object into the scalars that identify it.
 */
export interface SecretDescriptor<TState> {
  /** Shows up in failure messages, e.g. `"seat hand"`. */
  readonly label: string
  /** One entry per group of values with the same audience. */
  holdings(state: TState): readonly SecretHolding[]
  /**
   * Whether spectators may see it. Defaults to `false` — a spectator stream
   * is the easiest way to cheat, because a player can open it in a second
   * tab, so hidden information is hidden from spectators unless a game says
   * otherwise.
   */
  readonly visibleToSpectators?: boolean
}

/**
 * The common case: each seat holds its own secret and no one else may see it.
 *
 * ```ts
 * perSeatSecret('seat hand', (state) =>
 *   state.hands.map((hand) => ({ seatId: hand.seatId, values: hand.cards.map((c) => c.id) })),
 * )
 * ```
 */
export function perSeatSecret<TState>(
  label: string,
  extract: (state: TState) => readonly {
    readonly seatId: SeatId
    readonly values: readonly (string | number | boolean)[]
  }[],
): SecretDescriptor<TState> {
  return {
    label,
    holdings: (state) =>
      extract(state).map((entry) => ({ entitledSeats: [entry.seatId], values: entry.values })),
  }
}

/** Information no live viewer may see: a face-down deck, an unrevealed role. */
export function serverOnlySecret<TState>(
  label: string,
  extract: (state: TState) => readonly (string | number | boolean)[],
): SecretDescriptor<TState> {
  return { label, holdings: (state) => [{ entitledSeats: [], values: extract(state) }] }
}

/** One `(seat, action)` pair the driver may play next. */
export interface ActionCandidate<TAction> {
  readonly seatId: SeatId
  readonly actions: readonly TAction[]
}

export interface SettingsVariant<TSettings> {
  readonly label: string
  readonly settings: TSettings
}

export interface TurnBasedConformanceSubject<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent = GameEvent,
  TErrorCode extends string = StandardActionErrorCode,
> {
  readonly manifest: GameManifest<TSettings>
  readonly server: TurnBasedGameServer<TState, TAction, TView, TSettings, TEvent, TErrorCode>

  /**
   * Settings to exercise. Defaults to `defaultSettings` plus every preset,
   * which is what the lobby can actually produce.
   */
  readonly settingsVariants?: readonly SettingsVariant<TSettings>[]

  /** Player counts to exercise. Defaults to `minPlayers` and `maxPlayers`. */
  readonly playerCounts?: readonly number[]

  /** Override the generated roster, e.g. to pin team assignments. */
  buildRoster?(playerCount: number): SeatRoster

  /** Declared hidden information. Required when `hasHiddenInformation` is true. */
  readonly secrets?: readonly SecretDescriptor<TState>[]

  /**
   * Picks the next move. Defaults to a uniform pick among the actions of the
   * seat with the most options, which is the seat to move in a sequential
   * game. Override it to steer playouts away from instant concessions or
   * towards a phase the default driver rarely reaches.
   */
  chooseAction?(
    state: TState,
    candidates: readonly ActionCandidate<TAction>[],
    rng: Rng,
  ): { readonly seatId: SeatId; readonly action: TAction } | null

  /**
   * Extra junk payloads `actionSchema` must reject, on top of the suite's
   * standard battery. Use it for shapes that are specific to the game, e.g.
   * a move index one past the end of the board.
   */
  readonly malformedActions?: readonly unknown[]

  /**
   * Well-formed actions that are always illegal in the given state, used to
   * check that a rejection leaves state untouched. Defaults to whatever the
   * suite can derive from `getLegalActions`.
   */
  illegalActionsFor?(state: TState, seatId: SeatId): readonly TAction[]

  /**
   * Well-formed actions the suite should try everywhere, on top of the ones
   * it observes during play.
   *
   * This is what makes the *reverse* half of `legal-actions-agree`
   * meaningful. Without it the suite can only probe actions
   * `getLegalActions` itself offered, so a `getLegalActions` that omits an
   * action category entirely — the classic being "forgot that resigning is
   * always available" — hides from its own check. A handful of representative
   * actions here closes that hole.
   */
  readonly probeActions?: readonly TAction[]

  /**
   * Error codes this game may return, beyond the standard set. Declaring them
   * lets the suite reject a typo'd code instead of waving it through.
   */
  readonly errorCodes?: readonly string[]

  /** Extra detail recorded in the report, e.g. a package version. */
  readonly detail?: Readonly<Record<string, JsonValue>>
}

export interface TurnBasedConformanceOptions {
  /** Number of seeded playouts per settings variant. Default 24. */
  readonly playoutsPerVariant?: number
  /** Hard step budget per playout; exceeding it fails the termination check. Default 500. */
  readonly maxStepsPerPlayout?: number
  /** Base seed. Change it to explore a different corner; keep it to reproduce. */
  readonly seed?: string
  /**
   * Trap `Date.now`, `Math.random` and `performance.now` while game code runs.
   * Default true. Turn it off only for a game whose *third-party* dependency
   * is known to read a clock outside the reducer path.
   */
  readonly trapAmbientSources?: boolean
  /** Only run these checks. Default: all of them. */
  readonly only?: readonly string[]
  /** The wall clock the fake platform starts at. Fixed so runs are reproducible. */
  readonly startNow?: number
  /** How far `ctx.now` advances per mutation. Default 1000 ms. */
  readonly nowStepMs?: number
}
