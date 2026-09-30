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
 * The multiset of team sizes a balanced roster of `occupied` players across
 * `teamCount` teams must have, largest first.
 *
 * Sizes only — *which* team gets which size is `assignTeams`' business, and it
 * hands the larger shares to the teams more players asked for. Fixing the
 * remainder to the earliest teams here would be a second, conflicting balance
 * rule: it would refuse to let anybody move onto the smaller side of a
 * five-player room, because `[3, 2]` and `[2, 3]` are equally balanced and only
 * the first would ever be reachable.
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
 * `auto-balanced`: **demand first, then balance, and stability throughout.**
 *
 * 1. Count how many players are currently claiming each team.
 * 2. Hand out the balanced share sizes — `targetTeamSizes` — largest share to
 *    the team with the most claimants, ties broken by canonical team order.
 * 3. In seat order, every player whose claimed team still has share left keeps
 *    it.
 * 4. Whoever is left over goes to the team with the most share remaining.
 *
 * Steps 1 and 2 are what make the result *reachable*: a five-player room
 * balances as three-and-two either way round, so a player moving to the smaller
 * side must be able to make it the bigger one. Allocating the extra share to the
 * earliest team instead would silently bounce them back, and the move would look
 * like it had failed.
 *
 * Step 3 is what makes it stable. Recomputing round-robin from scratch is a
 * correct balance that reshuffles bystanders every time somebody joins, so a
 * player who deliberately picked a side loses it because a stranger walked in.
 * Exactly the players who cannot be accommodated are moved, and no others.
 *
 * Empty seats take whatever share is left over, so the lobby can render the
 * shape of the sides before they fill.
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

  // Step 1: demand.
  const claims = new Map<string, number>(teamIds.map((teamId) => [teamId, 0]))
  for (const seat of occupied) {
    if (seat.teamId === null) continue
    const current = claims.get(seat.teamId)
    // A team id that is not in the policy is stale — a room that outlived a
    // policy change — and counts as no claim at all.
    if (current !== undefined) claims.set(seat.teamId, current + 1)
  }

  // Step 2: the balanced shares, largest to the most-wanted team. Canonical
  // order breaks ties, so the whole assignment stays deterministic — the same
  // roster produces the same sides on any server, on a replay, after a restart.
  const shares = targetTeamSizes(occupied.length, teamIds.length)
  const byDemand = [...teamIds].sort((a, b) => {
    const difference = (claims.get(b) as number) - (claims.get(a) as number)
    return difference !== 0 ? difference : teamIds.indexOf(a) - teamIds.indexOf(b)
  })
  const capacity = new Map<string, number>()
  byDemand.forEach((teamId, index) => capacity.set(teamId, shares[index] as number))

  const next = new Map<number, string>()

  // Step 3: honour the claims that still fit.
  for (const seat of occupied) {
    const current = seat.teamId
    if (current === null) continue
    const room = capacity.get(current)
    if (room === undefined || room === 0) continue
    capacity.set(current, room - 1)
    next.set(seat.index, current)
  }

  /** The team with the most share left. Canonical order breaks ties. */
  function emptiest(): string | undefined {
    let best: string | undefined
    let bestRoom = 0
    for (const teamId of teamIds) {
      const room = capacity.get(teamId) ?? 0
      if (room > bestRoom) {
        best = teamId
        bestRoom = room
      }
    }
    return best
  }

  // Step 4: place everyone else. Taking the *emptiest* team rather than the
  // first with any room is what guarantees the shares are consumed exactly, and
  // so that the result is balanced for any number of teams.
  for (const seat of occupied) {
    if (next.has(seat.index)) continue
    const teamId = emptiest()
    // Unreachable: the shares sum to exactly `occupied.length` and step 3
    // consumed at most that many. Guarded rather than asserted so a future
    // change to the share maths degrades to "unassigned" instead of a crash.
    if (teamId === undefined) continue
    capacity.set(teamId, (capacity.get(teamId) as number) - 1)
    next.set(seat.index, teamId)
  }

  return seats.map((seat) => {
    let teamId: string | null
    if (seat.occupantPlayerId !== null) {
      teamId = next.get(seat.index) ?? null
    } else {
      // Empty seats show where the next arrival would land.
      teamId = emptiest() ?? teamIds[seat.index % teamIds.length] ?? null
      if (teamId !== null && (capacity.get(teamId) ?? 0) > 0) {
        capacity.set(teamId, (capacity.get(teamId) as number) - 1)
      }
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

  // Pinning the mover is the whole implementation: `assignTeams` allocates the
  // larger share to the team with the most claimants, so the mover's new team
  // grows to fit them and exactly the players who no longer fit are re-placed.
  // An explicit displacement step here would be a second balance rule competing
  // with that one.
  const pinned = seats.map((candidate) =>
    candidate.index === seatIndex ? { ...candidate, teamId } : candidate,
  )
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
