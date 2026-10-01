import { availableDrawClaims, detectAutomaticEnding, timeoutEnding } from './rules/endings.js'
import { canPossiblyMate } from './rules/material.js'
import { analyse, replay, START_FEN, tryMove } from './rules/position.js'
import {
  opponent,
  type ChessEnding,
  type Color,
  type ColorAssignment,
  type DrawClaim,
  type MoveInput,
} from './rules/types.js'
import type { GameContext, SeatId } from './sdk/contract.js'
import { assignColors } from './settings/color.js'
import { defaultChessSettings, type ChessSettings } from './settings/schema.js'

/**
 * A player gets 30 seconds to make their first move, or the game aborts.
 * This runs before the chess clock, and applies to each side's first move.
 */
export const FIRST_MOVE_TIMEOUT_MS = 30_000

/**
 * Plies a side must wait between draw offers.
 *
 * Two plies means "you have had another turn since your last offer", which stops
 * offer-spam without blocking a genuine second offer later in the game.
 */
export const DRAW_OFFER_COOLDOWN_PLIES = 2

export interface ChessMatchState {
  readonly phase: 'awaiting_first_move' | 'in_play' | 'finished'
  /** Position the game started from. Stored so the move list is replayable. */
  readonly initialFen: string
  /** The whole game, in SAN. The FEN is derived from this, never stored as truth. */
  readonly moves: readonly string[]
  readonly colors: ColorAssignment
  readonly settings: ChessSettings
  /** Pending draw offer, if any. Redacted from spectators. */
  readonly drawOffer: { readonly by: Color } | null
  /** Ply index at which each side last offered a draw, for the cooldown. */
  readonly lastDrawOfferPly: Readonly<Record<Color, number | null>>
  readonly ending: ChessEnding | null
  /** `ctx.now` when the match was set up. Start of White's 30 s first-move window. */
  readonly startedAt: number
  /** `ctx.now` of the most recent move. Start of the next side's window. */
  readonly lastMoveAt: number | null
}

export type ChessActionError =
  | 'not_a_player'
  | 'game_over'
  | 'not_your_turn'
  | 'illegal_move'
  | 'abort_not_allowed'
  | 'draw_offer_pending'
  | 'draw_offer_cooldown'
  | 'no_draw_offer'
  | 'claim_unavailable'
  | 'first_move_deadline_not_reached'

/**
 * Actions the reducer accepts.
 *
 * `flag` and `first_move_timeout` carry no actor: they are raised by the server
 * from the platform clock, never by a client. That is not a convention the
 * reducer trusts — it refuses either one that arrives with an actor. See the
 * runner obligations documented in `sdk/contract.ts`.
 */
export type ChessAction =
  | { readonly type: 'move'; readonly move: MoveInput }
  | { readonly type: 'resign' }
  | { readonly type: 'offer_draw' }
  | { readonly type: 'accept_draw' }
  | { readonly type: 'decline_draw' }
  | { readonly type: 'claim_draw'; readonly claim: DrawClaim }
  | { readonly type: 'abort' }
  /**
   * Opponent has been gone past the platform's grace period. Presence is a
   * platform fact, so the runner is responsible for only dispatching this once
   * grace has actually elapsed — see the SDK note in `sdk/contract.ts`.
   *
   * `outcome` is a *request*, not a decision: a `win` is only granted to a side
   * that could still deliver mate. The reducer decides, not the claimant.
   */
  | { readonly type: 'claim_abandonment'; readonly outcome: 'win' | 'draw' }
  | { readonly type: 'flag'; readonly color: Color }
  | { readonly type: 'first_move_timeout' }

export type ChessActionResult =
  | { readonly ok: true; readonly state: ChessMatchState }
  | { readonly ok: false; readonly error: ChessActionError }

const fail = (error: ChessActionError): ChessActionResult => ({ ok: false, error })
const done = (state: ChessMatchState): ChessActionResult => ({ ok: true, state })

export interface SetupInput {
  /** The player who opened the lobby. The colour preference is theirs. */
  readonly hostSeatId: SeatId
  /** Whoever joined through the link or the code. */
  readonly guestSeatId: SeatId
  /** Validated lobby settings. Defaults are used when omitted. */
  readonly settings?: ChessSettings
  /** Non-standard starting position, for tests and (later) puzzles. */
  readonly initialFen?: string
}

/**
 * Create a new match.
 *
 * Colour randomisation reads `ctx.rng`, never `Math.random()`, so replaying the
 * match log with the stored seed reproduces the same assignment.
 */
export function setup(input: SetupInput, ctx: GameContext): ChessMatchState {
  const settings = input.settings ?? defaultChessSettings()

  return {
    phase: 'awaiting_first_move',
    initialFen: input.initialFen ?? START_FEN,
    moves: [],
    // `ctx.rng` is an SDK stream object, not a bare function; adapt it rather
    // than widening the settings layer's `Rng` type.
    colors: assignColors(settings.color, input.hostSeatId, input.guestSeatId, () => ctx.rng.next()),
    settings,
    drawOffer: null,
    lastDrawOfferPly: { w: null, b: null },
    ending: null,
    startedAt: ctx.now,
    lastMoveAt: null,
  }
}

/** Which colour a seat is playing, or `null` if the seat is not in this game. */
export function colorOf(state: ChessMatchState, seatId: SeatId): Color | null {
  if (state.colors.w === seatId) return 'w'
  if (state.colors.b === seatId) return 'b'
  return null
}

/** Whose turn it is. Derived from the move list, never stored. */
export function turnOf(state: ChessMatchState): Color {
  return analyse(state.initialFen, state.moves).turn
}

/**
 * Abort is available until both players have moved, and cancels the match with
 * no result recorded. After Black's first reply the game counts, and a player
 * who wants out has to resign.
 */
export function canAbort(state: ChessMatchState): boolean {
  return state.phase !== 'finished' && state.moves.length < 2
}

/**
 * When the side to move runs out of their 30 s first-move window.
 * `null` once both players have moved and the chess clock has taken over.
 */
export function firstMoveDeadline(state: ChessMatchState): number | null {
  if (state.phase === 'finished' || state.moves.length >= 2) return null
  const reference =
    state.moves.length === 0 ? state.startedAt : (state.lastMoveAt ?? state.startedAt)
  return reference + FIRST_MOVE_TIMEOUT_MS
}

function finish(state: ChessMatchState, ending: ChessEnding): ChessMatchState {
  return { ...state, phase: 'finished', ending, drawOffer: null }
}

/**
 * The single entry point for changing a match.
 *
 * Every legality decision lives here and runs on the server. The client may draw
 * legal-move dots, but a client that skips them cannot get an illegal move past
 * this function: the move is replayed through chess.js from the stored SAN list.
 *
 * `actor` is the authenticated seat the action came from, or `null` for an action
 * the *server* raised from a platform fact. The two are not interchangeable and
 * the reducer enforces that in both directions: a server-raised action from a
 * seat is refused, and a seat action with no seat is refused. A runner that
 * forwards a client envelope straight in therefore cannot end a game with a
 * `flag` — which is the one thing this module has no way to verify.
 */
export function applyAction(
  state: ChessMatchState,
  action: ChessAction,
  actor: SeatId | null,
  ctx: GameContext,
): ChessActionResult {
  if (state.phase === 'finished') return fail('game_over')

  // Server-raised actions are handled before the seat check, so the absence of
  // an actor is checked here instead of falling through to `colorOf`. The module
  // holds no clock, so `flag` cannot be verified against anything — the actor
  // shape is the whole guard, and it has to be enforced rather than assumed.
  if (action.type === 'flag') {
    if (actor !== null) return fail('not_a_player')
    const { fen } = analyse(state.initialFen, state.moves)
    return done(finish(state, timeoutEnding(fen, action.color)))
  }

  if (action.type === 'first_move_timeout') {
    if (actor !== null) return fail('not_a_player')
    const deadline = firstMoveDeadline(state)
    if (deadline === null) return fail('abort_not_allowed')
    if (ctx.now < deadline) return fail('first_move_deadline_not_reached')
    return done(finish(state, { reason: 'abort', cause: 'first_move_timeout' }))
  }

  // Everything below is seat-raised: it must carry a seat that holds a colour in
  // this match. `actor === null` here means a runner dispatched a player action
  // as if the server had raised it, which is refused for the same reason.
  const color = actor === null ? null : colorOf(state, actor)
  if (color === null) return fail('not_a_player')

  switch (action.type) {
    case 'move':
      return applyMove(state, action.move, color, ctx)

    case 'resign':
      return done(finish(state, { reason: 'resignation', winner: opponent(color) }))

    case 'abort':
      return canAbort(state)
        ? done(finish(state, { reason: 'abort', cause: 'agreed' }))
        : fail('abort_not_allowed')

    case 'offer_draw':
      return offerDraw(state, color)

    case 'accept_draw':
      // Only the side that did *not* offer can accept.
      return state.drawOffer && state.drawOffer.by !== color
        ? done(finish(state, { reason: 'draw_agreement' }))
        : fail('no_draw_offer')

    case 'decline_draw':
      return state.drawOffer && state.drawOffer.by !== color
        ? done({ ...state, drawOffer: null })
        : fail('no_draw_offer')

    case 'claim_draw':
      return claimDraw(state, action.claim, color)

    case 'claim_abandonment':
      return claimAbandonment(state, action.outcome, color)
  }
}

function applyMove(
  state: ChessMatchState,
  move: MoveInput,
  color: Color,
  ctx: GameContext,
): ChessActionResult {
  const chess = replay(state.initialFen, state.moves)
  if (chess.turn() !== color) return fail('not_your_turn')

  const san = tryMove(chess, move)
  if (san === null) return fail('illegal_move')

  const moves = [...state.moves, san]
  const moved: ChessMatchState = {
    ...state,
    moves,
    phase: moves.length >= 2 ? 'in_play' : 'awaiting_first_move',
    // A move answers a pending offer: it stands until the opponent replies.
    drawOffer: null,
    lastMoveAt: ctx.now,
  }

  const ending = detectAutomaticEnding(analyse(state.initialFen, moves))
  return done(ending ? finish(moved, ending) : moved)
}

function offerDraw(state: ChessMatchState, color: Color): ChessActionResult {
  // One offer pending at a time, from either side.
  if (state.drawOffer !== null) return fail('draw_offer_pending')

  const last = state.lastDrawOfferPly[color]
  if (last !== null && state.moves.length < last + DRAW_OFFER_COOLDOWN_PLIES) {
    return fail('draw_offer_cooldown')
  }

  return done({
    ...state,
    drawOffer: { by: color },
    lastDrawOfferPly: { ...state.lastDrawOfferPly, [color]: state.moves.length },
  })
}

/**
 * Resolve an abandonment claim from `color`, whose opponent has gone.
 *
 * Whether a claim is *available* is a platform fact: presence and the grace
 * period live outside this module, so the runner gates the dispatch (the exact
 * obligation is written down in `sdk/contract.ts`). What the claimant does not
 * get to choose is the *outcome*.
 *
 * A win is only granted to a side that could still deliver mate, by the same
 * FIDE 6.9 material test a flag uses: a lone king whose opponent walked away is
 * no more entitled to the full point than a lone king whose opponent flagged.
 * Such a claimant may still claim a draw — or keep waiting, which is simply not
 * dispatching anything. An unavailable win is refused rather than silently
 * downgraded, so the claimant keeps that choice.
 */
function claimAbandonment(
  state: ChessMatchState,
  requested: 'win' | 'draw',
  color: Color,
): ChessActionResult {
  if (requested === 'draw') return done(finish(state, { reason: 'abandonment_draw' }))

  const { fen } = analyse(state.initialFen, state.moves)
  if (!canPossiblyMate(fen, color)) return fail('claim_unavailable')

  return done(finish(state, { reason: 'abandonment', winner: color }))
}

function claimDraw(state: ChessMatchState, claim: DrawClaim, color: Color): ChessActionResult {
  const position = analyse(state.initialFen, state.moves)
  // FIDE 9.2/9.3: the claim belongs to the player whose turn it is.
  if (position.turn !== color) return fail('not_your_turn')
  if (!availableDrawClaims(position).includes(claim)) return fail('claim_unavailable')

  return done(
    finish(
      state,
      claim === 'threefold_repetition'
        ? { reason: 'threefold_repetition', claimedBy: color }
        : { reason: 'fifty_move_rule', claimedBy: color },
    ),
  )
}
