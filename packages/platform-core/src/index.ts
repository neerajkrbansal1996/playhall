/**
 * `@playhall/platform-core` — guest identity, game registry, rooms, seats, ready
 * checks, chat, presence, spectating, reconnection, timers, match log.
 *
 * Hard rule: nothing here may know about a specific game. Games are loaded
 * through the registry, which receives dynamic-import thunks from the
 * composition root; the platform never imports a game package, not even
 * dynamically (ADR-0002 §3).
 */

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@playhall/shared'
import { ROOM_CODE_SPACE } from './rooms/code.js'

export * from './identity/index.js'

export const PLATFORM_CORE_VERSION = '0.0.0'

export function platformBuildInfo(): { platformCore: string; roomCodeSpace: number } {
  return { platformCore: PLATFORM_CORE_VERSION, roomCodeSpace: ROOM_CODE_SPACE }
}

export { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH }

export type { Clock, IdSource, MutableClock, RandomSource } from './runtime.js'
export {
  countingIdSource,
  fixedClock,
  randomIdSource,
  sequenceRandomSource,
  tickingClock,
  webCryptoRandomSource,
} from './runtime.js'

export type { FeatureFlagOverrides, FeatureFlags, PlatformFlagName } from './flags.js'
export { PLATFORM_FLAGS, createFeatureFlags, flagOverridesFromEnv } from './flags.js'

export type {
  CreateRegistryOptions,
  GameRegistration,
  GameRegistry,
  ListOptions,
  RegistryProblem,
} from './registry/registry.js'
export { RegistryLoadError, createGameRegistry } from './registry/registry.js'

export type { RoomCodeAllocation } from './rooms/code.js'
export {
  ROOM_CODE_SPACE,
  RoomCodeExhaustionError,
  RoomCodeSourceError,
  allocateRoomCode,
  generateRoomCode,
  isValidRoomCode,
} from './rooms/code.js'

export type {
  Room,
  RoomCloseReason,
  RoomRevision,
  RoomSeatSlot,
  RoomStatus,
  RoomVisibility,
  SeatReservation,
} from './rooms/types.js'
export {
  emptySeat,
  freeSeatIndex,
  isRoomMember,
  isRoomTerminal,
  occupiedSeats,
  reviseRoom,
  seatIndexOf,
  seatReady,
  seatedPlayerIds,
} from './rooms/types.js'

export type {
  GuardedChange,
  GuardedMutationResult,
  RoomWriter,
  RoomWriterOptions,
} from './rooms/mutate.js'
export { CAS_ATTEMPTS, CAS_BACKOFF_MS, createRoomWriter } from './rooms/mutate.js'

export type { RoomLifecycleAction, RoomLifecyclePolicy } from './rooms/lifecycle.js'
export {
  DEFAULT_ROOM_LIFECYCLE,
  evaluateRoomLifecycle,
  nextRoomDeadline,
  roomDeadlines,
  roomKeyTtlMs,
  sameRoomLifecyclePolicy,
} from './rooms/lifecycle.js'

export type { JoinOutcome, JoinRejectionCode, ResolveJoinInput } from './rooms/join.js'
export {
  JOIN_REJECTION_CODES,
  applyJoin,
  canonicalizeRoomCode,
  chargesFailedJoinBudget,
  isTerminalRejection,
  rejectJoin,
  resolveJoin,
} from './rooms/join.js'

export type {
  BindRealtimeRoomFailure,
  BindRealtimeRoomResult,
  PublicRoomSummary,
  RealtimeBindingDecision,
  RealtimeJoinTarget,
} from './rooms/realtime-binding.js'
export {
  decideRealtimeBinding,
  publicRoomSummary,
  realtimeJoinTarget,
} from './rooms/realtime-binding.js'

export type { RoomStore } from './rooms/store.js'
export { createInMemoryRoomStore } from './rooms/store.js'

/* Seats, teams, host controls, ready checks, start rules, rematch (PER-13). */

export type {
  LateJoinMode,
  RematchRotation,
  SeatingDeclarations,
  SeatingPolicy,
  StartMode,
  TeamMode,
} from './seats/policy.js'
export {
  AUTO_START_COUNTDOWN_MS,
  LATE_JOIN_MODES,
  REMATCH_ROTATIONS,
  START_MODES,
  seatingPolicyFor,
  teamIdsFor,
} from './seats/policy.js'

export {
  assignTeams,
  isBalanced,
  moveToTeam,
  rotateOccupants,
  targetTeamSizes,
  teamSizes,
} from './seats/teams.js'

export type { HostActionRejection } from './seats/host.js'
export {
  HOST_ACTION_REJECTIONS,
  canCloseLobby,
  canKick,
  canTransferHost,
  hostSuccessionRevision,
  isHost,
  resolveAbsentHostTransfer,
  resolveHostSuccession,
} from './seats/host.js'

export {
  assignSeat,
  clearReady,
  readyAll,
  reserveSeatForBot,
  seatAt,
  setPlayerReady,
  swapSeats,
  vacatePlayer,
  vacateSeat,
} from './seats/seating.js'

export type {
  AutoStartDecision,
  HostStartResolution,
  SeatingSnapshot,
  StartBlockReason,
} from './seats/start.js'
export {
  START_BLOCK_REASONS,
  evaluateAutoStart,
  resolveHostStart,
  seatingSnapshot,
  startBlockers,
} from './seats/start.js'

export type { RematchRejection, RematchResolution, RematchTally } from './seats/rematch.js'
export {
  REMATCH_REJECTIONS,
  rematchRevision,
  resolveRematch,
  sameSeatsRematchRevision,
  tallyRematch,
  withRematchVote,
  withoutRematchVote,
} from './seats/rematch.js'

export type { RoomView, SeatView, ViewerKind } from './seats/view.js'
export { roomViewFor, viewerKindFor } from './seats/view.js'

export type { BotIdentity, BotSeatProvider, BotSlotOutcome, BotSlotRequest } from './seats/bots.js'
export { BOT_SEAT_PROVIDERS, resolveBotProvider } from './seats/bots.js'

export type {
  SeatMutationOutcome,
  SeatMutationResult,
  SeatRefusal,
  SeatService,
  SeatServiceOptions,
} from './seats/service.js'
export { createSeatService } from './seats/service.js'

export type {
  CreateRoomFailure,
  CreateRoomRequest,
  CreateRoomResult,
  JoinByCodeRequest,
  JoinResult,
  RoomMutationFailure,
  RoomMutationResult,
  RoomService,
  RoomServiceOptions,
  SweepReport,
} from './rooms/service.js'
export { createRoomRequestSchema, createRoomService } from './rooms/service.js'

export type {
  RateLimitDecision,
  RateLimiter,
  TokenBucketPolicy,
} from './rate-limit/token-bucket.js'
export { createTokenBucketLimiter } from './rate-limit/token-bucket.js'
export type { RateLimitPolicies } from './rate-limit/policies.js'
export { DEFAULT_RATE_LIMITS, rateLimitKey } from './rate-limit/policies.js'
export type { FailedJoinGuard } from './rate-limit/failed-join-guard.js'
export { createFailedJoinGuard } from './rate-limit/failed-join-guard.js'

export type { ParsedRoute } from './routing/routes.js'
export { ROUTE_PATTERNS, absoluteUrl, parseRoute, routes } from './routing/routes.js'
export type { SitemapEntry } from './routing/sitemap.js'
export { buildRobotsTxt, buildSitemap } from './routing/sitemap.js'
