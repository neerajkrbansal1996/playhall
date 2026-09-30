import type { Room, RoomCloseReason, RoomStatus, RoomVisibility } from '../../src/rooms/types.js'

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
    seats: seats.map((occupantPlayerId, index) => ({ index, occupantPlayerId })),
    spectatorPlayerIds: overrides.spectatorPlayerIds ?? [],
    presentPlayerIds:
      overrides.presentPlayerIds ?? seats.filter((seat): seat is string => seat !== null),
    createdAt,
    updatedAt: createdAt,
    secondPlayerJoinedAt: overrides.secondPlayerJoinedAt ?? null,
    emptySince: overrides.emptySince ?? null,
    finishedAt: overrides.finishedAt ?? null,
    closedAt: overrides.closedAt ?? null,
    closeReason: overrides.closeReason ?? null,
    currentMatchId: null,
  }
}
