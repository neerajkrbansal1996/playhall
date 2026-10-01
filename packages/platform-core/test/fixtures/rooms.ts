import {
  type Room,
  type RoomCloseReason,
  type RoomSeatSlot,
  type RoomStatus,
  type RoomVisibility,
  emptySeat,
} from '../../src/rooms/types.js'

export const T0 = 1_700_000_000_000

export interface RoomOverrides {
  readonly status?: RoomStatus
  readonly visibility?: RoomVisibility
  readonly seats?: readonly (string | null)[]
  readonly spectatorPlayerIds?: readonly string[]
  readonly presentPlayerIds?: readonly string[]
  readonly createdAt?: number
  readonly secondPlayerJoinedAt?: number | null
  readonly emptySince?: number | null
  readonly finishedAt?: number | null
  readonly hostPlayerId?: string
  readonly gameId?: string
  readonly realtimeRoomId?: string | null
  readonly version?: number
  readonly closedAt?: number | null
  readonly closeReason?: RoomCloseReason | null
  /** Per-seat team ids, by seat index. Defaults to no teams. */
  readonly teamIds?: readonly (string | null)[]
  /** Seat indexes held open for a bot. */
  readonly botSeats?: readonly number[]
  /** Seat indexes whose occupant has un-readied. Occupied seats are ready by default. */
  readonly notReady?: readonly number[]
  readonly startCountdownEndsAt?: number | null
  readonly rematchVotes?: readonly string[]
  readonly matchesPlayed?: number
  readonly currentMatchId?: string | null
}

/** A two-seat lobby hosted by `host`, created at `T0`, with seat 1 free. */
export function makeRoom(overrides: RoomOverrides = {}): Room {
  const seats = overrides.seats ?? ['host', null]
  const createdAt = overrides.createdAt ?? T0
  return {
    id: 'room-1',
    code: 'ABC234',
    version: overrides.version ?? 1,
    realtimeRoomId: overrides.realtimeRoomId ?? null,
    gameId: overrides.gameId ?? 'fixture',
    gameSlug: 'fixture',
    gameVersion: '1.0.0',
    hostPlayerId: overrides.hostPlayerId ?? 'host',
    visibility: overrides.visibility ?? 'private',
    status: overrides.status ?? 'lobby',
    settings: { boardSize: 3, timed: false },
    seats: seats.map((occupantPlayerId, index): RoomSeatSlot => ({
      ...emptySeat(index, overrides.teamIds?.[index] ?? null),
      occupantPlayerId,
      reservedFor: overrides.botSeats?.includes(index) === true ? 'bot' : null,
      // Mirrors the production default: taking a seat readies it, and a test
      // opts a seat *out* rather than having to remember to opt every seat in.
      isReady: occupantPlayerId !== null && overrides.notReady?.includes(index) !== true,
    })),
    spectatorPlayerIds: overrides.spectatorPlayerIds ?? [],
    presentPlayerIds:
      overrides.presentPlayerIds ?? seats.filter((seat): seat is string => seat !== null),
    createdAt,
    updatedAt: createdAt,
    secondPlayerJoinedAt: overrides.secondPlayerJoinedAt ?? null,
    emptySince: overrides.emptySince ?? null,
    finishedAt: overrides.finishedAt ?? null,
    startCountdownEndsAt: overrides.startCountdownEndsAt ?? null,
    rematchVotes: overrides.rematchVotes ?? [],
    matchesPlayed: overrides.matchesPlayed ?? 0,
    closedAt: overrides.closedAt ?? null,
    closeReason: overrides.closeReason ?? null,
    currentMatchId: overrides.currentMatchId ?? null,
  }
}
