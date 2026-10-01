import { describe, expect, it } from 'vitest'
import { emptySeat, seatReady } from '../src/rooms/types.js'
import {
  assignSeat,
  clearReady,
  readyAll,
  reserveSeatForBot,
  seatAt,
  setPlayerReady,
  swapSeats,
  vacatePlayer,
  vacateSeat,
} from '../src/seats/seating.js'
import { makeRoom } from './fixtures/rooms.js'

const seatsOf = (occupants: readonly (string | null)[], notReady?: readonly number[]) =>
  makeRoom({ seats: occupants, notReady }).seats

const occupantsOf = (seats: ReturnType<typeof seatsOf>) =>
  seats.map((seat) => seat.occupantPlayerId)
const readyOf = (seats: ReturnType<typeof seatsOf>) => seats.map((seat) => seat.isReady)

describe('emptySeat', () => {
  it('is free, teamless, unreserved and not ready', () => {
    expect(emptySeat(3)).toEqual({
      index: 3,
      occupantPlayerId: null,
      teamId: null,
      reservedFor: null,
      isReady: false,
    })
  })

  it('accepts a pre-assigned team', () => {
    expect(emptySeat(0, 'team-2').teamId).toBe('team-2')
  })
})

describe('seatReady', () => {
  it('sets the flag on an occupied seat', () => {
    const seat = { ...emptySeat(0), occupantPlayerId: 'a' }
    expect(seatReady(seat, true).isReady).toBe(true)
  })

  it('refuses to mark an empty seat ready', () => {
    // "Empty but ready" would let a half-full lobby satisfy a ready check.
    expect(seatReady(emptySeat(0), true).isReady).toBe(false)
  })
})

describe('seatAt', () => {
  it('finds a seat by index', () => {
    expect(seatAt(seatsOf(['a', 'b']), 1)?.occupantPlayerId).toBe('b')
  })

  it('is undefined for an index that does not exist', () => {
    expect(seatAt(seatsOf(['a']), 4)).toBeUndefined()
  })
})

describe('swapSeats', () => {
  it('exchanges two occupants', () => {
    expect(occupantsOf(swapSeats(seatsOf(['a', 'b']), 0, 1))).toEqual(['b', 'a'])
  })

  it('moves a player into an empty seat', () => {
    // One code path for "move me" and "swap with me", so a player moving into a
    // gap cannot take a different route through the rules.
    expect(occupantsOf(swapSeats(seatsOf(['a', null, null]), 0, 2))).toEqual([null, null, 'a'])
  })

  it('clears the ready flag on both seats', () => {
    // A player who agreed to start from seat 0 has not agreed to start from
    // seat 2 — under fixed teams that is a different team.
    const swapped = swapSeats(seatsOf(['a', 'b']), 0, 1)
    expect(readyOf(swapped)).toEqual([false, false])
  })

  it('leaves other seats alone, flags included', () => {
    const swapped = swapSeats(seatsOf(['a', 'b', 'c']), 0, 1)
    expect(swapped[2]?.isReady).toBe(true)
  })

  it('keeps team ids with the seats, not the players', () => {
    const seats = makeRoom({ seats: ['a', 'b'], teamIds: ['team-1', 'team-2'] }).seats
    const swapped = swapSeats(seats, 0, 1)
    expect(swapped.map((seat) => seat.teamId)).toEqual(['team-1', 'team-2'])
    expect(occupantsOf(swapped)).toEqual(['b', 'a'])
  })

  it('is a no-op for the same index', () => {
    const seats = seatsOf(['a', 'b'])
    expect(swapSeats(seats, 1, 1)).toBe(seats)
  })

  it('is a no-op for an index that does not exist', () => {
    const seats = seatsOf(['a', 'b'])
    expect(swapSeats(seats, 0, 9)).toBe(seats)
  })
})

describe('assignSeat', () => {
  it('seats a player and readies them', () => {
    const seats = assignSeat(seatsOf(['a', null]), 1, 'b')
    expect(occupantsOf(seats)).toEqual(['a', 'b'])
    expect(seats[1]?.isReady).toBe(true)
  })

  it('vacates the seat the player already held', () => {
    const seats = assignSeat(seatsOf(['a', 'b', null]), 2, 'a')
    expect(occupantsOf(seats)).toEqual([null, 'b', 'a'])
  })

  it('is a no-op in effect when re-seating a player in their own seat', () => {
    // Vacate-then-seat: the other order removes them entirely when the target
    // index is the seat they already hold.
    const seats = assignSeat(seatsOf(['a', 'b']), 0, 'a')
    expect(occupantsOf(seats)).toEqual(['a', 'b'])
  })

  it('clears a bot reservation on the seat it fills', () => {
    const seats = assignSeat(makeRoom({ seats: ['a', null], botSeats: [1] }).seats, 1, 'b')
    expect(seats[1]?.reservedFor).toBeNull()
    expect(seats[1]?.occupantPlayerId).toBe('b')
  })
})

describe('vacateSeat / vacatePlayer', () => {
  it('empties a seat and clears its flag', () => {
    const seats = vacateSeat(seatsOf(['a', 'b']), 0)
    expect(occupantsOf(seats)).toEqual([null, 'b'])
    expect(readyOf(seats)).toEqual([false, true])
  })

  it('keeps the seat on its team, because the team belongs to the seat', () => {
    const seats = makeRoom({ seats: ['a', 'b'], teamIds: ['team-1', 'team-2'] }).seats
    expect(vacateSeat(seats, 1)[1]?.teamId).toBe('team-2')
  })

  it('finds a player by id', () => {
    expect(occupantsOf(vacatePlayer(seatsOf(['a', 'b']), 'b'))).toEqual(['a', null])
  })

  it('is a no-op for a player who holds no seat', () => {
    const seats = seatsOf(['a', 'b'])
    expect(vacatePlayer(seats, 'nobody')).toBe(seats)
  })
})

describe('reserveSeatForBot', () => {
  it('holds an empty seat open', () => {
    expect(reserveSeatForBot(seatsOf(['a', null]), 1, true)[1]?.reservedFor).toBe('bot')
  })

  it('refuses to reserve an occupied seat', () => {
    // A reservation that could evict a player would be a kick under another name.
    const seats = seatsOf(['a', 'b'])
    expect(reserveSeatForBot(seats, 1, true)).toBe(seats)
  })

  it('releases a reservation back to an ordinary free seat', () => {
    const reserved = makeRoom({ seats: ['a', null], botSeats: [1] }).seats
    const released = reserveSeatForBot(reserved, 1, false)
    expect(released[1]?.reservedFor).toBeNull()
    expect(released[1]?.occupantPlayerId).toBeNull()
  })

  it('is a no-op for an index that does not exist', () => {
    const seats = seatsOf(['a', null])
    expect(reserveSeatForBot(seats, 5, true)).toBe(seats)
  })
})

describe('ready flags', () => {
  it('sets one player', () => {
    expect(readyOf(setPlayerReady(seatsOf(['a', 'b']), 'b', false))).toEqual([true, false])
  })

  it('ignores a player who holds no seat', () => {
    expect(readyOf(setPlayerReady(seatsOf(['a', 'b']), 'nobody', false))).toEqual([true, true])
  })

  it('clears every flag', () => {
    expect(readyOf(clearReady(seatsOf(['a', 'b'])))).toEqual([false, false])
  })

  it('leaves the array untouched when there is nothing to clear', () => {
    const seats = clearReady(seatsOf(['a', 'b']))
    const again = clearReady(seats)
    seats.forEach((seat, index) => expect(again[index]).toBe(seat))
  })

  it('readies every occupied seat and no empty one', () => {
    const seats = readyAll(seatsOf(['a', null, 'c'], [0, 2]))
    expect(readyOf(seats)).toEqual([true, false, true])
  })

  it('never readies a bot-reserved seat', () => {
    const seats = readyAll(makeRoom({ seats: ['a', null], botSeats: [1] }).seats)
    expect(seats[1]?.isReady).toBe(false)
  })
})
