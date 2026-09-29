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
import {
  DEFAULT_ROOM_LIFECYCLE,
  type RoomLifecyclePolicy,
  evaluateRoomLifecycle,
} from './lifecycle.js'
import { type Room, freeSeatIndex, seatIndexOf } from './types.js'

export const JOIN_REJECTION_CODES = [
  'invalid_code',
  'room_not_found',
  'room_expired',
  'room_full',
  'game_unavailable',
  'rate_limited',
  'too_many_failed_joins',
] as const
export type JoinRejectionCode = (typeof JOIN_REJECTION_CODES)[number]

/**
 * Whether a rejection means "this code will never work" — the friendly
 * not-found path — as opposed to "try again later".
 */
export function isTerminalRejection(code: JoinRejectionCode): boolean {
  return code === 'invalid_code' || code === 'room_not_found' || code === 'room_expired'
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
 * Trims, upper-cases, drops separators a player may have typed or a messaging
 * app may have inserted, and folds the confusables the alphabet excludes
 * (`O`->`0` is impossible, so only the folds that land inside the alphabet are
 * applied — see `@playhall/shared`). Returns null when the result is not a
 * complete, valid code.
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
  readonly lifecycle?: RoomLifecyclePolicy
}

/** Pure. Decides the outcome; applying it to the room is `applyJoin`. */
export function resolveJoin(input: ResolveJoinInput): JoinOutcome {
  const { room, playerId, game, now } = input
  if (room === null) return rejectJoin('room_not_found')

  if (room.status === 'closed') return rejectJoin('room_expired')
  const lifecycle = evaluateRoomLifecycle(room, now, input.lifecycle ?? DEFAULT_ROOM_LIFECYCLE)
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

  const base = {
    ...room,
    presentPlayerIds: present,
    emptySince: null,
    updatedAt: now,
  }

  if (outcome.kind === 'spectating') {
    const spectators = room.spectatorPlayerIds.includes(playerId)
      ? room.spectatorPlayerIds
      : [...room.spectatorPlayerIds, playerId]
    return { ...base, spectatorPlayerIds: spectators }
  }

  if (outcome.kind === 'rejoined') return base

  const seats = room.seats.map((seat) =>
    seat.index === outcome.seatIndex ? { ...seat, occupantPlayerId: playerId } : seat,
  )
  // The first seat taken by someone other than the host is what stops the
  // 30-minute no-opponent expiry. Recorded once and never cleared: a room that
  // *did* get going and then emptied belongs to the empty timer, not this one.
  const secondPlayerJoinedAt =
    room.secondPlayerJoinedAt ?? (playerId === room.hostPlayerId ? null : now)

  return {
    ...base,
    seats,
    spectatorPlayerIds: room.spectatorPlayerIds.filter((id) => id !== playerId),
    secondPlayerJoinedAt,
  }
}
