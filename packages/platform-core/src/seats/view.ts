/**
 * The room view: what one viewer is allowed to see of a room.
 *
 * The scope line, because it is easy to get wrong in both directions. This file
 * redacts the **room envelope** — seats, host, presence, spectators, the start
 * state. It does not touch game state; that is `getViewFor` in the game module,
 * and the two must both run. A spectator whose room view is clean but whose
 * game view is the full state can still read your hand.
 *
 * Three things must never leave this function, and each has bitten a platform
 * somewhere:
 *
 * 1. **`realtimeRoomId`.** Joining the realtime framework by handle needs
 *    nothing else, so the handle is a join capability. It travels only through
 *    `realtimeJoinTarget`, to a client the join matrix has already admitted.
 * 2. **The spectator roster.** Players see a spectator *count*. Naming the
 *    watchers turns a lobby into a presence oracle for anybody holding a link,
 *    and the product promise is a count, not a guest list.
 * 3. **`presentPlayerIds` as a list.** Presence is per-seat and only for people
 *    who are in the room's seats anyway; as a raw array it also leaks the
 *    spectator roster through the back door, since spectators are in it.
 *
 * Built as an explicit construction rather than a `delete` on a copy of the
 * room. A denylist silently starts leaking the day somebody adds a field to
 * `Room` — which this milestone did three times — whereas a missing field in an
 * allowlist fails to compile.
 */

import type { JsonValue } from '@playhall/game-sdk'
import { type Room, type RoomStatus, seatIndexOf } from '../rooms/types.js'
import { type SeatingPolicy } from './policy.js'
import { type SeatingSnapshot, seatingSnapshot } from './start.js'
import { tallyRematch } from './rematch.js'

/** How a viewer relates to the room. Decides what they are shown. */
export type ViewerKind = 'player' | 'spectator' | 'stranger'

export interface SeatView {
  readonly index: number
  readonly teamId: string | null
  readonly isReady: boolean
  /** True when this is the viewer's own seat. */
  readonly isSelf: boolean
  readonly isHost: boolean
  /** Null for a free or bot-reserved seat. */
  readonly occupantPlayerId: string | null
  /** Whether the occupant is currently connected. False for an empty seat. */
  readonly isPresent: boolean
  readonly isReservedForBot: boolean
}

export interface RoomView {
  readonly roomId: string
  /**
   * The code, or null for a stranger.
   *
   * The code is a capability: holding it authorises a join. A member already has
   * it — it is how they got in — and needs it to re-share the room. Handing it
   * to a viewer the join matrix has not admitted would mint a capability out of
   * a read.
   */
  readonly code: string | null
  readonly gameId: string
  readonly gameSlug: string
  readonly gameVersion: string
  readonly status: RoomStatus
  readonly settings: JsonValue
  readonly seats: readonly SeatView[]
  readonly viewerKind: ViewerKind
  readonly viewerSeatIndex: number | null
  readonly isHost: boolean
  /** A count, never a roster. */
  readonly spectatorCount: number
  readonly startCountdownEndsAt: number | null
  readonly start: SeatingSnapshot
  /** How many of the eligible players want a rematch, and how many are eligible. */
  readonly rematch: { readonly voted: number; readonly eligible: number }
  readonly matchesPlayed: number
  readonly currentMatchId: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export function viewerKindFor(room: Room, viewerPlayerId: string | null): ViewerKind {
  if (viewerPlayerId === null) return 'stranger'
  if (seatIndexOf(room, viewerPlayerId) !== null) return 'player'
  if (room.spectatorPlayerIds.includes(viewerPlayerId)) return 'spectator'
  return 'stranger'
}

/**
 * Projects a room for one viewer.
 *
 * `viewerPlayerId` may be null — the link-preview renderer and the public
 * listing have no viewer — and that case gets the `stranger` projection rather
 * than a separate code path, so there is no second, laxer redaction to keep in
 * step with this one.
 *
 * Occupant player ids *are* shown to members. They are opaque guest ids, they
 * are what a client keys its roster on, and a room where you cannot tell which
 * seat your opponent is in is not playable. They are withheld from strangers,
 * who have no business enumerating a private room's occupants.
 */
export function roomViewFor(
  room: Room,
  policy: SeatingPolicy,
  viewerPlayerId: string | null,
): RoomView {
  const viewerKind = viewerKindFor(room, viewerPlayerId)
  const isMember = viewerKind !== 'stranger'
  const present = new Set(room.presentPlayerIds)
  const tally = tallyRematch(room)

  const seats: readonly SeatView[] = room.seats.map((seat) => ({
    index: seat.index,
    teamId: seat.teamId,
    isReady: seat.isReady,
    isSelf: viewerPlayerId !== null && seat.occupantPlayerId === viewerPlayerId,
    isHost: seat.occupantPlayerId !== null && seat.occupantPlayerId === room.hostPlayerId,
    occupantPlayerId: isMember ? seat.occupantPlayerId : null,
    isPresent: seat.occupantPlayerId !== null && present.has(seat.occupantPlayerId),
    isReservedForBot: seat.reservedFor === 'bot',
  }))

  return {
    roomId: room.id,
    code: isMember ? room.code : null,
    gameId: room.gameId,
    gameSlug: room.gameSlug,
    gameVersion: room.gameVersion,
    status: room.status,
    settings: room.settings,
    seats,
    viewerKind,
    viewerSeatIndex: viewerPlayerId === null ? null : seatIndexOf(room, viewerPlayerId),
    isHost: viewerPlayerId !== null && room.hostPlayerId === viewerPlayerId,
    spectatorCount: room.spectatorPlayerIds.length,
    startCountdownEndsAt: room.startCountdownEndsAt,
    start: seatingSnapshot(room, policy),
    rematch: { voted: tally.voted.length, eligible: tally.eligible.length },
    matchesPlayed: room.matchesPlayed,
    currentMatchId: room.currentMatchId,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  }
}
