/**
 * `@playhall/game-sdk` — the only package a game may import.
 *
 * A game imports from here and from third-party libraries. Never from
 * `@playhall/platform-core`, never from `apps/*`, never from another game. CI
 * fails the build on a violation.
 *
 * See `README.md` for the contract walkthrough and the purity rules.
 */

export type { JsonObject, JsonPrimitive, JsonValue, JsonSafe, AssertJsonSafe } from './json.js'

export type {
  Branded,
  GameId,
  MatchId,
  MatchSeed,
  PlayerId,
  SeatId,
  TeamId,
  TimerId,
} from './ids.js'
export {
  asGameId,
  asMatchId,
  asMatchSeed,
  asPlayerId,
  asSeatId,
  asTeamId,
  asTimerId,
} from './ids.js'

export type { Rng } from './rng.js'
export { createContextRng, createMatchSeed, createRng, deriveSeed } from './rng.js'

export type { GameContext, GameContextInit, RealtimeContext } from './context.js'
export { FORBIDDEN_GLOBALS_IN_GAMES, createGameContext, createRealtimeContext } from './context.js'

export type {
  ActionError,
  MigrationError,
  Result,
  StandardActionErrorCode,
  ValidationResult,
} from './errors.js'
export {
  STANDARD_ACTION_ERROR_CODES,
  VALID,
  err,
  invalid,
  isStandardActionErrorCode,
  ok,
} from './errors.js'

export type { EventAudience, GameEvent } from './events.js'
export {
  PUBLIC,
  SERVER_ONLY,
  SPECTATORS_ONLY,
  audienceIncludesSeat,
  audienceIncludesSpectators,
  toSeats,
} from './events.js'

export type { Seat, SeatOccupant, SeatRoster, TeamMode } from './seats.js'
export { findSeat, seatIds, teamSeats } from './seats.js'

export type { TimerCommand, TimerKind, TimerSpec } from './timers.js'
export { clearTimer, pauseTimer, resumeTimer, setTimer } from './timers.js'

export type { Viewer } from './viewer.js'
export { REPLAY, SPECTATOR, seatViewer, viewerSeatId } from './viewer.js'

export type { MatchResult, ResultReason, SeatOutcome, Standing } from './result.js'
export { RESULT_REASONS, drawStandings, standingsFromWinners } from './result.js'

export type { DisconnectAction, DisconnectPolicy, DisconnectReason } from './disconnect.js'
export { DEFAULT_DISCONNECT_POLICY } from './disconnect.js'

export type { MatchRecord } from './record.js'

export type {
  GameCatalogEntry,
  GameCategory,
  GameManifest,
  GameStatus,
  MinClientSpec,
  RealtimeProfile,
  SettingsPreset,
  SupportedInput,
  TeamModeName,
  TurnModel,
  ManifestProblem,
} from './manifest.js'
export {
  GAME_CATEGORIES,
  GAME_STATUSES,
  SUPPORTED_INPUTS,
  TEAM_MODES,
  TURN_MODELS,
  gameManifestSchema,
  minClientSpecSchema,
  realtimeProfileSchema,
  supportsPlayerCount,
  toCatalogEntry,
  validateManifest,
} from './manifest.js'

export type { Semver, VersionPin, VersionPinFailure } from './versioning.js'
export {
  SDK_CONTRACT_VERSION,
  SDK_VERSION,
  checkVersionPin,
  compareSemver,
  isContractSupported,
  isSemver,
  parseSemver,
} from './versioning.js'

export type {
  AnyTurnBasedGameServer,
  ApplyResult,
  TurnBasedActionError,
  TurnBasedGameDefinition,
  TurnBasedGameServer,
} from './turn-based.js'

export type { BinaryCodec, BinaryReader, BinaryWriter } from './binary.js'
export type {
  AnyRealtimeGameServer,
  RealtimeGameDefinition,
  RealtimeGameServer,
  SnapshotOptions,
  TickResult,
} from './realtime.js'

export type {
  AnyRealtimeClientModule,
  AnyTurnBasedClientModule,
  GameComponent,
  GameSceneProps,
  GameViewProps,
  HUDProps,
  HowToPlayProps,
  LazyComponent,
  RealtimeClientModule,
  ResultPanelProps,
  ReviewMode,
  SeatView,
  SettingsFormProps,
  SoundAsset,
  SoundMap,
  TimerView,
  TurnBasedClientModule,
} from './client.js'

export type { AnyGameModule, RealtimeGameModule, TurnBasedGameModule } from './define.js'
export {
  GameDefinitionError,
  defineRealtimeGame,
  defineTurnBasedGame,
  isRealtimeModule,
  isTurnBasedModule,
} from './define.js'
