/**
 * Host controls: who holds the crown, and what holding it permits.
 *
 * The host is a *room* role, not a seat. Deliberately: a host who is kicked
 * from their seat, or whose seat is rotated by a rematch, does not stop being
 * the person who opened the lobby. Tying the role to seat 0 would mean a seat
 * swap silently hands someone else the kick button.
 *
 * Pure. `resolveHostSuccession` and the `can*` predicates decide; applying the
 * decision to a room is `seats/service.ts`, which owns the compare-and-set.
 */

import { type Room, type RoomRevision, occupiedSeats, seatIndexOf } from '../rooms/types.js'

export const HOST_ACTION_REJECTIONS = [
  /** The actor is not the host. Every control in this file is host-only. */
  'not_host',
  /** The target is not in this room at all. */
  'not_a_member',
  /** No seat with that index. */
  'no_such_seat',
  /** The seat already has somebody in it. */
  'seat_occupied',
  /** The seat is empty and the action needed an occupant. */
  'seat_empty',
  /**
   * A host tried to kick themselves. Not an error worth inventing a path for:
   * leaving is `leave`, and ending the room is `closeLobby`.
   */
  'cannot_kick_self',
  /** The action is only legal while the room is a lobby. */
  'match_in_progress',
  /** The room has already finished or closed. */
  'room_not_open',
  /** The game's manifest does not declare teams. */
  'teams_not_enabled',
  /** No such team for this game. */
  'no_such_team',
  /** The game's manifest does not declare bot support. */
  'bots_not_supported',
  /** The candidate host is not someone who could hold the role. */
  'invalid_host',
] as const
export type HostActionRejection = (typeof HOST_ACTION_REJECTIONS)[number]

/**
 * Who inherits the room when `leavingPlayerId` stops being able to host it.
 *
 * Order, and every step of it is load-bearing:
 *
 * 1. **A present, seated player**, lowest seat index first. Seat order is the
 *    closest thing the room has to arrival order, and it is stable across
 *    reads, so two servers resolving the same succession agree.
 * 2. **Any seated player**, present or not. A lobby of one disconnected player
 *    still has an owner, so the crown does not evaporate during a tunnel.
 * 3. **A present spectator**. A room of watchers with a dead host cannot be
 *    closed, renamed or restarted by anyone; giving a watcher the crown is
 *    better than an immortal zombie lobby.
 * 4. **Nobody** — null. The caller closes the room; there is no one left to
 *    hand it to.
 *
 * Returns null *without* considering the leaver, so a caller cannot accidentally
 * re-elect the person who just left.
 */
export function resolveHostSuccession(room: Room, leavingPlayerId: string): string | null {
  const seated = occupiedSeats(room)
    .map((seat) => seat.occupantPlayerId as string)
    .filter((playerId) => playerId !== leavingPlayerId)

  const presentSeated = seated.find((playerId) => room.presentPlayerIds.includes(playerId))
  if (presentSeated !== undefined) return presentSeated
  if (seated.length > 0) return seated[0] as string

  const spectator = room.spectatorPlayerIds.find(
    (playerId) => playerId !== leavingPlayerId && room.presentPlayerIds.includes(playerId),
  )
  return spectator ?? null
}

/**
 * Whether the host role should move because the current host has gone quiet.
 *
 * Called on every presence-leave, and it fires while the host still holds their
 * seat. The seat is kept for reconnection either way — presence and seating are
 * separate facts — but the *crown* moves, because a lobby whose only start
 * button belongs to someone on a dead phone cannot start at all, and the
 * 30-minute no-opponent timer is not a substitute for a room that could simply
 * have carried on.
 *
 * The reverse does not happen: reconnecting does not reclaim the role. A host
 * on a flapping mobile connection would otherwise pass the crown back and forth
 * several times a minute, and every hand-off is a state change every client in
 * the room has to render. The original host can be given it back explicitly.
 *
 * Returns null when nothing should change, including the case where the host is
 * already absent and the crown has moved once — the function is idempotent
 * because it only looks at whether *the current host* is present.
 */
export function resolveAbsentHostTransfer(room: Room): string | null {
  if (room.presentPlayerIds.includes(room.hostPlayerId)) return null
  const heir = resolveHostSuccession(room, room.hostPlayerId)
  // Only promote someone who is actually here. Step 2 of the succession order
  // exists for "the host left the room", not for "everybody is offline" — in
  // that state the empty timer owns the room and moving the crown is noise.
  if (heir === null || !room.presentPlayerIds.includes(heir)) return null
  return heir
}

/** Whether `actorPlayerId` currently holds the host role. */
export function isHost(room: Room, actorPlayerId: string): boolean {
  return room.hostPlayerId === actorPlayerId
}

/**
 * Whether the host may hand the role to `targetPlayerId`.
 *
 * The target has to be a member — seated or spectating — and present. Handing
 * the crown to someone who has already closed the tab recreates the exact
 * problem `resolveAbsentHostTransfer` exists to fix, one step removed.
 */
export function canTransferHost(
  room: Room,
  actorPlayerId: string,
  targetPlayerId: string,
): HostActionRejection | null {
  if (!isHost(room, actorPlayerId)) return 'not_host'
  if (targetPlayerId === actorPlayerId) return 'invalid_host'
  const seated = seatIndexOf(room, targetPlayerId) !== null
  if (!seated && !room.spectatorPlayerIds.includes(targetPlayerId)) return 'not_a_member'
  if (!room.presentPlayerIds.includes(targetPlayerId)) return 'invalid_host'
  return null
}

/**
 * Whether the host may remove `targetPlayerId` from the room.
 *
 * Allowed in a lobby and in a finished room — the rematch window is where a
 * host removes the player who has gone quiet so a substitute can take the seat
 * — and refused mid-match, because vacating a seat during a match is a
 * forfeit, which belongs to the match, not to seating.
 */
export function canKick(
  room: Room,
  actorPlayerId: string,
  targetPlayerId: string,
): HostActionRejection | null {
  if (!isHost(room, actorPlayerId)) return 'not_host'
  if (targetPlayerId === actorPlayerId) return 'cannot_kick_self'
  if (room.status === 'in_progress') return 'match_in_progress'
  if (room.status === 'closed') return 'room_not_open'
  const seated = seatIndexOf(room, targetPlayerId) !== null
  if (!seated && !room.spectatorPlayerIds.includes(targetPlayerId)) return 'not_a_member'
  return null
}

/** Whether the host may close the room outright. Legal from any live status. */
export function canCloseLobby(room: Room, actorPlayerId: string): HostActionRejection | null {
  if (!isHost(room, actorPlayerId)) return 'not_host'
  if (room.status === 'closed') return 'room_not_open'
  return null
}

/**
 * The host-succession revision for a presence change, or `{}` when the crown
 * stays put.
 *
 * Used by the room service's `leave`, which is where a host stops being present.
 * The rule lives here rather than there because it belongs to the host role;
 * `leave` just merges the result into its own revision.
 *
 * Takes the room *as it will be* — presence already stripped — rather than a
 * departing player id. Presence is the only input the rule actually has, and
 * asking the caller for both invites the two to disagree.
 */
export function hostSuccessionRevision(room: Room): RoomRevision {
  const heir = resolveAbsentHostTransfer(room)
  // No heir means the room has nobody present to own it. The crown stays with
  // the departed host rather than being nulled: `hostPlayerId` is not nullable,
  // and the empty timer is already arming — inventing a hostless room state
  // would add a case every reader has to handle for the few minutes before the
  // sweeper closes it.
  return heir === null ? {} : { hostPlayerId: heir }
}
