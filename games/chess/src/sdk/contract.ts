/**
 * The chess module's single point of contact with `@playhall/game-sdk`.
 *
 * Every SDK type the rules layer uses is re-exported from here rather than
 * imported directly across a dozen files. That keeps the blast radius of an SDK
 * contract change to this one file, and it makes the boundary auditable: if
 * chess ever reaches for something the SDK does not export, it shows up here.
 *
 * This file replaces the temporary local shim that stood in while
 * `packages/game-sdk` was being built (PER-10).
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

export { asSeatId, SPECTATOR, seatViewer, viewerSeatId } from '@playhall/game-sdk'

/**
 * Canonical chess scores, so `getResult` and the PGN result token can never
 * disagree. `Standing.score` is game-defined; chess has scored 1 / ½ / 0 for
 * about two centuries.
 */
export const SCORE = { win: 1, draw: 0.5, loss: 0 } as const
