/**
 * The chess module's single point of contact with `@playhall/game-sdk`.
 *
 * Every SDK type the rules layer uses is re-exported from here rather than
 * imported directly across a dozen files. That keeps the blast radius of an SDK
 * contract change to this one file, and it makes the boundary auditable: if
 * chess ever reaches for something the SDK does not export, it shows up here.
 *
 * This file replaces the temporary local shims that stood in while
 * `packages/game-sdk` was being built: the rules half (PER-10), and the
 * settings-form half (PER-24), which the SDK exports now that ADR-0007 has
 * landed.
 */

export type {
  GameContext,
  MatchRecord,
  MatchResult,
  ResultReason,
  SeatId,
  SeatOutcome,
  Standing,
  Viewer,
} from '@playhall/game-sdk'

/**
 * The create-lobby form descriptor (ADR-0007). Presentation metadata only —
 * `chessSettingsSchema` stays the sole authority on what a lobby may hold.
 */
export type {
  FieldVisibility,
  NumberField,
  SelectField,
  SelectOption,
  SettingsField,
  SettingsFormDescriptor,
  ToggleField,
} from '@playhall/game-sdk'

export { asSeatId, SPECTATOR, seatViewer, viewerSeatId } from '@playhall/game-sdk'

/**
 * Canonical chess scores, so `getResult` and the PGN result token can never
 * disagree. `Standing.score` is game-defined; chess has scored 1 / ½ / 0 for
 * about two centuries.
 */
export const SCORE = { win: 1, draw: 0.5, loss: 0 } as const

/**
 * ## Runner obligations: what the platform must establish before dispatching
 *
 * `applyAction(state, action, actor, ctx)` splits its input two ways, and the
 * split is enforced in the reducer, not merely documented here:
 *
 *  - **seat-raised** — `actor` is the *authenticated* seat the action arrived
 *    from. Never a seat id copied out of a client message. `actor: null` on one
 *    of these is refused with `not_a_player`.
 *  - **server-raised** — `actor` is `null`, because the platform raised the
 *    action from a fact the game module cannot see. A non-null `actor` on one of
 *    these is refused with `not_a_player`, so forwarding a client envelope
 *    straight into the reducer cannot end a match.
 *
 * Refusing the wrong shape is all the module can do on its own. Three actions
 * additionally depend on facts that only the platform holds, and those facts are
 * the runner's obligation to establish *before* dispatch:
 *
 * ### `{ type: 'flag', color }` — server-raised
 *
 * Dispatch only from the clock service, and only when the per-player clock for
 * `color` has actually reached zero — after crediting the increment for the move
 * `color` last completed, and only for a match whose time control is not "No
 * clock". The reducer performs **no** clock check of any kind: this state has no
 * clock in it, and the FEN cannot tell you whose time expired. A runner that
 * lets a client reach this action with `actor: null` hands out instant wins at
 * move 1. Never derive `color` from a client message either — a flag is about
 * whose clock ran out, not about who reported it.
 *
 * ### `{ type: 'first_move_timeout' }` — server-raised
 *
 * Dispatch from the timer service when the 30 s first-move window elapses. This
 * one is self-checking: the reducer re-derives the deadline from `startedAt` /
 * `lastMoveAt` and refuses an early call with `first_move_deadline_not_reached`,
 * or a late one with `abort_not_allowed` once both players have moved. The
 * runner's only obligation is not to attribute it to a seat.
 *
 * ### `{ type: 'claim_abandonment', outcome }` — seat-raised
 *
 * Dispatch only when **all** of these hold, or the claimant wins by walking
 * away from a game they were losing:
 *
 *  1. the *opponent* of `actor` has had no live session for the match — no
 *     transport connection and no reconnection — continuously for at least the
 *     platform's disconnect grace period, measured against `ctx.now`;
 *  2. `actor` is the authenticated claiming seat, and it is the seat that is
 *     still present. A claim on behalf of the absent side is not a thing;
 *  3. the claim came from a player action, not from a timer — presence is not a
 *     clock, and there is no server-raised form of this action.
 *
 * The reducer checks that `actor` holds a colour in this match, and that a
 * requested `win` is materially possible (FIDE 6.9 — a lone king gets a draw or
 * nothing, never the full point). It cannot check presence at all, so an unmet
 * obligation above is indistinguishable from a legitimate claim.
 */
