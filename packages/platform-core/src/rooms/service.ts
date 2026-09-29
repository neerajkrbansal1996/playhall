/**
 * The room service: the one place create/join/leave/sweep are sequenced.
 *
 * Everything it composes is pure and tested on its own — the code generator,
 * the join matrix, the lifecycle rules, the limiters. What lives here is the
 * *order*, and the order is where the security properties are:
 *
 * 1. The failed-join cap is checked **before** the room lookup, so a blocked
 *    IP cannot use the response to learn whether a code exists.
 * 2. Settings are validated against the game's own schema **before** a room
 *    exists, so a room can never hold settings its game would reject.
 * 3. Seat count comes from the manifest, never from the request.
 * 4. Writes go through compare-and-set, so a lost update is detected rather
 *    than silently applied.
 */

import { z } from 'zod'
import type { JsonValue } from '@playhall/game-sdk'
import type { FeatureFlags } from '../flags.js'
import type { GameRegistry } from '../registry/registry.js'
import {
  DEFAULT_RATE_LIMITS,
  type RateLimitPolicies,
  rateLimitKey,
} from '../rate-limit/policies.js'
import { type FailedJoinGuard, createFailedJoinGuard } from '../rate-limit/failed-join-guard.js'
import { type RateLimiter, createTokenBucketLimiter } from '../rate-limit/token-bucket.js'
import type { Clock, IdSource, RandomSource } from '../runtime.js'
import { allocateRoomCode } from './code.js'
import {
  DEFAULT_ROOM_LIFECYCLE,
  type RoomLifecyclePolicy,
  evaluateRoomLifecycle,
} from './lifecycle.js'
import {
  type JoinOutcome,
  type JoinRejectionCode,
  applyJoin,
  canonicalizeRoomCode,
  rejectJoin,
  resolveJoin,
} from './join.js'
import type { RoomStore } from './store.js'
import type { Room, RoomCloseReason } from './types.js'

/** Server-side validation of the create-room request body. */
export const createRoomRequestSchema = z.object({
  slug: z.string().min(1).max(64),
  visibility: z.enum(['private', 'public']).default('private'),
  /** Optional; the game's default settings are used when absent. */
  settings: z.unknown().optional(),
  /** Preset id from the manifest. Mutually exclusive with `settings`. */
  presetId: z.string().min(1).optional(),
})
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>

export type CreateRoomFailure =
  | { readonly code: 'rate_limited'; readonly retryAfterMs: number }
  | { readonly code: 'game_unavailable' }
  | { readonly code: 'invalid_settings'; readonly problems: readonly string[] }
  | { readonly code: 'public_listing_disabled' }
  | { readonly code: 'code_exhausted' }

export type CreateRoomResult =
  | { readonly ok: true; readonly room: Room }
  | { readonly ok: false; readonly error: CreateRoomFailure }

export interface JoinByCodeRequest {
  readonly rawCode: string
  readonly playerId: string
  /** Server-observed peer address. Never read from a header a client controls. */
  readonly ip: string
}

export type JoinResult =
  | { readonly ok: true; readonly room: Room; readonly outcome: JoinOutcome }
  | {
      readonly ok: false
      readonly code: JoinRejectionCode
      readonly terminal: boolean
      readonly retryAfterMs: number
    }

export interface SweepReport {
  readonly expired: number
  readonly closed: number
  readonly prunedLimiterKeys: number
}

export interface RoomServiceOptions {
  readonly store: RoomStore
  readonly registry: GameRegistry
  readonly flags: FeatureFlags
  readonly clock: Clock
  readonly random: RandomSource
  readonly ids: IdSource
  readonly lifecycle?: RoomLifecyclePolicy
  readonly limits?: RateLimitPolicies
}

export interface RoomService {
  create(playerId: string, request: CreateRoomRequest): Promise<CreateRoomResult>
  joinByCode(request: JoinByCodeRequest): Promise<JoinResult>
  /** Marks a player disconnected. Arms the empty timer when the room empties. */
  leave(roomId: string, playerId: string): Promise<Room | null>
  /** Records the end of a match and opens the rematch window. */
  finishMatch(roomId: string, matchId: string): Promise<Room | null>
  /** Applies every due lifecycle deadline. Call on an interval. */
  sweep(limit?: number): Promise<SweepReport>
  /** Public rooms, or `[]` while the `publicRoomListing` flag is off. */
  listPublic(limit?: number): Promise<readonly Room[]>
}

/**
 * Compare-and-set retry budget. Contention on one room is bounded by its seat
 * count, so a handful of attempts covers a real race; anything beyond that is
 * a failing store, and failing loudly beats spinning.
 */
const CAS_ATTEMPTS = 4
const CAS_BACKOFF_MS = 50

export function createRoomService(options: RoomServiceOptions): RoomService {
  const { store, registry, flags, clock, random, ids } = options
  const lifecycle = options.lifecycle ?? DEFAULT_ROOM_LIFECYCLE
  const limits = options.limits ?? DEFAULT_RATE_LIMITS

  const createLimiter: RateLimiter = createTokenBucketLimiter(limits.roomCreate, clock)
  const joinLimiter: RateLimiter = createTokenBucketLimiter(limits.roomJoin, clock)
  const failedJoins: FailedJoinGuard = createFailedJoinGuard(clock, limits.failedCodeJoinPerIp)

  async function create(playerId: string, request: CreateRoomRequest): Promise<CreateRoomResult> {
    const gate = createLimiter.consume(rateLimitKey.roomCreate(playerId))
    if (!gate.allowed) {
      return { ok: false, error: { code: 'rate_limited', retryAfterMs: gate.retryAfterMs } }
    }

    if (request.visibility === 'public' && !flags.isEnabled('publicRoomListing')) {
      return { ok: false, error: { code: 'public_listing_disabled' } }
    }

    const module = registry.module(request.slug)
    if (module === null || !registry.isPlayable(request.slug)) {
      return { ok: false, error: { code: 'game_unavailable' } }
    }
    const { manifest } = module

    let candidate: unknown
    if (request.presetId !== undefined) {
      const preset = manifest.presets.find((entry) => entry.id === request.presetId)
      if (preset === undefined) {
        return {
          ok: false,
          error: { code: 'invalid_settings', problems: [`unknown preset '${request.presetId}'`] },
        }
      }
      candidate = preset.settings
    } else {
      candidate = request.settings ?? manifest.defaultSettings
    }

    const parsed = manifest.settingsSchema.safeParse(candidate)
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'invalid_settings',
          problems: parsed.error.issues.map(
            (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          ),
        },
      }
    }

    const now = clock.now()
    const roomId = ids.newId()
    let code: string
    try {
      code = (await allocateRoomCode(random, (draw) => store.reserveCode(draw, roomId))).code
    } catch {
      return { ok: false, error: { code: 'code_exhausted' } }
    }

    const room: Room = {
      id: roomId,
      code,
      gameId: manifest.id,
      gameSlug: manifest.slug,
      gameVersion: manifest.version,
      hostPlayerId: playerId,
      visibility: request.visibility,
      status: 'lobby',
      settings: parsed.data as JsonValue,
      // Seat count is the manifest's, never the request's. A client that could
      // choose it could start a two-player game with eleven seats.
      seats: Array.from({ length: manifest.maxPlayers }, (_, index) => ({
        index,
        occupantPlayerId: index === 0 ? playerId : null,
      })),
      spectatorPlayerIds: [],
      presentPlayerIds: [playerId],
      createdAt: now,
      updatedAt: now,
      secondPlayerJoinedAt: null,
      emptySince: null,
      finishedAt: null,
      closedAt: null,
      closeReason: null,
      currentMatchId: null,
    }

    await store.insert(room)
    return { ok: true, room }
  }

  async function joinByCode(request: JoinByCodeRequest): Promise<JoinResult> {
    const { rawCode, playerId, ip } = request

    // Order matters: the IP cap is consulted before anything that could reveal
    // whether the code exists.
    if (!failedJoins.allow(ip)) {
      return {
        ok: false,
        code: 'too_many_failed_joins',
        terminal: false,
        retryAfterMs: failedJoins.retryAfterMs(ip),
      }
    }

    const gate = joinLimiter.consume(rateLimitKey.roomJoin(playerId))
    if (!gate.allowed) {
      return { ok: false, code: 'rate_limited', terminal: false, retryAfterMs: gate.retryAfterMs }
    }

    const code = canonicalizeRoomCode(rawCode)
    if (code === null) return fail(ip, rejectJoin('invalid_code'))

    // The rate-limit token is spent once, above. Contention retries re-read
    // and re-resolve but must never charge the player again.
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const room = await store.getByCode(code)
      const outcome = resolveJoin({
        room,
        playerId,
        game: room === null ? null : registry.entryById(room.gameId),
        now: clock.now(),
        lifecycle,
      })
      if (outcome.kind === 'rejected') return fail(ip, outcome)

      // Non-null here: `resolveJoin` rejects a null room.
      const previous = room as Room
      const next = applyJoin(previous, playerId, outcome, clock.now())
      if (await store.save(previous, next)) {
        failedJoins.recordSuccess(ip)
        return { ok: true, room: next, outcome }
      }
      // Lost the race for the last seat. Re-resolving against fresh state is
      // the correct answer — the loser becomes a spectator rather than
      // overwriting the winner.
    }

    return { ok: false, code: 'rate_limited', terminal: false, retryAfterMs: CAS_BACKOFF_MS }
  }

  function fail(ip: string, outcome: Extract<JoinOutcome, { kind: 'rejected' }>): JoinResult {
    if (outcome.terminal) failedJoins.recordFailure(ip)
    return { ok: false, code: outcome.code, terminal: outcome.terminal, retryAfterMs: 0 }
  }

  /** Read-modify-write with bounded compare-and-set retries. */
  async function mutate(
    roomId: string,
    change: (room: Room, now: number) => Room,
  ): Promise<Room | null> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const room = await store.get(roomId)
      if (room === null) return null
      const next = change(room, clock.now())
      if (await store.save(room, next)) return next
    }
    return null
  }

  async function leave(roomId: string, playerId: string): Promise<Room | null> {
    return mutate(roomId, (room, now) => {
      const present = room.presentPlayerIds.filter((id) => id !== playerId)
      return {
        ...room,
        presentPlayerIds: present,
        // Leaving does not vacate a seat: the seat is held for reconnection.
        // Freeing it is a host action and belongs to PER-13.
        spectatorPlayerIds: room.spectatorPlayerIds.filter((id) => id !== playerId),
        emptySince: present.length === 0 ? (room.emptySince ?? now) : null,
        updatedAt: now,
      }
    })
  }

  async function finishMatch(roomId: string, matchId: string): Promise<Room | null> {
    return mutate(roomId, (room, now) => ({
      ...room,
      status: 'finished',
      finishedAt: now,
      currentMatchId: matchId,
      updatedAt: now,
    }))
  }

  async function sweep(limit = 200): Promise<SweepReport> {
    const now = clock.now()
    const due = await store.dueForSweep(now, limit)
    let expired = 0
    let closed = 0

    for (const room of due) {
      const verdict = evaluateRoomLifecycle(room, now, lifecycle)
      if (verdict.action === 'keep') continue

      const reason: RoomCloseReason = verdict.reason
      const next: Room = {
        ...room,
        status: 'closed',
        closedAt: now,
        closeReason: reason,
        presentPlayerIds: [],
        updatedAt: now,
      }
      if (!(await store.save(room, next))) continue

      // The room object goes; the match record does not. Match history lives
      // in Postgres and is never touched by room expiry.
      await store.remove(room.id)
      if (verdict.action === 'expire') expired += 1
      else closed += 1
    }

    const prunedLimiterKeys = createLimiter.prune() + joinLimiter.prune() + failedJoins.prune()
    return { expired, closed, prunedLimiterKeys }
  }

  async function listPublic(limit = 50): Promise<readonly Room[]> {
    if (!flags.isEnabled('publicRoomListing')) return []
    return store.listPublic(limit)
  }

  return { create, joinByCode, leave, finishMatch, sweep, listPublic }
}
