import { describe, expect, it } from 'vitest'
import { toCatalogEntry } from '@playhall/game-sdk'
import { type SeatingPolicy, seatingPolicyFor } from '../src/seats/policy.js'
import {
  assignTeams,
  isBalanced,
  moveToTeam,
  rotateOccupants,
  targetTeamSizes,
  teamSizes,
} from '../src/seats/teams.js'
import { makeGame } from './fixtures/games.js'
import { makeRoom } from './fixtures/rooms.js'

function policyFor(options: Parameters<typeof makeGame>[0]): SeatingPolicy {
  return seatingPolicyFor(toCatalogEntry(makeGame(options).manifest))
}

const noTeams = policyFor({ slug: 'solo', maxPlayers: 4, minPlayers: 2 })
const fixed2 = policyFor({
  slug: 'fixed',
  teams: 'fixed',
  teamCount: 2,
  minPlayers: 4,
  maxPlayers: 4,
})
const auto2 = policyFor({
  slug: 'auto',
  teams: 'auto-balanced',
  minPlayers: 2,
  maxPlayers: 4,
})
const auto2of6 = policyFor({
  slug: 'auto6',
  teams: 'auto-balanced',
  minPlayers: 2,
  maxPlayers: 6,
})

/** Seats from a list of occupants, with whatever teams are already recorded. */
function seatsOf(occupants: readonly (string | null)[], teamIds?: readonly (string | null)[]) {
  return makeRoom({ seats: occupants, teamIds }).seats
}

const teamsOf = (seats: ReturnType<typeof seatsOf>) => seats.map((seat) => seat.teamId)
const occupantsOf = (seats: ReturnType<typeof seatsOf>) =>
  seats.map((seat) => seat.occupantPlayerId)

describe('targetTeamSizes', () => {
  it('splits evenly when it can', () => {
    expect(targetTeamSizes(4, 2)).toEqual([2, 2])
    expect(targetTeamSizes(6, 3)).toEqual([2, 2, 2])
  })

  it('gives the remainder to the earliest teams, deterministically', () => {
    // Determinism is the point: the same roster has to produce the same sides on
    // any server, on a replay and after a restart.
    expect(targetTeamSizes(5, 2)).toEqual([3, 2])
    expect(targetTeamSizes(4, 3)).toEqual([2, 1, 1])
  })

  it('handles an empty roster', () => {
    expect(targetTeamSizes(0, 2)).toEqual([0, 0])
  })
})

describe('assignTeams — fixed', () => {
  it('assigns by seat index, interleaved, occupied or not', () => {
    const seats = assignTeams(seatsOf([null, null, null, null]), fixed2)
    expect(teamsOf(seats)).toEqual(['team-1', 'team-2', 'team-1', 'team-2'])
  })

  it('overwrites whatever a client may have asked for', () => {
    // A fixed-team game owns its seat-to-team map. No host or player action can
    // move somebody across, so a stale or forged value is simply replaced.
    const seats = assignTeams(
      seatsOf(['a', 'b', 'c', 'd'], ['team-2', 'team-2', 'team-2', 'team-2']),
      fixed2,
    )
    expect(teamsOf(seats)).toEqual(['team-1', 'team-2', 'team-1', 'team-2'])
  })

  it('is idempotent', () => {
    const once = assignTeams(seatsOf(['a', 'b', 'c', 'd']), fixed2)
    expect(assignTeams(once, fixed2)).toEqual(once)
  })
})

describe('assignTeams — none', () => {
  it('clears every team id', () => {
    const seats = assignTeams(seatsOf(['a', 'b'], ['team-1', 'team-2']), noTeams)
    expect(teamsOf(seats)).toEqual([null, null])
  })
})

describe('assignTeams — auto-balanced', () => {
  it('balances an unassigned roster', () => {
    const seats = assignTeams(seatsOf(['a', 'b', 'c', 'd']), auto2)
    expect([...teamSizes(seats, auto2).values()]).toEqual([2, 2])
    expect(isBalanced(seats, auto2)).toBe(true)
  })

  it('balances an odd roster to within one player', () => {
    const seats = assignTeams(seatsOf(['a', 'b', 'c', null]), auto2)
    const sizes = [...teamSizes(seats, auto2).values()]
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(3)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBe(1)
    expect(isBalanced(seats, auto2)).toBe(true)
  })

  it('keeps a player on the side they chose when it still has room', () => {
    // Stability is the requirement. Recomputing round-robin from scratch is a
    // correct balance that reshuffles bystanders every time somebody joins.
    const seats = assignTeams(
      seatsOf(['a', 'b', 'c', 'd'], ['team-2', 'team-2', null, null]),
      auto2,
    )
    expect(seats[0]?.teamId).toBe('team-2')
    expect(seats[1]?.teamId).toBe('team-2')
    expect([...teamSizes(seats, auto2).values()]).toEqual([2, 2])
  })

  it('does not move an existing player when a new one arrives', () => {
    const before = assignTeams(seatsOf(['a', 'b', null, null]), auto2)
    const after = assignTeams(seatsOf(['a', 'b', 'c', null], teamsOf(before)), auto2)
    expect(after[0]?.teamId).toBe(before[0]?.teamId)
    expect(after[1]?.teamId).toBe(before[1]?.teamId)
  })

  it('re-places a player whose team is over its share', () => {
    // Three of four have claimed team-1; the share is 2, so one has to move.
    const seats = assignTeams(
      seatsOf(['a', 'b', 'c', 'd'], ['team-1', 'team-1', 'team-1', 'team-2']),
      auto2,
    )
    expect([...teamSizes(seats, auto2).values()]).toEqual([2, 2])
    // The earliest claimants keep their side; seat order is the tie-break.
    expect(seats[0]?.teamId).toBe('team-1')
    expect(seats[1]?.teamId).toBe('team-1')
  })

  it('shows empty seats where the next arrival would land', () => {
    const seats = assignTeams(seatsOf(['a', null, null, null]), auto2)
    // One player, share is [1, 0]; the spare capacity is team-2, so the lobby
    // renders the shape of the sides before anyone else arrives.
    expect(seats[0]?.teamId).toBe('team-1')
    expect(seats.slice(1).every((seat) => seat.teamId !== null)).toBe(true)
  })

  it('is idempotent', () => {
    const once = assignTeams(seatsOf(['a', 'b', 'c', null]), auto2)
    expect(assignTeams(once, auto2)).toEqual(once)
  })

  it('leaves the array untouched when nothing changes', () => {
    // Referential stability matters: a "changed" seat array is a version bump
    // and a delta every client in the room has to fetch.
    const once = assignTeams(seatsOf(['a', 'b']), auto2)
    const twice = assignTeams(once, auto2)
    once.forEach((seat, index) => expect(twice[index]).toBe(seat))
  })
})

describe('isBalanced', () => {
  it('is always true without teams', () => {
    expect(isBalanced(seatsOf(['a', 'b']), noTeams)).toBe(true)
  })

  it('accepts a one-player difference', () => {
    expect(
      isBalanced(seatsOf(['a', 'b', 'c', null], ['team-1', 'team-1', 'team-2', null]), auto2),
    ).toBe(true)
  })

  it('rejects a two-player difference', () => {
    expect(
      isBalanced(seatsOf(['a', 'b', 'c', null], ['team-1', 'team-1', 'team-1', null]), auto2),
    ).toBe(false)
  })

  it('counts only occupied seats', () => {
    // An empty seat carries a team so the lobby can render the sides; counting
    // it would report a full room as lopsided.
    expect(isBalanced(seatsOf(['a', null], ['team-1', 'team-2']), auto2)).toBe(true)
  })
})

describe('moveToTeam', () => {
  it('moves a player and keeps the room balanced', () => {
    const seats = assignTeams(seatsOf(['a', 'b', 'c', 'd']), auto2)
    const moved = moveToTeam(seats, auto2, 0, 'team-2')
    expect(moved).not.toBeNull()
    expect(moved?.[0]?.teamId).toBe('team-2')
    expect([...teamSizes(moved as typeof seats, auto2).values()]).toEqual([2, 2])
  })

  it('displaces exactly one player, the highest-indexed member', () => {
    const seats = seatsOf(['a', 'b', 'c', 'd'], ['team-1', 'team-2', 'team-2', 'team-1'])
    const moved = moveToTeam(seats, auto2, 0, 'team-2') as typeof seats
    expect(moved[0]?.teamId).toBe('team-2')
    // Seat 1 was already on team-2 and keeps it; seat 2 was the last member and
    // is the one re-placed.
    expect(moved[1]?.teamId).toBe('team-2')
    expect(moved[2]?.teamId).toBe('team-1')
  })

  it('does not displace anyone when the target team has room', () => {
    const seats = seatsOf(['a', 'b', 'c', null], ['team-1', 'team-1', 'team-2', null])
    const moved = moveToTeam(seats, auto2, 1, 'team-2') as typeof seats
    expect(moved[1]?.teamId).toBe('team-2')
    expect(moved[2]?.teamId).toBe('team-2')
    expect(moved[0]?.teamId).toBe('team-1')
  })

  it('refuses under fixed teams', () => {
    expect(moveToTeam(seatsOf(['a', 'b', 'c', 'd']), fixed2, 0, 'team-2')).toBeNull()
  })

  it('refuses without teams', () => {
    expect(moveToTeam(seatsOf(['a', 'b']), noTeams, 0, 'team-1')).toBeNull()
  })

  it('refuses an unknown team', () => {
    expect(moveToTeam(seatsOf(['a', 'b']), auto2, 0, 'team-9')).toBeNull()
  })

  it('refuses an empty seat', () => {
    expect(moveToTeam(seatsOf(['a', null]), auto2, 1, 'team-2')).toBeNull()
  })

  it('refuses a seat index that does not exist', () => {
    expect(moveToTeam(seatsOf(['a', 'b']), auto2, 7, 'team-2')).toBeNull()
  })

  it('handles three teams', () => {
    // Built by hand rather than from a manifest: `validateManifest` rejects
    // `teamCount` unless `teams` is `fixed`, so an auto-balanced game cannot
    // declare more than two sides today. That is an SDK contract gap, not a
    // platform one — the balance maths below is `teamCount`-general, and an ADR
    // to the CTO is what lets a manifest reach it.
    const auto3: SeatingPolicy = { ...auto2of6, teamCount: 3 }
    const seats = assignTeams(seatsOf(['a', 'b', 'c', 'd', 'e', 'f']), auto3)
    expect([...teamSizes(seats, auto3).values()]).toEqual([2, 2, 2])
    const moved = moveToTeam(seats, auto3, 0, 'team-3') as typeof seats
    expect(moved[0]?.teamId).toBe('team-3')
    const sizes = [...teamSizes(moved, auto3).values()]
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
  })
})

describe('rotateOccupants', () => {
  it('shifts every occupant by one, keeping the seats put', () => {
    const rotated = rotateOccupants(seatsOf(['a', 'b', 'c']), 1)
    expect(occupantsOf(rotated)).toEqual(['c', 'a', 'b'])
  })

  it('swaps a two-player room, which is how colours alternate', () => {
    expect(occupantsOf(rotateOccupants(seatsOf(['a', 'b']), 1))).toEqual(['b', 'a'])
  })

  it('leaves teams with the seats, not the players', () => {
    // Under fixed teams, rotating the occupants is the *only* way to change who
    // plays which role. Rotating the labels instead would change nothing.
    const seats = assignTeams(seatsOf(['a', 'b', 'c', 'd']), fixed2)
    const rotated = rotateOccupants(seats, 1)
    expect(teamsOf(rotated)).toEqual(teamsOf(seats))
    expect(occupantsOf(rotated)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('rotates only among occupied seats, never into a gap', () => {
    // Rotating across an empty seat would teleport a player into it and change
    // the team balance, and in a half-full room would visibly do nothing.
    const rotated = rotateOccupants(seatsOf(['a', null, 'b', null]), 1)
    expect(occupantsOf(rotated)).toEqual(['b', null, 'a', null])
  })

  it('is the identity for an offset that is a multiple of the headcount', () => {
    const seats = seatsOf(['a', 'b', 'c'])
    expect(occupantsOf(rotateOccupants(seats, 3))).toEqual(['a', 'b', 'c'])
    expect(occupantsOf(rotateOccupants(seats, 0))).toEqual(['a', 'b', 'c'])
  })

  it('normalises a negative offset instead of producing holes', () => {
    expect(occupantsOf(rotateOccupants(seatsOf(['a', 'b', 'c']), -1))).toEqual(['b', 'c', 'a'])
  })

  it('normalises an offset larger than the headcount', () => {
    expect(occupantsOf(rotateOccupants(seatsOf(['a', 'b', 'c']), 7))).toEqual(['c', 'a', 'b'])
  })

  it('is a no-op for fewer than two occupants', () => {
    const one = seatsOf(['a', null])
    expect(rotateOccupants(one, 1)).toBe(one)
    const none = seatsOf([null, null])
    expect(rotateOccupants(none, 1)).toBe(none)
  })

  it('never loses or duplicates an occupant', () => {
    const seats = seatsOf(['a', 'b', 'c', 'd', 'e', null])
    for (let offset = -8; offset <= 8; offset += 1) {
      const rotated = rotateOccupants(seats, offset)
      const occupants = occupantsOf(rotated).filter((id) => id !== null)
      expect([...occupants].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    }
  })
})

describe('teamSizes', () => {
  it('reports declared teams with nobody in them', () => {
    expect([...teamSizes(seatsOf([null, null, null, null]), auto2).keys()]).toEqual([
      'team-1',
      'team-2',
    ])
  })

  it('is empty without teams', () => {
    expect([...teamSizes(seatsOf(['a', 'b']), noTeams).keys()]).toEqual([])
  })

  it('ignores a team id on an empty seat', () => {
    const sizes = teamSizes(seatsOf([null, null], ['team-1', 'team-1']), auto2of6)
    expect(sizes.get('team-1')).toBe(0)
  })
})
