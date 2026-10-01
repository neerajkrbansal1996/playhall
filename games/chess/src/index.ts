/**
 * `games/chess` — the chess game module.
 *
 * `manifest` and `server` are the SDK surface: everything the platform needs,
 * and everything `@playhall/game-testkit`'s conformance suite is pointed at. The
 * loose rules functions below them stay exported because chess's own 250-odd
 * rules tests drive them directly, which is much cheaper than routing every FEN
 * through the reducer contract.
 *
 * Boundary note: this package imports from `chess.js`, `zod`,
 * `@playhall/game-sdk` and itself. It imports nothing else from the platform,
 * and `src/sdk/contract.ts` is its single point of contact with the SDK for the
 * rules layer.
 *
 * Nothing here reads `Date.now()` or `Math.random()`. Time comes from `ctx.now`
 * and randomness from `ctx.rng`, both supplied by the server.
 */

export {
  chessActionSchema,
  chessManifest as manifest,
  chessServer as server,
  chessStateSchema,
  CHESS_CLOCK_TIMER,
  FIRST_MOVE_TIMER,
  type ChessClientAction,
  type ChessEvent,
} from './module.js'

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
