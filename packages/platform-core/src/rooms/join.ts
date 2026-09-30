/**
 * The join matrix.
 *
 * "Join by link or code" is one decision made in one pure function, so the
 * `/r/:CODE` page, the code box on the landing page and the realtime
 * `room:join` message cannot drift apart. Everything it needs is an argument;
 * it touches no store and no clock.
 *
 * The matrix, in order of precedence:
 *
 * | Situation                                   | Outcome              |
 * | ------------------------------------------- | -------------------- |
 * | Code fails alphabet/length after normalising | `invalid_code`       |
 * | No room for that code                        | `room_not_found`     |
 * | Room closed or past a lifecycle deadline     | `room_expired`       |
 * | Registry cannot resolve the room's game      | `game_unavailable`   |
 * | Player already holds a seat                  | `rejoined` (same seat) |
 * | Player already spectating                    | `spectating`         |
 * | Free seat, room in lobby or finished         | `seated`             |
 * | Match in progress (seat belongs to the match)| `spectating`         |
 * | No free seat, game allows spectators         | `spectating`         |
 * | No free seat, game forbids spectators        | `room_full`          |
 *
 * Two of these are worth defending. **Mid-match joiners spectate** rather than
 * dropping into a free seat: a seat vacated during a match still belongs to
 * the player who left, and seat substitution is a seats-and-host concern
 * ([PER-13](/PER/issues/PER-13)), not a join concern. And **a finished room
 * does let a new player take a seat**, because the 15-minute rematch window
 * exists precisely so the room can be re-crewed.
 */

import { normalizeRoomCode } from '@playhall/shared'
import type { GameCatalogEntry } from '@playhall/game-sdk'
import { isValidRoomCode } from './code.js'
import { type RoomLifecyclePolicy, evaluateRoomLifecycle } from './lifecycle.js'
import { type Room, type RoomRevision, freeSeatIndex, reviseRoom, seatIndexOf } from './types.js'

export const JOIN_REJECTION_CODES = [
  'invalid_code',
  'room_not_found',
  'room_expired',
  'room_full',
  'game_unavailable',
  'rate_limited',
  'too_many_failed_joins',
  /**
   * The compare-and-set retry budget ran out while other players were joining
   * the same room. Not `rate_limited`: nothing the player did earned it, no
   * token of theirs was spent, and the remedy is an immediate retry rather than
   * a wait. Conflating the two hides real store contention behind a message
   * that blames the player.
   */
  'contended',
] as const
export type JoinRejectionCode = (typeof JOIN_REJECTION_CODES)[number]

/**
 * Whether a rejection means "this code will never work" — the friendly
 * not-found path — as opposed to "try again later".
 */
export function isTerminalRejection(code: JoinRejectionCode): boolean {
  return code === 'invalid_code' || code === 'room_not_found' || code === 'room_expired'
}

/**
 * Whether a rejection should spend a token from the per-IP failed-join budget.
 *
 * Not the same question as `isTerminalRejection`, and conflating them costs
 * real players their budget. That cap is an *enumeration* defence: it exists
 * to stop someone walking the 887,503,681-code space. Only a code that has
 * never named a room is evidence of guessing.
 *
 * `room_expired` is the case that matters. The holder of a code for a room
 * that has just closed is, on the evidence, someone who was invited — they
 * produced a real code. Charging them is what makes the shared-NAT argument in
 * `policies.ts` unsound, because that argument leans on a successful join
 * refunding the budget and a dead link can never succeed: four friends on one
 * office Wi-Fi tapping a stale link would lock out the fifth. The tombstone
 * window is what makes this distinguishable at all — see `lifecycle.ts` — and
 * it is short enough that it is no use as an enumeration oracle.
 */
export function chargesFailedJoinBudget(code: JoinRejectionCode): boolean {
  return code === 'invalid_code' || code === 'room_not_found'
}

export type JoinOutcome =
  | { readonly kind: 'seated'; readonly seatIndex: number; readonly isRejoin: false }
  | { readonly kind: 'rejoined'; readonly seatIndex: number; readonly isRejoin: true }
  | { readonly kind: 'spectating'; readonly isRejoin: boolean }
  | { readonly kind: 'rejected'; readonly code: JoinRejectionCode; readonly terminal: boolean }

export function rejectJoin(code: JoinRejectionCode): Extract<JoinOutcome, { kind: 'rejected' }> {
  return { kind: 'rejected', code, terminal: isTerminalRejection(code) }
}

/**
 * Normalises player input into a canonical code.
 *
 * Trims, upper-cases and drops the separators a player may have typed or a
 * messaging app may have inserted. There is deliberately **no** confusable
 * folding: both halves of every confusable pair are excluded from the
 * alphabet, so there is nothing in-alphabet to fold to — see the reasoning on
 * `normalizeRoomCode` in `@playhall/shared`. Returns null when the result is
 * not a complete, valid code.
 */
export function canonicalizeRoomCode(input: string): string | null {
  const canonical = normalizeRoomCode(input.trim())
  return isValidRoomCode(canonical) ? canonical : null
}

export interface ResolveJoinInput {
  readonly room: Room | null
  readonly playerId: string
  /** Null when the registry cannot resolve the room's game (unregistered, removed). */
  readonly game: GameCatalogEntry | null
  readonly now: number
  /**
   * Required, not optional. A join that resolves under the shipped deadlines
   * while the store sweeps under a configured policy admits players to rooms
   * the sweeper considers dead — see `DEFAULT_ROOM_LIFECYCLE`.
   */
  readonly lifecycle: RoomLifecyclePolicy
}

/** Pure. Decides the outcome; applying it to the room is `applyJoin`. */
export function resolveJoin(input: ResolveJoinInput): JoinOutcome {
  const { room, playerId, game, now } = input
  if (room === null) return rejectJoin('room_not_found')

  if (room.status === 'closed') return rejectJoin('room_expired')
  const lifecycle = evaluateRoomLifecycle(room, now, input.lifecycle)
  if (lifecycle.action !== 'keep') return rejectJoin('room_expired')

  if (game === null) return rejectJoin('game_unavailable')

  const heldSeat = seatIndexOf(room, playerId)
  if (heldSeat !== null) return { kind: 'rejoined', seatIndex: heldSeat, isRejoin: true }
  if (room.spectatorPlayerIds.includes(playerId)) return { kind: 'spectating', isRejoin: true }

  const free = freeSeatIndex(room)
  const seatsAreOpen = room.status === 'lobby' || room.status === 'finished'
  if (free !== null && seatsAreOpen) return { kind: 'seated', seatIndex: free, isRejoin: false }

  if (game.supportsSpectators) return { kind: 'spectating', isRejoin: false }
  return rejectJoin('room_full')
}

/**
 * Applies a resolved outcome, returning the new room.
 *
 * Immutable by design: the room runner writes the returned value back through
 * the store's compare-and-set, so a lost update is detected instead of
 * silently overwriting a concurrent join.
 */
export function applyJoin(room: Room, playerId: string, outcome: JoinOutcome, now: number): Room {
  if (outcome.kind === 'rejected') return room

  const present = room.presentPlayerIds.includes(playerId)
    ? room.presentPlayerIds
    : [...room.presentPlayerIds, playerId]

  const base: RoomRevision = { presentPlayerIds: present, emptySince: null }

  if (outcome.kind === 'spectating') {
    const spectators = room.spectatorPlayerIds.includes(playerId)
      ? room.spectatorPlayerIds
      : [...room.spectatorPlayerIds, playerId]
    return reviseRoom(room, { ...base, spectatorPlayerIds: spectators }, now)
  }

  if (outcome.kind === 'rejoined') return reviseRoom(room, base, now)

  const seats = room.seats.map((seat) =>
    seat.index === outcome.seatIndex ? { ...seat, occupantPlayerId: playerId } : seat,
  )
  // The first seat taken by someone other than the host is what stops the
  // 30-minute no-opponent expiry. Recorded once and never cleared: a room that
  // *did* get going and then emptied belongs to the empty timer, not this one.
  const secondPlayerJoinedAt =
    room.secondPlayerJoinedAt ?? (playerId === room.hostPlayerId ? null : now)

  // Someone taking a seat in a finished room is re-crewing it for a rematch,
  // so the 15-minute window restarts from that moment. Without this, a player
  // seated at minute 14 gets sixty seconds to agree to a game and is thrown
  // out mid-sentence. Only a *seating* join restarts it — a spectator
  // wandering in is not a rematch — and seats are finite and are not released
  // by leaving, so the number of restarts per match is bounded by seat count.
  const finishedAt = room.status === 'finished' ? now : room.finishedAt

  return reviseRoom(
    room,
    {
      ...base,
      seats,
      spectatorPlayerIds: room.spectatorPlayerIds.filter((id) => id !== playerId),
      secondPlayerJoinedAt,
      finishedAt,
    },
    now,
  )
}
