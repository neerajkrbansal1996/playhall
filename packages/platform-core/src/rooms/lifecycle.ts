/**
 * Room lifecycle.
 *
 * Four deadlines, one rule each:
 *
 * | Condition                         | After   | Outcome |
 * | --------------------------------- | ------- | ------- |
 * | Host alone, no second player ever | 30 min  | expire  |
 * | Nobody connected                  |  5 min  | close   |
 * | Match finished                    | 15 min  | close   |
 * | Already closed                    | grace   | remove  |
 *
 * Closing and removing are two steps, not one. A closed room stays in the
 * store as a tombstone for `ttlGraceMs`, and that window is load-bearing
 * twice over: a player arriving on a link that just died is told the room is
 * over (`room_expired`) instead of that it never existed, and the code stays
 * reserved a while longer so a stale link can never be handed a *different*
 * room that happened to draw the same code.
 *
 * All four are expressed as *pure functions of `(room, now)`*, not as
 * `setTimeout`. A timer held in one process dies with that process, and a
 * room that outlives its timer is a leaked Redis key — a scaling bug, not a
 * cosmetic one. Instead every room carries a computable next deadline, which
 * is what the sweeper polls and what the Redis key TTL is set from. After a
 * restart the deadlines are still correct because they were never in memory.
 *
 * Match records are *not* room state. Closing a room never deletes a match
 * record; those live in Postgres and persist.
 */

import type { Room, RoomCloseReason } from './types.js'

export interface RoomLifecyclePolicy {
  /** Host alone and nobody ever joined -> expire. */
  readonly noOpponentMs: number
  /** No connected players -> close. */
  readonly emptyMs: number
  /** Match finished -> stay open this long for rematch and chat. */
  readonly finishedMs: number
  /**
   * Two jobs, deliberately one number. Added to the computed deadline when
   * setting a Redis TTL, so the key survives just long enough for the sweeper
   * to observe and act on it rather than finding it already gone; and how long
   * a closed room lingers as a tombstone before it is removed.
   */
  readonly ttlGraceMs: number
}

/**
 * The policy this platform ships with. The numbers in the table above.
 *
 * Every function below takes `policy` as a **required** parameter rather than
 * defaulting to this. That is deliberate and the default is not coming back:
 * an optional policy is how a caller silently computes a deadline under the
 * shipped numbers while the rest of the system runs a configured policy, and
 * the symptom is "the lifecycle timers are configured and nothing ever
 * expires" — a wiring bug that no test catches unless it varies the policy.
 * Required makes the next occurrence a typecheck error instead. Pass this
 * constant explicitly when you do want the shipped numbers.
 */
export const DEFAULT_ROOM_LIFECYCLE: RoomLifecyclePolicy = Object.freeze({
  noOpponentMs: 30 * 60_000,
  emptyMs: 5 * 60_000,
  finishedMs: 15 * 60_000,
  ttlGraceMs: 60_000,
})

/**
 * Whether two policies are the same set of deadlines.
 *
 * Exists so a wiring mismatch can be *detected* rather than discovered in
 * production as "the lifecycle timers are configured and nothing ever expires".
 * Compared field by field, not by reference: the store and the service are
 * usually constructed in different places and a shared frozen default is only
 * one of the ways they can legitimately agree.
 */
export function sameRoomLifecyclePolicy(a: RoomLifecyclePolicy, b: RoomLifecyclePolicy): boolean {
  return (
    a.noOpponentMs === b.noOpponentMs &&
    a.emptyMs === b.emptyMs &&
    a.finishedMs === b.finishedMs &&
    a.ttlGraceMs === b.ttlGraceMs
  )
}

export type RoomLifecycleAction =
  /** Nothing due. `deadlineAt` is when something next could be. */
  | { readonly action: 'keep'; readonly deadlineAt: number | null; readonly reason: null }
  /** Never got going. Distinct from `close` so the metric separates them. */
  | { readonly action: 'expire'; readonly deadlineAt: number; readonly reason: 'no_opponent' }
  | {
      readonly action: 'close'
      readonly deadlineAt: number
      readonly reason: Exclude<RoomCloseReason, 'no_opponent' | 'host_closed'>
    }
  /** The tombstone has served its purpose. Drop the room and free its code. */
  | {
      readonly action: 'remove'
      readonly deadlineAt: number
      readonly reason: RoomCloseReason | null
    }

interface Candidate {
  readonly at: number
  readonly action: 'expire' | 'close' | 'remove'
  readonly reason: RoomCloseReason | null
}

/**
 * Every deadline currently armed for this room, earliest first.
 *
 * More than one can be armed at once — a lobby whose only player disconnected
 * is both "no opponent yet" and "empty" — and the earliest wins. Returning the
 * whole list rather than just the winner keeps the precedence visible and
 * testable.
 */
export function roomDeadlines(room: Room, policy: RoomLifecyclePolicy): readonly Candidate[] {
  // A closed room has exactly one deadline left: its own removal. Returning
  // `[]` here would take it out of the sweeper's range query entirely, which
  // is how a tombstone becomes a leaked key.
  if (room.status === 'closed') {
    if (room.closedAt === null) return []
    return [{ at: room.closedAt + policy.ttlGraceMs, action: 'remove', reason: room.closeReason }]
  }

  const candidates: Candidate[] = []

  if (room.finishedAt !== null && room.status === 'finished') {
    candidates.push({
      at: room.finishedAt + policy.finishedMs,
      action: 'close',
      reason: 'rematch_window_elapsed',
    })
  }

  if (room.emptySince !== null) {
    candidates.push({ at: room.emptySince + policy.emptyMs, action: 'close', reason: 'empty' })
  }

  // Only a room that never got a second player can expire this way, and only
  // while it is still waiting. Once a match starts, a solo room is a player
  // whose opponent dropped — that is the empty/finished path, not this one.
  if (room.secondPlayerJoinedAt === null && room.status === 'lobby') {
    candidates.push({
      at: room.createdAt + policy.noOpponentMs,
      action: 'expire',
      reason: 'no_opponent',
    })
  }

  return candidates.sort((a, b) => a.at - b.at)
}

/** The instant at which this room next needs the sweeper's attention. */
export function nextRoomDeadline(room: Room, policy: RoomLifecyclePolicy): number | null {
  return roomDeadlines(room, policy)[0]?.at ?? null
}

/** What, if anything, the sweeper should do to this room at `now`. */
export function evaluateRoomLifecycle(
  room: Room,
  now: number,
  policy: RoomLifecyclePolicy,
): RoomLifecycleAction {
  const candidates = roomDeadlines(room, policy)
  const due = candidates.find((candidate) => candidate.at <= now)
  if (!due) return { action: 'keep', deadlineAt: candidates[0]?.at ?? null, reason: null }

  if (due.action === 'expire') {
    return { action: 'expire', deadlineAt: due.at, reason: 'no_opponent' }
  }
  if (due.action === 'remove') {
    return { action: 'remove', deadlineAt: due.at, reason: due.reason }
  }
  return {
    action: 'close',
    deadlineAt: due.at,
    reason: due.reason as Exclude<RoomCloseReason, 'no_opponent' | 'host_closed'>,
  }
}

/**
 * TTL for this room's Redis keys, in milliseconds.
 *
 * TTL hygiene rule: **every** room key gets one. A room with no armed deadline
 * (a match in progress, everyone connected) still gets `noOpponentMs +
 * ttlGraceMs` as a floor, so a room can never outlive a process crash that
 * loses its sweeper entry. The sweeper refreshes the TTL whenever it touches
 * the room, so a long match is never truncated.
 */
export function roomKeyTtlMs(room: Room, now: number, policy: RoomLifecyclePolicy): number {
  const deadline = nextRoomDeadline(room, policy)
  const floor = policy.noOpponentMs + policy.ttlGraceMs
  if (deadline === null) return floor
  return Math.max(policy.ttlGraceMs, deadline - now + policy.ttlGraceMs)
}
