/**
 * `games/chess` as a Game SDK module: a `GameManifest` and a
 * `TurnBasedGameServer` assembled from the rules functions this package already
 * has. Nothing here re-implements a rule; it is the adapter that lets the room
 * runner — and `@playhall/game-testkit`'s conformance suite — drive chess
 * through the contract instead of through chess-shaped helpers.
 *
 * ## Why not `defineTurnBasedGame`
 *
 * `defineTurnBasedGame` takes `{ manifest, server, client }` and `client`
 * requires a `GameView`. The board UI is a separate task, so there is no client
 * module to hand it yet, and stubbing one would put a lazy import of a
 * component that does not exist into the registry. `manifest` and `server` are
 * therefore exported directly, and `test/module.test.ts` runs the SDK's own
 * `validateManifest` so the manifest is still checked in CI — the one thing
 * `defineTurnBasedGame` would have bought us. Wire `defineTurnBasedGame` up in
 * the same commit that adds the board.
 *
 * ## Client actions vs server-raised actions
 *
 * `state.ts`'s `ChessAction` union is wider than what a client may send. `flag`
 * and `first_move_timeout` are raised from the platform clock, so they are
 * absent from `actionSchema` — the outer wall against a modified client — and
 * arrive through `onTimer` instead. `claim_abandonment` is also absent: see the
 * note on `onDisconnect` below.
 *
 * ## Error codes
 *
 * `ChessActionError` is chess vocabulary; `ActionError.code` must be a code the
 * platform can map to player-facing copy. The mapping is in
 * `PLATFORM_ERROR_CODE`, and the chess code travels in `message` for logs and
 * tests. A game may declare extra codes, but only by passing `errorCodes` to
 * the conformance subject, and the whole point of `conformance.test.ts` is that
 * it takes `{ manifest, server }` and nothing else.
 */

import { z } from 'zod'
import {
  PUBLIC,
  SDK_CONTRACT_VERSION,
  asTimerId,
  clearTimer,
  invalid,
  setTimer,
  toSeats,
  VALID,
  type ApplyResult,
  type DisconnectPolicy,
  type EventAudience,
  type GameContext,
  type GameEvent,
  type GameManifest,
  type MatchRecord,
  type MatchResult,
  type SeatId,
  type SeatRoster,
  type SettingsPreset,
  type StandardActionErrorCode,
  type TimerCommand,
  type TimerSpec,
  type TurnBasedGameServer,
  type ValidationResult,
  type Viewer,
} from '@playhall/game-sdk'

import { exportRecord as exportChessRecord } from './record.js'
import { getResult, terminationText } from './result.js'
import { availableDrawClaims } from './rules/endings.js'
import { analyse, replay } from './rules/position.js'
import type {
  ChessEnding,
  Color,
  DrawClaim,
  EndingReason,
  MoveInput,
  PromotionPiece,
} from './rules/types.js'
import {
  applyAction as reduce,
  canAbort,
  colorOf,
  setup as setupChess,
  turnOf,
  DRAW_OFFER_COOLDOWN_PLIES,
  FIRST_MOVE_TIMEOUT_MS,
  type ChessAction,
  type ChessActionError,
  type ChessMatchState,
} from './state.js'
import {
  CHESS_SETTINGS_PRESETS,
  chessSettingsForm,
  chessSettingsSchema,
  defaultChessSettings,
  describeTimeControl,
  type ChessSettings,
} from './settings/index.js'
import { getViewFor, type ChessView } from './view.js'

/* -------------------------------------------------------------------------- */
/* Actions a client may send                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Adapts a schema to the SDK's `z.ZodType<T>` fields.
 *
 * `z.ZodType<T>` pins the schema's *input* type to `T` as well as its output, so
 * a schema built with `.default()` — whose input has optional keys, which is the
 * entire point of a default — is not assignable to it even though its output is
 * exactly `T`. `chessSettingsSchema` is that schema, deliberately: a client may
 * send a partial create-lobby payload and the defaults fill the rest.
 *
 * Nothing the SDK does with these fields needs the narrower input. Both
 * `validateManifest` and the conformance suite only ever call
 * `safeParse(unknown)`, and the manifest's own runtime guard (`zodSchemaLike`) is
 * duck-typed on exactly that. `z.ZodType<T, z.ZodTypeDef, unknown>` is the shape
 * the contract actually wants; the cast is confined here, and the call still
 * checks the schema's **output** against `T`, which is the half that matters.
 * Raised with the CTO as an SDK typing nit rather than worked around by dropping
 * the defaults.
 */
function asSchemaOf<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>): z.ZodType<T> {
  return schema as z.ZodType<T>
}

const SQUARE = /^[a-h][1-8]$/

const promotionSchema = z.enum(['q', 'r', 'b', 'n'] as const satisfies readonly PromotionPiece[])

/**
 * Coordinates, not SAN. A promoting push must name its piece: chess.js refuses
 * `{ from: 'e7', to: 'e8' }` on a promotion, and defaulting to a queen would
 * let the server play a move the player never chose. Keyboard entry is resolved
 * to coordinates client-side by `parseMoveInput` before it reaches the wire.
 */
const moveInputSchema = z
  .object({
    from: z.string().regex(SQUARE, 'expected a square such as e2'),
    to: z.string().regex(SQUARE, 'expected a square such as e4'),
    promotion: promotionSchema.optional(),
  })
  .strict() satisfies z.ZodType<MoveInput>

const drawClaimSchema = z.enum([
  'threefold_repetition',
  'fifty_move_rule',
] as const satisfies readonly DrawClaim[])

/**
 * `.strict()` on every member: an unknown key is a client the server does not
 * recognise, and failing loudly beats silently ignoring a field the player
 * believes they sent. Same reasoning as `chessSettingsSchema`.
 */
export const chessActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), move: moveInputSchema }).strict(),
  z.object({ type: z.literal('resign') }).strict(),
  z.object({ type: z.literal('offer_draw') }).strict(),
  z.object({ type: z.literal('accept_draw') }).strict(),
  z.object({ type: z.literal('decline_draw') }).strict(),
  z.object({ type: z.literal('claim_draw'), claim: drawClaimSchema }).strict(),
  z.object({ type: z.literal('abort') }).strict(),
])

/** The subset of `ChessAction` a seated player may submit over the wire. */
export type ChessClientAction = z.infer<typeof chessActionSchema>

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Chess has no hidden information on the board, but a pending draw offer is
 * still private to the two players — `getViewFor` redacts it from spectators,
 * so the offer events are addressed to the seats rather than `PUBLIC`. An event
 * that leaked what the view hid would make the redaction decorative.
 */
export type ChessEvent =
  | GameEvent<'match_started', { white: string; black: string; timeControl: string }>
  | GameEvent<'move_played', { san: string; from: string; to: string; color: Color; ply: number }>
  | GameEvent<'draw_offered', { by: Color }>
  | GameEvent<'draw_declined', { by: Color }>
  | GameEvent<'match_ended', { reason: EndingReason; description: string }>

type ChessApplyResult = ApplyResult<ChessMatchState, ChessEvent>

/* -------------------------------------------------------------------------- */
/* State schema                                                               */
/* -------------------------------------------------------------------------- */

const colorSchema = z.enum(['w', 'b'] as const satisfies readonly Color[])

/**
 * Seat ids are platform-branded strings. `z.custom` keeps the brand on the
 * parsed output, which a `z.string()` would erase.
 */
const seatIdSchema = z.custom<SeatId>((value) => typeof value === 'string' && value.length > 0, {
  message: 'expected a seat id',
})

const endingSchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal('checkmate'), winner: colorSchema }).strict(),
  z.object({ reason: z.literal('stalemate') }).strict(),
  z.object({ reason: z.literal('insufficient_material') }).strict(),
  z
    .object({ reason: z.literal('threefold_repetition'), claimedBy: colorSchema.nullable() })
    .strict(),
  z.object({ reason: z.literal('fivefold_repetition') }).strict(),
  z.object({ reason: z.literal('fifty_move_rule'), claimedBy: colorSchema.nullable() }).strict(),
  z.object({ reason: z.literal('seventy_five_move_rule') }).strict(),
  z.object({ reason: z.literal('resignation'), winner: colorSchema }).strict(),
  z.object({ reason: z.literal('draw_agreement') }).strict(),
  z.object({ reason: z.literal('timeout'), winner: colorSchema }).strict(),
  z
    .object({ reason: z.literal('timeout_vs_insufficient_material'), flagged: colorSchema })
    .strict(),
  z.object({ reason: z.literal('abandonment'), winner: colorSchema }).strict(),
  z.object({ reason: z.literal('abandonment_draw') }).strict(),
  z
    .object({ reason: z.literal('abort'), cause: z.enum(['agreed', 'first_move_timeout']) })
    .strict(),
]) satisfies z.ZodType<ChessEnding>

/**
 * What the platform validates a blob loaded from Redis against after a restart.
 *
 * Worth having even though the match log is the source of truth: a stale-shaped
 * blob that parses as "plausible chess" is far more dangerous than one that
 * fails loudly, because the players find out at move 30.
 */
export const chessStateSchema: z.ZodType<ChessMatchState> = asSchemaOf<ChessMatchState>(
  z
    .object({
      phase: z.enum(['awaiting_first_move', 'in_play', 'finished']),
      initialFen: z.string().min(1),
      moves: z.array(z.string().min(1)),
      colors: z.object({ w: seatIdSchema, b: seatIdSchema }).strict(),
      settings: chessSettingsSchema,
      drawOffer: z.object({ by: colorSchema }).strict().nullable(),
      lastDrawOfferPly: z
        .object({
          w: z.number().int().nonnegative().nullable(),
          b: z.number().int().nonnegative().nullable(),
        })
        .strict(),
      ending: endingSchema.nullable(),
      startedAt: z.number().int(),
      lastMoveAt: z.number().int().nullable(),
    })
    .strict(),
)

/* -------------------------------------------------------------------------- */
/* Timers                                                                     */
/* -------------------------------------------------------------------------- */

/** The 30 s window for a side's first move. Chess owns this one end to end. */
export const FIRST_MOVE_TIMER = asTimerId('first-move')

/**
 * The per-player clock. Declared because `onTimer` reacts to it, **not** driven
 * from here: the platform timer service owns set/pause/resume from
 * `resolveTimeControl(settings)`, applies the increment, and raises the
 * under-10 s warning. Reimplementing any of that in the game would be a bug.
 */
export const CHESS_CLOCK_TIMER = asTimerId('chess-clock')

const TIMERS: readonly TimerSpec[] = [
  {
    id: String(FIRST_MOVE_TIMER),
    kind: 'turn',
    description: 'A side has 30 seconds to make its first move, or the match aborts.',
    // A player who never arrives must not be able to hold the room open by
    // staying disconnected.
    pausesOnDisconnect: false,
  },
  {
    id: String(CHESS_CLOCK_TIMER),
    kind: 'chess-clock',
    description: "Each player's remaining time, from the lobby's time control.",
    // Spec: on a disconnect the clock keeps running. A blip must not become a
    // free pause, and the opponent's claim path is what handles a real absence.
    pausesOnDisconnect: false,
  },
]

/** Whoever is to move gets the 30 s window; it is cleared once both have moved. */
function firstMoveTimers(state: ChessMatchState): readonly TimerCommand[] {
  if (state.phase === 'finished') return [clearTimer(FIRST_MOVE_TIMER)]
  if (state.moves.length >= 2) return [clearTimer(FIRST_MOVE_TIMER)]
  return [setTimer(FIRST_MOVE_TIMER, FIRST_MOVE_TIMEOUT_MS, state.colors[turnOf(state)])]
}

/** Only a move or an ending changes the first-move window. */
function timersFor(before: ChessMatchState, after: ChessMatchState): readonly TimerCommand[] {
  const moved = after.moves.length !== before.moves.length
  const finished = after.phase === 'finished' && before.phase !== 'finished'
  return moved || finished ? firstMoveTimers(after) : []
}

/* -------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_SETTINGS: ChessSettings = defaultChessSettings()

/**
 * The preset the lobby opens on. It must carry exactly `DEFAULT_SETTINGS` or the
 * form would show one thing and report another; `validateManifest` enforces it.
 */
const DEFAULT_PRESET_ID = 'blitz-5-0'

const PRESETS: readonly SettingsPreset<ChessSettings>[] = CHESS_SETTINGS_PRESETS.map((preset) => ({
  id: preset.id,
  label: preset.label,
  description: preset.description,
  settings: preset.settings,
  featured: preset.featured,
  ...(preset.id === DEFAULT_PRESET_ID ? { isDefault: true as const } : {}),
}))

export const chessManifest: GameManifest<ChessSettings> = {
  id: 'chess',
  slug: 'chess',
  name: 'Chess',
  shortDescription: 'Classic chess with clocks, draw offers and PGN export. Two players.',
  thumbnail: 'assets/thumbnail.svg',
  category: 'board',

  minPlayers: 2,
  maxPlayers: 2,
  teams: 'none',

  turnModel: 'sequential',

  hasHiddenInformation: false,
  // Colour assignment for `color: 'random'` draws from `ctx.rng`, so a match is
  // only reproducible from its stored seed.
  usesRandomness: true,
  supportsSpectators: true,
  supportsBots: false,

  settingsSchema: asSchemaOf<ChessSettings>(chessSettingsSchema),
  defaultSettings: DEFAULT_SETTINGS,
  presets: PRESETS,
  settingsForm: chessSettingsForm,

  timers: TIMERS,

  // The rules are complete and tested; the board UI is not built yet, so the
  // catalogue must not offer a lobby nobody can play. Flip to 'live' in the
  // commit that lands the board.
  status: 'coming-soon',
  // The module version a match pins to for its whole life. Deliberately
  // independent of the private package version in package.json.
  version: '0.1.0',
  sdkContractVersion: SDK_CONTRACT_VERSION,
}

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Chess rejection codes mapped onto the platform's shared vocabulary.
 *
 * Exhaustive by type: adding a `ChessActionError` without deciding what the
 * platform should tell the player is a compile error, not a silent
 * `internal_error`.
 */
const PLATFORM_ERROR_CODE: Record<ChessActionError, StandardActionErrorCode> = {
  not_a_player: 'not_seated',
  game_over: 'match_over',
  not_your_turn: 'not_your_turn',
  illegal_move: 'illegal_action',
  // Both players have moved, so the match counts and the way out is to resign.
  abort_not_allowed: 'out_of_phase',
  draw_offer_pending: 'out_of_phase',
  // Spec: draw offers are rate-limited. One offer per side per two plies.
  draw_offer_cooldown: 'rate_limited',
  no_draw_offer: 'out_of_phase',
  claim_unavailable: 'illegal_action',
  first_move_deadline_not_reached: 'out_of_phase',
}

const DISCONNECT_POLICY: DisconnectPolicy = {
  graceMs: 30_000,
  /**
   * Spec: after the grace period the opponent may claim a win, claim a draw, or
   * keep waiting. Nothing happens on its own, so the platform applies no action
   * of its own when grace expires.
   */
  onGraceExpired: 'nothing',
  /** Spec: the clock keeps running. */
  pauseTimersDuringGrace: false,
  abandonMatchAfterMs: 600_000,
  allowReconnectUntilMatchEnd: true,
}

function playerColor(state: ChessMatchState, seatId: SeatId): Color | null {
  return colorOf(state, seatId)
}

/** Every move legal in the current position, as wire-shaped `MoveInput`s. */
function legalMoveActions(state: ChessMatchState): readonly ChessClientAction[] {
  const chess = replay(state.initialFen, state.moves)
  return chess.moves({ verbose: true }).map((move): ChessClientAction => {
    const promotion =
      move.promotion === 'q' ||
      move.promotion === 'r' ||
      move.promotion === 'b' ||
      move.promotion === 'n'
        ? move.promotion
        : undefined
    return {
      type: 'move',
      move:
        promotion === undefined
          ? { from: move.from, to: move.to }
          : { from: move.from, to: move.to, promotion },
    }
  })
}

/**
 * Everything `seatId` may play right now.
 *
 * This has to agree with `validateAction` in **both** directions — the
 * conformance suite asserts it, and move hints, bot seats and the suite's own
 * playout driver all read it. Each branch below therefore mirrors exactly one
 * guard in `state.ts`'s reducer; the reducer stays the authority.
 */
function getLegalActions(state: ChessMatchState, seatId: SeatId): readonly ChessClientAction[] {
  if (state.phase === 'finished') return []
  const color = playerColor(state, seatId)
  if (color === null) return []

  const actions: ChessClientAction[] = []
  const position = analyse(state.initialFen, state.moves)

  if (position.turn === color) {
    actions.push(...legalMoveActions(state))
    for (const claim of availableDrawClaims(position)) {
      actions.push({ type: 'claim_draw', claim })
    }
  }

  // Available to either side at any time — a player must always be able to
  // concede, and the conformance suite's `probeActions` gap is exactly the
  // "forgot resign is always legal" bug.
  actions.push({ type: 'resign' })

  if (canAbort(state)) actions.push({ type: 'abort' })

  const last = state.lastDrawOfferPly[color]
  const cooledDown = last === null || state.moves.length >= last + DRAW_OFFER_COOLDOWN_PLIES
  if (state.drawOffer === null && cooledDown) actions.push({ type: 'offer_draw' })

  if (state.drawOffer !== null && state.drawOffer.by !== color) {
    actions.push({ type: 'accept_draw' }, { type: 'decline_draw' })
  }

  return actions
}

/**
 * `validateAction` runs the reducer and throws the new state away.
 *
 * The SDK warns that apply-and-discard is wrong for a game that consumes
 * `ctx.rng` in its reducer. Chess consumes randomness only in `setup` — colour
 * assignment — so the reducer is a pure predicate here, and routing legality
 * through the one function that decides it removes any way for the two to drift
 * apart. Every guard exists in exactly one place.
 */
function validateAction(
  ctx: GameContext,
  state: ChessMatchState,
  seatId: SeatId,
  action: ChessClientAction,
): ValidationResult<StandardActionErrorCode> {
  const outcome = reduce(state, action, seatId, ctx)
  if (outcome.ok) return VALID
  return invalid(PLATFORM_ERROR_CODE[outcome.error], `chess: ${outcome.error}`)
}

function endedEvents(before: ChessMatchState, after: ChessMatchState): readonly ChessEvent[] {
  if (after.ending === null || before.ending !== null) return []
  return [
    {
      type: 'match_ended',
      payload: { reason: after.ending.reason, description: terminationText(after.ending) },
      audience: PUBLIC,
    },
  ]
}

function bothSeats(state: ChessMatchState): EventAudience {
  return toSeats(state.colors.w, state.colors.b)
}

/**
 * Applies an action the runner has already validated.
 *
 * Throws if the reducer rejects it. That is not a rejection path — the contract
 * says `validateAction` runs first — so a rejection here means the runner
 * skipped a step, and failing loudly beats returning the state unchanged and
 * letting the room spin.
 */
function applyAction(
  ctx: GameContext,
  state: ChessMatchState,
  seatId: SeatId,
  action: ChessClientAction,
): ChessApplyResult {
  const outcome = reduce(state, action, seatId, ctx)
  if (!outcome.ok) {
    throw new Error(
      `applyAction called with an action validateAction rejects ('${outcome.error}'): ${action.type}`,
    )
  }
  const next = outcome.state
  const color = playerColor(state, seatId)
  const events: ChessEvent[] = []

  if (action.type === 'move' && color !== null) {
    const san = next.moves[next.moves.length - 1]
    if (san !== undefined) {
      events.push({
        type: 'move_played',
        payload: {
          san,
          from: action.move.from,
          to: action.move.to,
          color,
          ply: next.moves.length,
        },
        audience: PUBLIC,
      })
    }
  } else if (action.type === 'offer_draw' && color !== null) {
    events.push({ type: 'draw_offered', payload: { by: color }, audience: bothSeats(state) })
  } else if (action.type === 'decline_draw' && color !== null) {
    events.push({ type: 'draw_declined', payload: { by: color }, audience: bothSeats(state) })
  }

  events.push(...endedEvents(state, next))
  return { state: next, events, timers: timersFor(state, next) }
}

/**
 * Applies a server-raised action: one of the two the clock owns.
 *
 * `onTimer` is how they reach the reducer, which is why they are not in
 * `actionSchema` — a client that sends `{ type: 'flag' }` is rejected by the
 * schema wall before any chess code runs.
 */
function onTimer(
  ctx: GameContext,
  state: ChessMatchState,
  timerId: string,
  seatId: SeatId | null,
): ChessApplyResult {
  const raised = serverAction(state, timerId, seatId)
  if (raised === null) return { state, events: [] }

  const outcome = reduce(state, raised, null, ctx)
  // A timer that fires against a finished match, or a first-move deadline the
  // runner re-checks early, is a benign race: the platform fired something the
  // rules no longer want. Leave the state alone.
  if (!outcome.ok) return { state, events: [] }

  return {
    state: outcome.state,
    events: endedEvents(state, outcome.state),
    timers: timersFor(state, outcome.state),
  }
}

function serverAction(
  state: ChessMatchState,
  timerId: string,
  seatId: SeatId | null,
): ChessAction | null {
  if (timerId === String(FIRST_MOVE_TIMER)) return { type: 'first_move_timeout' }
  if (timerId === String(CHESS_CLOCK_TIMER)) {
    const flagged = seatId === null ? null : colorOf(state, seatId)
    return flagged === null ? null : { type: 'flag', color: flagged }
  }
  return null
}

export const chessServer: TurnBasedGameServer<
  ChessMatchState,
  ChessClientAction,
  ChessView,
  ChessSettings,
  ChessEvent,
  StandardActionErrorCode
> = {
  actionSchema: chessActionSchema,
  stateSchema: chessStateSchema,

  createInitialState(
    ctx: GameContext,
    settings: ChessSettings,
    seats: SeatRoster,
  ): ChessApplyResult {
    const [host, guest] = seats
    if (host === undefined || guest === undefined) {
      // The manifest pins the match to exactly two seats, so this is a platform
      // invariant rather than a player-reachable error; there is no typed
      // failure channel on `createInitialState` to report it through.
      throw new Error(`chess needs exactly 2 seats, got ${seats.length}`)
    }

    const state = setupChess({ hostSeatId: host.seatId, guestSeatId: guest.seatId, settings }, ctx)
    return {
      state,
      events: [
        {
          type: 'match_started',
          payload: {
            white: String(state.colors.w),
            black: String(state.colors.b),
            timeControl: describeTimeControl(settings),
          },
          audience: PUBLIC,
        },
      ],
      timers: firstMoveTimers(state),
    }
  },

  validateAction,
  applyAction,
  getLegalActions,
  onTimer,

  getViewFor(state: ChessMatchState, viewer: Viewer): ChessView {
    return getViewFor(state, viewer)
  },

  disconnectPolicy: DISCONNECT_POLICY,

  /**
   * Deliberately absent: `onDisconnect` / `onReconnect`.
   *
   * Presence is a platform fact and chess's rules state does not change when a
   * socket drops — the clock keeps running and that is the whole behaviour. The
   * consequence is that `claim_abandonment`, which the reducer implements, has
   * no wire path yet: it is not in `actionSchema` because the reducer accepts it
   * unconditionally, and shipping it that way would let a modified client claim
   * a win against a present opponent. Closing that needs presence-derived rules
   * state (an `onDisconnect` that records the absence and a grace timer that
   * makes the claim available), which is its own change.
   */

  getResult(state: ChessMatchState): MatchResult | null {
    return getResult(state)
  },

  /** PGN. The SDK passes the event log too; chess derives everything from SAN. */
  exportRecord(state: ChessMatchState): MatchRecord {
    return exportChessRecord(state)
  },
}
