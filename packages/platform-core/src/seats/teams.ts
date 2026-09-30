/**
 * Teams: assignment, auto-balance and rotation.
 *
 * All pure, all total functions of `(seats, policy)`. Nothing here reads a
 * clock, a store or a game.
 *
 * Two team layouts, and the difference is who owns the seat-to-team map:
 *
 * - **fixed** — the game owns it. Seat index determines team, permanently, and
 *   no host action can move a player between teams. A game declares this when
 *   the mapping is part of its rules.
 * - **auto-balanced** — the platform owns it. Players may ask to switch and the
 *   platform keeps the sides within one player of each other.
 *
 * Fixed teams are assigned **interleaved** (`index % teamCount`) rather than in
 * blocks. Both satisfy the manifest's "maxPlayers divides evenly" rule, but only
 * interleaving makes seat rotation mean something: rotate a four-seat,
 * two-team room by one and every player has a new partner and a new opponent,
 * which is exactly what a rematch rotation is for. Under a block layout the
 * same rotation moves one player across and leaves the sides lopsided until the
 * offset happens to come back around.
 */

import type { RoomSeatSlot } from '../rooms/types.js'
import { type SeatingPolicy, teamIdsFor } from './policy.js'

/** Occupied-seat headcount per team id. Teams with nobody in them are present with 0. */
export function teamSizes(
  seats: readonly RoomSeatSlot[],
  policy: SeatingPolicy,
): ReadonlyMap<string, number> {
  const sizes = new Map<string, number>()
  for (const teamId of teamIdsFor(policy)) sizes.set(teamId, 0)
  for (const seat of seats) {
    if (seat.occupantPlayerId === null || seat.teamId === null) continue
    sizes.set(seat.teamId, (sizes.get(seat.teamId) ?? 0) + 1)
  }
  return sizes
}

/**
 * Whether the occupied seats are as even as the headcount allows.
 *
 * "Balanced" is `max - min <= 1` over the declared teams, not `max === min`:
 * five players across two teams can never be equal, and a rule that demanded
 * it would refuse to start every odd-numbered lobby forever.
 */
export function isBalanced(seats: readonly RoomSeatSlot[], policy: SeatingPolicy): boolean {
  if (policy.teams === 'none') return true
  const counts = [...teamSizes(seats, policy).values()]
  if (counts.length === 0) return true
  return Math.max(...counts) - Math.min(...counts) <= 1
}

/**
 * The target size for each team, in canonical team order.
 *
 * `n % k` teams get one extra, and they are the *earliest* teams, which is what
 * makes the whole assignment deterministic: the same roster always produces the
 * same sides, on any server, on a replay, and after a restart.
 */
export function targetTeamSizes(occupied: number, teamCount: number): readonly number[] {
  const base = Math.floor(occupied / teamCount)
  const remainder = occupied % teamCount
  return Array.from({ length: teamCount }, (_, index) => base + (index < remainder ? 1 : 0))
}

/**
 * Re-derives every seat's team.
 *
 * `fixed`: seat index decides, occupied or not, so the lobby can show the sides
 * before anyone has arrived.
 *
 * `auto-balanced`: **stability first**. A seat whose current team still has
 * room keeps it; only the seats left over are placed, into the teams with
 * capacity remaining, in seat order. The alternative — recomputing round-robin
 * from scratch — is a correct balance that reshuffles bystanders every time
 * somebody joins, so a player who deliberately picked a side loses it because
 * a stranger walked in. Empty seats carry the team of whichever slot has
 * capacity left, so the lobby can still render the shape of the sides.
 *
 * `none`: every team is cleared, including stale values left behind if a room
 * somehow outlived a policy change.
 */
export function assignTeams(
  seats: readonly RoomSeatSlot[],
  policy: SeatingPolicy,
): readonly RoomSeatSlot[] {
  const teamIds = teamIdsFor(policy)
  if (teamIds.length === 0) {
    return seats.map((seat) => (seat.teamId === null ? seat : { ...seat, teamId: null }))
  }

  if (policy.teams === 'fixed') {
    return seats.map((seat) => {
      const teamId = teamIds[seat.index % teamIds.length] as string
      return seat.teamId === teamId ? seat : { ...seat, teamId }
    })
  }

  const occupied = seats.filter((seat) => seat.occupantPlayerId !== null)
  const capacity = new Map<string, number>()
  targetTeamSizes(occupied.length, teamIds.length).forEach((size, index) => {
    capacity.set(teamIds[index] as string, size)
  })

  const next = new Map<number, string | null>()

  // Pass one: honour the choices that still fit.
  for (const seat of occupied) {
    const current = seat.teamId
    if (current === null) continue
    const room = capacity.get(current)
    if (room === undefined || room === 0) continue
    capacity.set(current, room - 1)
    next.set(seat.index, current)
  }

  // Pass two: place everyone else where there is room.
  for (const seat of occupied) {
    if (next.has(seat.index)) continue
    const teamId = teamIds.find((candidate) => (capacity.get(candidate) ?? 0) > 0)
    // Unreachable: the targets sum to exactly `occupied.length` and pass one
    // consumed at most that many. Guarded rather than asserted so a future
    // change to the target maths degrades to "unassigned" instead of a crash.
    if (teamId === undefined) continue
    capacity.set(teamId, (capacity.get(teamId) as number) - 1)
    next.set(seat.index, teamId)
  }

  // Empty seats show where the next arrival would land.
  const spare = [...capacity.entries()].filter(([, room]) => room > 0).map(([teamId]) => teamId)
  let spareCursor = 0

  return seats.map((seat) => {
    let teamId: string | null
    if (seat.occupantPlayerId !== null) {
      teamId = next.get(seat.index) ?? null
    } else {
      teamId = spare[spareCursor] ?? teamIds[seat.index % teamIds.length] ?? null
      spareCursor += 1
    }
    return seat.teamId === teamId ? seat : { ...seat, teamId }
  })
}

/**
 * Moves one player to `teamId`, then re-balances.
 *
 * Returns null when the move is not available: teams are off, the team does not
 * exist, or the seat has nobody in it. A move that would unbalance the room is
 * *not* refused — `assignTeams` absorbs it by moving whoever has the weakest
 * claim, which is why the requester keeps their choice even in a full room.
 * Under `fixed` teams there is nothing to move, so the request is refused.
 */
export function moveToTeam(
  seats: readonly RoomSeatSlot[],
  policy: SeatingPolicy,
  seatIndex: number,
  teamId: string,
): readonly RoomSeatSlot[] | null {
  if (policy.teams !== 'auto-balanced') return null
  if (!teamIdsFor(policy).includes(teamId)) return null
  const seat = seats.find((candidate) => candidate.index === seatIndex)
  if (seat === undefined || seat.occupantPlayerId === null) return null

  const teamIds = teamIdsFor(policy)
  const occupied = seats.filter((candidate) => candidate.occupantPlayerId !== null)
  const share = targetTeamSizes(occupied.length, teamIds.length)[teamIds.indexOf(teamId)] ?? 0
  const others = occupied.filter(
    (candidate) => candidate.index !== seatIndex && candidate.teamId === teamId,
  )

  // Somebody has to leave only when the mover would push the team past its
  // share, and then it is exactly one somebody: the highest-indexed current
  // member. Clearing the whole team instead would be a correct balance that
  // reshuffles bystanders, which is the churn `assignTeams` exists to avoid.
  const displaced = others.length + 1 > share ? others.at(-1)?.index : undefined

  const pinned = seats.map((candidate) => {
    if (candidate.index === seatIndex) return { ...candidate, teamId }
    if (candidate.index === displaced) return { ...candidate, teamId: null }
    return candidate
  })
  return assignTeams(pinned, policy)
}

/**
 * Rotates who sits where by `offset` seats, keeping the seats themselves — and
 * so their team ids — exactly where they are.
 *
 * The occupants move, the furniture does not. That is the whole point: under
 * fixed teams, seat 0 is team 1 forever, so rotating occupants is the *only*
 * way to change who plays which role. Rotating the team labels instead would
 * leave everyone in the same relationship to everyone else.
 *
 * Only occupied seats take part, and they rotate among themselves. Rotating
 * across empty seats would teleport a player into a gap and quietly change the
 * team balance; in a four-seat room with two players it would also mean a
 * rotation that visibly does nothing.
 *
 * Ready flags and bot reservations belong to the seat, not the occupant, so
 * they stay put. `applyRematch` clears the ready flags afterwards.
 */
export function rotateOccupants(
  seats: readonly RoomSeatSlot[],
  offset: number,
): readonly RoomSeatSlot[] {
  const occupied = seats.filter((seat) => seat.occupantPlayerId !== null)
  if (occupied.length < 2) return seats

  // Normalise into `[0, n)` so a negative or oversized offset is well defined
  // rather than producing `undefined` occupants.
  const n = occupied.length
  const shift = ((offset % n) + n) % n
  if (shift === 0) return seats

  const moved = new Map<number, string>()
  occupied.forEach((seat, position) => {
    const target = occupied[(position + shift) % n] as RoomSeatSlot
    moved.set(target.index, seat.occupantPlayerId as string)
  })

  return seats.map((seat) => {
    const occupantPlayerId = moved.get(seat.index)
    return occupantPlayerId === undefined ? seat : { ...seat, occupantPlayerId }
  })
}
