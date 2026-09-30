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
import { RoomCodeExhaustionError, allocateRoomCode } from './code.js'
import {
  type RoomLifecyclePolicy,
  evaluateRoomLifecycle,
  sameRoomLifecyclePolicy,
} from './lifecycle.js'
import {
  type JoinOutcome,
  type JoinRejectionCode,
  applyJoin,
  canonicalizeRoomCode,
  chargesFailedJoinBudget,
  rejectJoin,
  resolveJoin,
} from './join.js'
import {
  type BindRealtimeRoomResult,
  type PublicRoomSummary,
  type RealtimeJoinTarget,
  decideRealtimeBinding,
  publicRoomSummary,
  realtimeJoinTarget,
} from './realtime-binding.js'
import type { RoomStore } from './store.js'
import {
  type Room,
  type RoomCloseReason,
  type RoomRevision,
  isRoomTerminal,
  reviseRoom,
} from './types.js'

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
  | {
      readonly ok: true
      readonly room: Room
      readonly outcome: JoinOutcome
      /**
       * Where to go next: the framework handle plus the seat this join won.
       * `ok: false` here means the join succeeded but the realtime room is not
       * up yet — the client holds its place and retries, it never guesses.
       */
      readonly realtime: RealtimeJoinTarget
    }
  | {
      readonly ok: false
      readonly code: JoinRejectionCode
      readonly terminal: boolean
      readonly retryAfterMs: number
    }

export interface SweepReport {
  readonly expired: number
  readonly closed: number
  /** Tombstones whose grace window elapsed. Their codes are now free again. */
  readonly removed: number
  readonly prunedLimiterKeys: number
}

export type RoomMutationFailure =
  | { readonly code: 'room_not_found' }
  /**
   * The room exists but has closed, so it can no longer be revised. Separate
   * from `room_not_found` because the room is still readable for the length of
   * its tombstone window and the caller's correct response differs: tear the
   * session down and tell the players the room is over, rather than retrying or
   * reporting a bad link. See `isRoomTerminal`.
   */
  | { readonly code: 'room_closed'; readonly closeReason: RoomCloseReason | null }
  /**
   * The room is alive and the change is legal, but the compare-and-set retry
   * budget ran out. Distinct from `room_not_found` because the caller's
   * correct response is the opposite one: retry, do not conclude the room is
   * gone. A `finishMatch` that reported contention as "not found" would leave
   * a room `in_progress` with no `finishedAt` — and `roomDeadlines` arms
   * nothing for that state, so the room would never be swept and the players
   * would sit in a match that silently never ended.
   */
  | { readonly code: 'contended'; readonly retryAfterMs: number }

export type RoomMutationResult =
  | { readonly ok: true; readonly room: Room }
  | { readonly ok: false; readonly error: RoomMutationFailure }

export interface RoomServiceOptions {
  readonly store: RoomStore
  readonly registry: GameRegistry
  readonly flags: FeatureFlags
  readonly clock: Clock
  readonly random: RandomSource
  readonly ids: IdSource
  /**
   * Defaults to the store's own policy, which is the single source of truth.
   * Pass it only to assert agreement: a value that differs from
   * `store.lifecycle` throws at construction rather than half-applying.
   */
  readonly lifecycle?: RoomLifecyclePolicy
  readonly limits?: RateLimitPolicies
}

export interface RoomService {
  create(playerId: string, request: CreateRoomRequest): Promise<CreateRoomResult>
  joinByCode(request: JoinByCodeRequest): Promise<JoinResult>
  /** Marks a player disconnected. Arms the empty timer when the room empties. */
  leave(roomId: string, playerId: string): Promise<RoomMutationResult>
  /** Records the end of a match and opens the rematch window. */
  finishMatch(roomId: string, matchId: string): Promise<RoomMutationResult>
  /** Applies every due lifecycle deadline. Call on an interval. */
  sweep(limit?: number): Promise<SweepReport>
  /**
   * Binds the realtime framework's room handle to this platform room. Called
   * by the realtime service once, after it creates the backing room.
   * Idempotent for the same handle; refuses a different one.
   */
  bindRealtimeRoom(roomId: string, realtimeRoomId: string): Promise<BindRealtimeRoomResult>
  /**
   * The realtime handle for a player already admitted to this room. The only
   * sanctioned way to obtain it — see `realtimeJoinTarget`.
   */
  realtimeTarget(roomId: string, playerId: string): Promise<RealtimeJoinTarget>
  /**
   * Public rooms, or `[]` while the `publicRoomListing` flag is off. Returns
   * summaries, never rooms: a listing must not hand out a join capability.
   */
  listPublic(limit?: number): Promise<readonly PublicRoomSummary[]>
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
  // One policy, taken from the store, because the store is the half that cannot
  // be handed one per call — it scores and expires keys at write time. A caller
  // that passes a different policy is wired wrong in a way that would otherwise
  // present as "lifecycle timers configured but nothing ever sweeps", so it
  // fails here, loudly, at startup.
  const lifecycle = options.lifecycle ?? store.lifecycle
  if (!sameRoomLifecyclePolicy(lifecycle, store.lifecycle)) {
    throw new TypeError(
      'createRoomService: options.lifecycle disagrees with store.lifecycle. ' +
        'The store scores sweep candidates and key TTLs under its own policy, so a ' +
        'mismatch silently disables the lifecycle timers. Construct the store with ' +
        'the same policy, or omit options.lifecycle and let the store supply it.',
    )
  }
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
    } catch (error) {
      // Only saturation is a request-level answer. A `RoomCodeSourceError` —
      // the entropy source itself misbehaving — is a server fault and must
      // propagate rather than be dressed up as "we ran out of codes".
      if (!(error instanceof RoomCodeExhaustionError)) throw error
      return { ok: false, error: { code: 'code_exhausted' } }
    }

    const room: Room = {
      id: roomId,
      code,
      // First revision. From here every write goes through `reviseRoom`.
      version: 1,
      // The realtime service binds its own handle once the backing room exists.
      // The platform room is usable (shareable, chattable) before that happens.
      realtimeRoomId: null,
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
        return { ok: true, room: next, outcome, realtime: realtimeJoinTarget(next, playerId) }
      }
      // Lost the race for the last seat. Re-resolving against fresh state is
      // the correct answer — the loser becomes a spectator rather than
      // overwriting the winner.
    }

    // Contention, not rate limiting. The player's join token was spent once,
    // above, and every retry since was the store's fault rather than theirs.
    return { ok: false, code: 'contended', terminal: false, retryAfterMs: CAS_BACKOFF_MS }
  }

  function fail(ip: string, outcome: Extract<JoinOutcome, { kind: 'rejected' }>): JoinResult {
    // Charged on evidence of *guessing*, not on whether the answer is final.
    // A code for a room that has just closed is a real code held by someone
    // who was invited — see `chargesFailedJoinBudget`.
    if (chargesFailedJoinBudget(outcome.code)) failedJoins.recordFailure(ip)
    return { ok: false, code: outcome.code, terminal: outcome.terminal, retryAfterMs: 0 }
  }

  /**
   * Read-modify-write with bounded compare-and-set retries.
   *
   * Two refusals that every mutation gets for free by going through here:
   *
   * - A **closed** room is never revised. The guard is inside the retry loop,
   *   not before it, because a room can close between attempts — the sweeper
   *   runs concurrently with every one of these calls.
   * - Exhausting the retry budget is `contended`, never `room_not_found`. The
   *   two are opposite instructions to the caller and collapsing them is how a
   *   live room ends up treated as a dead one.
   */
  async function mutate(
    roomId: string,
    change: (room: Room, now: number) => RoomRevision,
  ): Promise<RoomMutationResult> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const room = await store.get(roomId)
      if (room === null) return { ok: false, error: { code: 'room_not_found' } }
      if (isRoomTerminal(room)) {
        return { ok: false, error: { code: 'room_closed', closeReason: room.closeReason } }
      }
      const now = clock.now()
      const next = reviseRoom(room, change(room, now), now)
      if (await store.save(room, next)) return { ok: true, room: next }
    }
    return { ok: false, error: { code: 'contended', retryAfterMs: CAS_BACKOFF_MS } }
  }

  async function leave(roomId: string, playerId: string): Promise<RoomMutationResult> {
    return mutate(roomId, (room, now) => {
      const present = room.presentPlayerIds.filter((id) => id !== playerId)
      return {
        presentPlayerIds: present,
        // Leaving does not vacate a seat: the seat is held for reconnection.
        // Freeing it is a host action and belongs to PER-13.
        spectatorPlayerIds: room.spectatorPlayerIds.filter((id) => id !== playerId),
        emptySince: present.length === 0 ? (room.emptySince ?? now) : null,
      }
    })
  }

  async function finishMatch(roomId: string, matchId: string): Promise<RoomMutationResult> {
    return mutate(roomId, (_room, now) => ({
      status: 'finished',
      finishedAt: now,
      currentMatchId: matchId,
    }))
  }

  async function sweep(limit = 200): Promise<SweepReport> {
    const now = clock.now()
    const due = await store.dueForSweep(now, limit)
    let expired = 0
    let closed = 0
    let removed = 0

    for (const room of due) {
      const verdict = evaluateRoomLifecycle(room, now, lifecycle)
      if (verdict.action === 'keep') continue

      // Closing and removing are separate passes. A room closed on an earlier
      // sweep lingers as a tombstone for `ttlGraceMs` so that a player on a
      // link that has just died is told the room is over rather than that it
      // never existed — the difference decides whether their IP is charged
      // for the failed join. Only now does the room object go; the match
      // record never does, it lives in Postgres and outlives every room.
      if (verdict.action === 'remove') {
        await store.remove(room.id)
        removed += 1
        continue
      }

      const reason: RoomCloseReason = verdict.reason
      const next = reviseRoom(
        room,
        { status: 'closed', closedAt: now, closeReason: reason, presentPlayerIds: [] },
        now,
      )
      if (!(await store.save(room, next))) continue

      if (verdict.action === 'expire') expired += 1
      else closed += 1
    }

    const prunedLimiterKeys = createLimiter.prune() + joinLimiter.prune() + failedJoins.prune()
    return { expired, closed, removed, prunedLimiterKeys }
  }

  /**
   * Compare-and-set rather than a blind write: the realtime service binds while
   * players are already joining and leaving, so the room it read may be stale
   * even though the binding decision is not.
   */
  async function bindRealtimeRoom(
    roomId: string,
    realtimeRoomId: string,
  ): Promise<BindRealtimeRoomResult> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const room = await store.get(roomId)
      if (room === null) return { ok: false, error: { code: 'room_not_found' } }

      const decision = decideRealtimeBinding(room, realtimeRoomId)
      if (decision.action === 'noop') return { ok: true, room, bound: false }
      if (decision.action === 'reject') {
        return decision.code === 'already_bound'
          ? {
              ok: false,
              // Non-null: `already_bound` is only reachable when it is set.
              error: { code: 'already_bound', realtimeRoomId: room.realtimeRoomId as string },
            }
          : { ok: false, error: { code: decision.code } }
      }

      const next = reviseRoom(room, { realtimeRoomId }, clock.now())
      if (await store.save(room, next)) return { ok: true, room: next, bound: true }
    }
    return { ok: false, error: { code: 'contended', retryAfterMs: CAS_BACKOFF_MS } }
  }

  async function realtimeTarget(roomId: string, playerId: string): Promise<RealtimeJoinTarget> {
    const room = await store.get(roomId)
    // A missing room is reported as `not_admitted`, not `not_found`: an unbound
    // caller must not learn a room id from the shape of the refusal.
    if (room === null) return { ok: false, code: 'not_admitted' }
    return realtimeJoinTarget(room, playerId)
  }

  async function listPublic(limit = 50): Promise<readonly PublicRoomSummary[]> {
    if (!flags.isEnabled('publicRoomListing')) return []
    return (await store.listPublic(limit)).map(publicRoomSummary)
  }

  return {
    create,
    joinByCode,
    leave,
    finishMatch,
    sweep,
    bindRealtimeRoom,
    realtimeTarget,
    listPublic,
  }
}
