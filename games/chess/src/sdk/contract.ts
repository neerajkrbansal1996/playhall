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
  MatchResultProblem,
  ResultReason,
  SeatId,
  SeatOutcome,
  Standing,
  Viewer,
} from '@playhall/game-sdk'

/**
 * The unrecorded-result contract (ADR-0006).
 *
 * `isRecordedResult` is the single answer to "did this match count", derived by
 * the SDK from `reason`. Chess does not author that flag: the platform owns the
 * fact, and two sources of truth with no tiebreak is how a player ends up with
 * a phantom win on an aborted game.
 *
 * `unrecordedStandings()` is the empty standings array for those reasons, named
 * so the abort path reads as a decision rather than an oversight.
 */
export { isRecordedResult, unrecordedStandings, validateMatchResult } from '@playhall/game-sdk'

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
