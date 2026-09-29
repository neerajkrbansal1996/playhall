/**
 * `games/chess` — the chess game module.
 *
 * Boundary note: this package imports from `chess.js`, `zod`, and itself. It
 * imports nothing from the platform. The two files under `src/sdk/` are local
 * shims standing in for `packages/game-sdk` until PER-10 lands; see the header
 * comments in those files for exactly what the SDK needs to export.
 *
 * Nothing here reads `Date.now()` or `Math.random()`. Time comes from `ctx.now`
 * and randomness from `ctx.rng`, both supplied by the server.
 */

export { exportRecord, type RecordOptions } from './record.js'
export { getResult, scoreLine, terminationText, type ScoreLine } from './result.js'
export { getViewFor, type CapturedPieces, type ChessView } from './view.js'

export {
  applyAction,
  canAbort,
  colorOf,
  firstMoveDeadline,
  setup,
  turnOf,
  DRAW_OFFER_COOLDOWN_PLIES,
  FIRST_MOVE_TIMEOUT_MS,
  type ChessAction,
  type ChessActionError,
  type ChessActionResult,
  type ChessMatchState,
  type SetupInput,
} from './state.js'

export {
  availableDrawClaims,
  detectAutomaticEnding,
  endingAfter,
  timeoutEnding,
  FIFTY_MOVE_PLIES,
  FIVEFOLD_REPETITION,
  SEVENTY_FIVE_MOVE_PLIES,
  THREEFOLD_REPETITION,
} from './rules/endings.js'

export {
  canPossiblyMate,
  countMaterial,
  materialDifference,
  type MaterialCount,
} from './rules/material.js'

export {
  analyse,
  parseMoveInput,
  repetitionKey,
  replay,
  tryMove,
  START_FEN,
  type PositionInfo,
} from './rules/position.js'

export {
  opponent,
  BLACK,
  WHITE,
  type ChessEnding,
  type Color,
  type ColorAssignment,
  type DrawClaim,
  type EndingReason,
  type MoveInput,
  type PromotionPiece,
} from './rules/types.js'

export * from './settings/index.js'
