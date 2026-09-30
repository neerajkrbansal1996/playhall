/**
 * Seat mutations: swap, assign, vacate, reserve for a bot, ready.
 *
 * Every function returns the new seat array and touches nothing else on the
 * room. Teams are re-derived by the caller through `assignTeams`, so no
 * mutation site can leave a room that is seated one way and teamed another.
 *
 * All pure. `seats/service.ts` sequences them under compare-and-set.
 */

import { type RoomSeatSlot, seatReady } from '../rooms/types.js'

/** A seat array with `index` replaced. */
function replace(
  seats: readonly RoomSeatSlot[],
  index: number,
  change: (seat: RoomSeatSlot) => RoomSeatSlot,
): readonly RoomSeatSlot[] {
  return seats.map((seat) => (seat.index === index ? change(seat) : seat))
}

export function seatAt(
  seats: readonly RoomSeatSlot[],
  index: number,
): RoomSeatSlot | undefined {
  return seats.find((seat) => seat.index === index)
}

/**
 * Swaps the occupants of two seats.
 *
 * Works when one side is empty, which is what makes "move me to seat 3" the
 * same operation as "swap with the player in seat 3" — one code path, so a
 * player moving into a gap cannot take a different route through the rules than
 * a player trading places.
 *
 * Ready flags are cleared on both seats. A player who agreed to start from seat
 * 0 has not agreed to start from seat 2: under fixed teams that is a different
 * team, and under any game it is a different turn order. Re-confirming is one
 * tap; a match that starts with someone in a seat they did not agree to is not
 * recoverable.
 *
 * Team ids stay with the seats, not the players: seats own teams. Callers
 * re-derive with `assignTeams` afterwards so an auto-balanced room re-balances.
 */
export function swapSeats(
  seats: readonly RoomSeatSlot[],
  a: number,
  b: number,
): readonly RoomSeatSlot[] {
  if (a === b) return seats
  const first = seatAt(seats, a)
  const second = seatAt(seats, b)
  if (first === undefined || second === undefined) return seats

  return seats.map((seat) => {
    if (seat.index === a) {
      return seatReady({ ...seat, occupantPlayerId: second.occupantPlayerId }, false)
    }
    if (seat.index === b) {
      return seatReady({ ...seat, occupantPlayerId: first.occupantPlayerId }, false)
    }
    return seat
  })
}

/**
 * Puts `playerId` in `index`, vacating whatever seat they held.
 *
 * Vacate-then-seat rather than seat-then-vacate, and the order is not cosmetic:
 * doing it the other way round leaves the player in two seats for the duration
 * of one expression, and if the target index happens to be the seat they
 * already hold, the vacate then removes them from it entirely.
 */
export function assignSeat(
  seats: readonly RoomSeatSlot[],
  index: number,
  playerId: string,
): readonly RoomSeatSlot[] {
  const vacated = seats.map((seat) =>
    seat.occupantPlayerId === playerId
      ? seatReady({ ...seat, occupantPlayerId: null }, false)
      : seat,
  )
  return replace(vacated, index, (seat) =>
    seatReady({ ...seat, occupantPlayerId: playerId, reservedFor: null }, true),
  )
}

/**
 * Empties a seat.
 *
 * The seat keeps its team id, because the team belongs to the seat: an
 * auto-balanced room re-derives afterwards, and a fixed-team room must not
 * forget which side seat 2 is on just because nobody is sitting in it.
 */
export function vacateSeat(
  seats: readonly RoomSeatSlot[],
  index: number,
): readonly RoomSeatSlot[] {
  return replace(seats, index, (seat) =>
    seatReady({ ...seat, occupantPlayerId: null }, false),
  )
}

/** Empties whichever seat `playerId` holds. A no-op when they hold none. */
export function vacatePlayer(
  seats: readonly RoomSeatSlot[],
  playerId: string,
): readonly RoomSeatSlot[] {
  const seat = seats.find((candidate) => candidate.occupantPlayerId === playerId)
  return seat === undefined ? seats : vacateSeat(seats, seat.index)
}

/**
 * Holds a seat open for a bot, or releases it.
 *
 * The seat must be empty to be reserved — a reservation that could evict a
 * player would be a kick wearing a different name, and the host already has a
 * kick. Releasing a reservation just leaves an ordinary free seat.
 */
export function reserveSeatForBot(
  seats: readonly RoomSeatSlot[],
  index: number,
  reserved: boolean,
): readonly RoomSeatSlot[] {
  const seat = seatAt(seats, index)
  if (seat === undefined) return seats
  if (reserved && seat.occupantPlayerId !== null) return seats
  return replace(seats, index, (candidate) =>
    seatReady({ ...candidate, reservedFor: reserved ? 'bot' : null }, false),
  )
}

/** Sets the ready flag on whichever seat `playerId` holds. */
export function setPlayerReady(
  seats: readonly RoomSeatSlot[],
  playerId: string,
  isReady: boolean,
): readonly RoomSeatSlot[] {
  return seats.map((seat) =>
    seat.occupantPlayerId === playerId ? seatReady(seat, isReady) : seat,
  )
}

/** Clears every ready flag. Used by anything that invalidates a prior agreement. */
export function clearReady(seats: readonly RoomSeatSlot[]): readonly RoomSeatSlot[] {
  return seats.map((seat) => (seat.isReady ? seatReady(seat, false) : seat))
}

/** Marks every occupied seat ready. The state a fresh roster starts in. */
export function readyAll(seats: readonly RoomSeatSlot[]): readonly RoomSeatSlot[] {
  return seats.map((seat) => seatReady(seat, true))
}
