/**
 * The one room writer.
 *
 * Read-modify-write with bounded compare-and-set retries. Extracted so the room
 * service and the seat service share a single writer rather than each keeping
 * their own retry loop: two loops is two places for the closed-room guard to be
 * forgotten, and the guard is the difference between a swept room staying dead
 * and a host action resurrecting it.
 *
 * Two refusals every mutation gets for free by coming through here:
 *
 * - A **closed** room is never revised. The guard is inside the retry loop, not
 *   before it, because a room can close between attempts — the sweeper runs
 *   concurrently with every one of these calls.
 * - Exhausting the retry budget is `contended`, never `room_not_found`. The two
 *   are opposite instructions to the caller and collapsing them is how a live
 *   room ends up treated as a dead one.
 */

import type { Clock } from '../runtime.js'
import type { RoomStore } from './store.js'
import {
  type Room,
  type RoomCloseReason,
  type RoomRevision,
  isRoomTerminal,
  reviseRoom,
} from './types.js'

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
   * budget ran out. Distinct from `room_not_found` because the caller's correct
   * response is the opposite one: retry, do not conclude the room is gone. A
   * `finishMatch` that reported contention as "not found" would leave a room
   * `in_progress` with no `finishedAt` — and `roomDeadlines` arms nothing for
   * that state, so the room would never be swept and the players would sit in a
   * match that silently never ended.
   */
  | { readonly code: 'contended'; readonly retryAfterMs: number }

export type RoomMutationResult =
  | { readonly ok: true; readonly room: Room }
  | { readonly ok: false; readonly error: RoomMutationFailure }

/**
 * Compare-and-set retry budget. Contention on one room is bounded by its seat
 * count, so a handful of attempts covers a real race; anything beyond that is a
 * failing store, and failing loudly beats spinning.
 */
export const CAS_ATTEMPTS = 4
export const CAS_BACKOFF_MS = 50

export interface RoomWriterOptions {
  readonly store: RoomStore
  readonly clock: Clock
}

/**
 * A change that may refuse.
 *
 * Returning a `RoomRevision` applies it; returning a refusal aborts without a
 * write. The decision runs **inside** the retry loop against freshly read
 * state, which is the point: a guard evaluated before the loop is a guard
 * evaluated against a room that may have changed by the time the write lands.
 * A host who lost the crown in the same tick must not still be able to kick.
 */
export type GuardedChange<TRefusal, TOutcome = never> = (
  room: Room,
  now: number,
) =>
  { readonly revision: RoomRevision; readonly outcome?: TOutcome } | { readonly refused: TRefusal }

export type GuardedMutationResult<TRefusal, TOutcome = never> =
  | { readonly ok: true; readonly room: Room; readonly outcome?: TOutcome }
  | { readonly ok: false; readonly error: RoomMutationFailure }
  | { readonly ok: false; readonly refused: TRefusal }

export interface RoomWriter {
  /** An unconditional change. */
  mutate(
    roomId: string,
    change: (room: Room, now: number) => RoomRevision,
  ): Promise<RoomMutationResult>
  /**
   * A change that may refuse after reading fresh state, and that may label what
   * it did.
   *
   * The label exists because "the write succeeded" is not always the answer the
   * caller needs: recording a rematch vote and *starting* the rematch are both
   * successful writes to the same room, and a caller that had to infer which
   * happened by comparing statuses would be re-deriving a decision this function
   * already made.
   */
  guarded<TRefusal, TOutcome = never>(
    roomId: string,
    change: GuardedChange<TRefusal, TOutcome>,
  ): Promise<GuardedMutationResult<TRefusal, TOutcome>>
  read(roomId: string): Promise<Room | null>
}

export function createRoomWriter(options: RoomWriterOptions): RoomWriter {
  const { store, clock } = options

  async function guarded<TRefusal, TOutcome = never>(
    roomId: string,
    change: GuardedChange<TRefusal, TOutcome>,
  ): Promise<GuardedMutationResult<TRefusal, TOutcome>> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const room = await store.get(roomId)
      if (room === null) return { ok: false, error: { code: 'room_not_found' } }
      if (isRoomTerminal(room)) {
        return { ok: false, error: { code: 'room_closed', closeReason: room.closeReason } }
      }
      const now = clock.now()
      const decision = change(room, now)
      if ('refused' in decision) return { ok: false, refused: decision.refused }
      const next = reviseRoom(room, decision.revision, now)
      if (await store.save(room, next)) {
        return { ok: true, room: next, outcome: decision.outcome }
      }
    }
    return { ok: false, error: { code: 'contended', retryAfterMs: CAS_BACKOFF_MS } }
  }

  async function mutate(
    roomId: string,
    change: (room: Room, now: number) => RoomRevision,
  ): Promise<RoomMutationResult> {
    const result = await guarded<never>(roomId, (room, now) => ({ revision: change(room, now) }))
    // `never` cannot be produced, so the refusal arm is unreachable. Narrowed
    // rather than cast so a future refusing change here fails to compile.
    if (!result.ok && 'refused' in result)
      throw new Error('unreachable: unconditional change refused')
    return result
  }

  return { mutate, guarded, read: (roomId) => store.get(roomId) }
}
