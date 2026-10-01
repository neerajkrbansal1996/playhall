/**
 * The room model.
 *
 * A room is the platform's unit of togetherness: it owns the code, the link,
 * the seats, the chat and the presence list, and it outlives any single match
 * played inside it (that is what makes rematch possible). It knows a game's
 * *id and version*, never a game's rules — core branches on manifest fields,
 * never on a game id.
 *
 * This file is the *record*. Every rule about who may sit where, who is host,
 * when a match may start and what a rematch does lives in `seats/` and is a
 * pure function of a room plus the game's declared `SeatingPolicy`. Nothing
 * here decides anything.
 */

import type { JsonValue } from '@playhall/game-sdk'

export type RoomStatus = 'lobby' | 'in_progress' | 'finished' | 'closed'

/**
 * Private is the default and the only visibility available until the
 * `publicRoomListing` flag is on. A private room is reachable by link or code
 * and is never listed.
 */
export type RoomVisibility = 'private' | 'public'

export type RoomCloseReason =
  /** Nobody ever joined the host. */
  | 'no_opponent'
  /** Everyone disconnected and the grace window elapsed. */
  | 'empty'
  /** The match ended and the rematch/chat window elapsed. */
  | 'rematch_window_elapsed'
  /** The host closed it deliberately. */
  | 'host_closed'

/**
 * What a seat is being held for.
 *
 * `bot` is the v1 bot-slot *interface* and nothing more: a host may mark a seat
 * as a bot seat, the room records it, and `seats/bots.ts` defines the port a
 * provider would implement. v1 ships no provider, so a room with a bot seat
 * cannot start — see `unfilledBotSeats` in `seats/start.ts`. Declaring the slot
 * now is what stops "add bots" from becoming a change to the seat record, the
 * room service, the protocol and the lobby all at once later.
 */
export type SeatReservation = 'bot'

export interface RoomSeatSlot {
  /** Stable 0-based position. Seat 1 in the UI is index 0 here. */
  readonly index: number
  /** Null for a free seat. */
  readonly occupantPlayerId: string | null
  /**
   * Null unless the game's manifest declares teams. Assigned by the platform
   * from `teams`/`teamCount` — never chosen by a game and never by a client
   * beyond asking to move, which `seats/teams.ts` then re-balances.
   */
  readonly teamId: string | null
  /** Non-null only for a seat held open for a bot. Mutually exclusive with an occupant. */
  readonly reservedFor: SeatReservation | null
  /**
   * The ready flag.
   *
   * Seats are ready **on being taken** and a player un-readies to say "not
   * yet". The default has to be this way round: a fixed-size game auto-starts
   * when it fills, so opt-in readiness would mean a two-player game where both
   * players must tap a button that exists only to undo the auto-start they
   * wanted. Un-ready is therefore the escape hatch, and it cancels an armed
   * countdown rather than merely annotating the roster.
   *
   * Always false for an empty or bot-reserved seat; `seatReady` enforces it.
   */
  readonly isReady: boolean
}

/** A free seat at `index`, optionally pre-assigned to a team. */
export function emptySeat(index: number, teamId: string | null = null): RoomSeatSlot {
  return { index, occupantPlayerId: null, teamId, reservedFor: null, isReady: false }
}

/**
 * Sets a seat's ready flag, holding the invariant that only an occupied seat
 * can be ready. Every writer goes through here so "empty but ready" — which
 * would let a half-full lobby satisfy a ready check — cannot be constructed.
 */
export function seatReady(seat: RoomSeatSlot, isReady: boolean): RoomSeatSlot {
  return { ...seat, isReady: seat.occupantPlayerId === null ? false : isReady }
}

export interface Room {
  readonly id: string
  /** Canonical, upper-case, 6 characters from the unambiguous alphabet. */
  readonly code: string

  /**
   * The compare-and-set token. Starts at 1 and is incremented by exactly one
   * on every accepted write.
   *
   * It has to be a counter rather than `updatedAt`, and the difference is not
   * cosmetic: two joins that land in the same millisecond carry the same
   * wall-clock reading, so a CAS comparing `updatedAt` finds them equal,
   * accepts the stale write and seats both players at the same index — the
   * second silently overwriting the first. A counter cannot collide however
   * fast the writes arrive. `updatedAt` is display metadata and nothing else.
   *
   * `reviseRoom` is the only thing that bumps it, so no mutation site can
   * forget to.
   */
  readonly version: number

  /**
   * The realtime framework's own opaque room handle, or null until the realtime
   * service has created the backing room and bound it. Internal plumbing: it is
   * never shown to a player, never typed by one, and never visible to a game
   * module. See `rooms/realtime-binding.ts` for why it lives on this record and
   * who is allowed to receive it.
   */
  readonly realtimeRoomId: string | null

  readonly gameId: string
  readonly gameSlug: string
  /** Pinned for the room's whole life, so a mid-room deploy cannot change rules. */
  readonly gameVersion: string

  readonly hostPlayerId: string
  readonly visibility: RoomVisibility
  readonly status: RoomStatus

  /** Already validated against the game's `settingsSchema`. JSON-safe. */
  readonly settings: JsonValue

  readonly seats: readonly RoomSeatSlot[]
  readonly spectatorPlayerIds: readonly string[]
  /** Currently connected players (seated or spectating). Drives the empty timer. */
  readonly presentPlayerIds: readonly string[]

  readonly createdAt: number
  readonly updatedAt: number

  /**
   * When a second *distinct* player first took a seat. Null means the room has
   * never had an opponent, which is what the 30-minute expiry tests.
   * Deliberately not derived from `seats`: a player who joined and left still
   * proves the room was not abandoned at birth.
   */
  readonly secondPlayerJoinedAt: number | null
  /** When the room last became empty of connected players. Null while occupied. */
  readonly emptySince: number | null
  /** When the current match finished. Starts the rematch window. */
  readonly finishedAt: number | null

  /**
   * When the auto-start countdown fires, or null when no countdown is armed.
   *
   * A deadline rather than a timer handle, for the same reason the lifecycle
   * rules are pure functions of `(room, now)`: an in-process `setTimeout` dies
   * with the process, and a room that survives a restart has to be able to
   * answer "should this match have started by now?" from Redis alone.
   */
  readonly startCountdownEndsAt: number | null

  /**
   * Players who have asked for a rematch. Player ids, not seat indexes: a
   * rematch may rotate seats, so an index recorded before the vote resolves
   * would name a different person by the time it is counted.
   */
  readonly rematchVotes: readonly string[]

  /**
   * How many matches this room has hosted. The rotation offset for the next
   * one, so "who goes first" advances by exactly one per rematch without any
   * caller having to remember the history.
   */
  readonly matchesPlayed: number

  readonly closedAt: number | null
  readonly closeReason: RoomCloseReason | null

  /** The match currently or most recently hosted. Match records outlive the room. */
  readonly currentMatchId: string | null
}

/**
 * Fields a successor revision may change. The identity of a room — its id, its
 * code, when it was born — is fixed for its whole life, and `version` is the
 * store's to manage, so none of them are settable here.
 */
export type RoomRevision = Partial<Omit<Room, 'id' | 'code' | 'version' | 'createdAt'>>

/**
 * Builds the successor revision of a room: applies `changes`, bumps `version`
 * by one and stamps `updatedAt`.
 *
 * The single place a version is incremented. Every mutation goes through here
 * so that "each write bumps the token" is a property of the code rather than a
 * rule each call site has to remember — the CAS is only as strong as its
 * weakest writer.
 */
export function reviseRoom(previous: Room, changes: RoomRevision, now: number): Room {
  return { ...previous, ...changes, version: previous.version + 1, updatedAt: now }
}

export function seatedPlayerIds(room: Room): string[] {
  return room.seats
    .map((seat) => seat.occupantPlayerId)
    .filter((playerId): playerId is string => playerId !== null)
}

export function occupiedSeats(room: Room): RoomSeatSlot[] {
  return room.seats.filter((seat) => seat.occupantPlayerId !== null)
}

/**
 * The lowest-indexed seat a new arrival may take.
 *
 * A seat reserved for a bot is *not* free: the host set it aside deliberately,
 * and letting the next person through the link take it would silently undo a
 * host decision.
 */
export function freeSeatIndex(room: Room): number | null {
  const seat = room.seats.find(
    (candidate) => candidate.occupantPlayerId === null && candidate.reservedFor === null,
  )
  return seat ? seat.index : null
}

export function seatIndexOf(room: Room, playerId: string): number | null {
  const seat = room.seats.find((candidate) => candidate.occupantPlayerId === playerId)
  return seat ? seat.index : null
}

export function isRoomMember(room: Room, playerId: string): boolean {
  return seatIndexOf(room, playerId) !== null || room.spectatorPlayerIds.includes(playerId)
}

/**
 * Whether this room has reached the end of its life and may no longer be
 * revised.
 *
 * `closed` is the one terminal status, and the sweeper is the only thing that
 * reaches it. Every other status is a legal starting point for a write:
 * `finished` in particular is *not* terminal, because the rematch window exists
 * precisely so a finished room can be re-crewed.
 *
 * The distinction is load-bearing rather than tidy. A write accepted against a
 * closed room resurrects it — `status` goes back to a live value while
 * `closedAt` and `closeReason` stay set, so the record is self-contradictory,
 * `roomDeadlines` leaves the tombstone branch and stops arming the removal that
 * frees the room's code, and a player can join a room the platform has already
 * told everyone is over. Callers check this before building a successor; see
 * `mutate` in `rooms/service.ts`.
 */
export function isRoomTerminal(room: Room): boolean {
  return room.status === 'closed'
}
