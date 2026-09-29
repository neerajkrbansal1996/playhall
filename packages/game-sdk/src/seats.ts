/**
 * Seats and teams.
 *
 * Seats are platform-owned. A game receives the roster at
 * `createInitialState` and keys everything on `SeatId` from then on.
 *
 * Note what is *not* here: connection state. Presence is a platform concern
 * rendered by platform UI, and putting `isConnected` into game state would
 * make every disconnect a state mutation that has to be replayed. Games learn
 * about disconnection only through `disconnectPolicy` and the optional
 * `onDisconnect` / `onReconnect` hooks. (Plugin boundary.)
 */

import type { PlayerId, SeatId, TeamId } from './ids.js'

export type TeamMode = 'none' | 'fixed' | 'auto-balanced'

export interface SeatOccupant {
  readonly playerId: PlayerId
  /** Platform-supplied, already moderated. Games must not store their own copy. */
  readonly displayName: string
  readonly isBot: boolean
}

export interface Seat {
  readonly seatId: SeatId
  /** Stable 0-based position, in seating order. Games may use it for turn order. */
  readonly index: number
  /** Null unless the manifest declares teams. */
  readonly teamId: TeamId | null
  /** Null for an empty seat. Games started with an empty seat should reject it. */
  readonly occupant: SeatOccupant | null
}

export type SeatRoster = readonly Seat[]

export function findSeat(roster: SeatRoster, seatId: SeatId): Seat | undefined {
  return roster.find((seat) => seat.seatId === seatId)
}

export function seatIds(roster: SeatRoster): SeatId[] {
  return roster.map((seat) => seat.seatId)
}

export function teamSeats(roster: SeatRoster, teamId: TeamId): Seat[] {
  return roster.filter((seat) => seat.teamId === teamId)
}
