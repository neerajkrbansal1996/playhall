import { describe, expect, it } from 'vitest'
import { toCatalogEntry } from '@playhall/game-sdk'
import { type Room, reviseRoom } from '../src/rooms/types.js'
import { type SeatingPolicy, seatingPolicyFor } from '../src/seats/policy.js'
import {
  REMATCH_REJECTIONS,
  rematchRevision,
  resolveRematch,
  sameSeatsRematchRevision,
  tallyRematch,
  withRematchVote,
  withoutRematchVote,
} from '../src/seats/rematch.js'
import { makeGame } from './fixtures/games.js'
import { T0, makeRoom } from './fixtures/rooms.js'

const policyFor = (options: Parameters<typeof makeGame>[0]): SeatingPolicy =>
  seatingPolicyFor(toCatalogEntry(makeGame(options).manifest))

/** Team-less: the derived rotation is `seats`. */
const duel = policyFor({ slug: 'duel', minPlayers: 2, maxPlayers: 2 })
/** Auto-balanced: the derived rotation is `teams`. */
const teamed = policyFor({
  slug: 'teamed',
  teams: 'auto-balanced',
  minPlayers: 4,
  maxPlayers: 4,
})
/** Fixed teams: the derived rotation is `none` — the game owns the map. */
const fixed = policyFor({
  slug: 'fixed',
  teams: 'fixed',
  teamCount: 2,
  minPlayers: 4,
  maxPlayers: 4,
})
const quad = policyFor({ slug: 'quad', minPlayers: 2, maxPlayers: 4 })

const NOW = T0 + 60_000

/** A finished room, everyone present, nobody having voted yet. */
function finished(overrides: Parameters<typeof makeRoom>[0] = {}): Room {
  return makeRoom({
    status: 'finished',
    finishedAt: T0 + 1_000,
    currentMatchId: 'match-1',
    ...overrides,
  })
}

/** Applies a revision the way the service does, through `reviseRoom`. */
const apply = (room: Room, policy: SeatingPolicy, now = NOW): Room =>
  reviseRoom(room, rematchRevision(room, policy, now), now)

const occupantsOf = (room: Room) => room.seats.map((seat) => seat.occupantPlayerId)

describe('tallyRematch', () => {
  it('counts seated, present players as the electorate', () => {
    const room = finished({ seats: ['a', 'b'], presentPlayerIds: ['a', 'b'] })
    expect(tallyRematch(room).eligible).toEqual(['a', 'b'])
  })

  it('excludes an absent player, so a dead phone is not a veto', () => {
    // Three friends waiting on a fourth who went home would otherwise sit in a
    // finished room until the 15-minute window closed.
    const room = finished({ seats: ['a', 'b', 'c', 'd'], presentPlayerIds: ['a', 'b', 'c'] })
    expect(tallyRematch(room).eligible).toEqual(['a', 'b', 'c'])
  })

  it('excludes spectators', () => {
    const room = finished({
      seats: ['a', 'b'],
      spectatorPlayerIds: ['w'],
      presentPlayerIds: ['a', 'b', 'w'],
    })
    expect(tallyRematch(room).eligible).not.toContain('w')
  })

  it('is unanimous once everybody present has voted', () => {
    const room = finished({
      seats: ['a', 'b'],
      presentPlayerIds: ['a', 'b'],
      rematchVotes: ['a', 'b'],
    })
    expect(tallyRematch(room).unanimous).toBe(true)
  })

  it('ignores the vote of an absent player', () => {
    const room = finished({
      seats: ['a', 'b'],
      presentPlayerIds: ['a'],
      rematchVotes: ['a', 'b'],
    })
    const tally = tallyRematch(room)
    expect(tally.voted).toEqual(['a'])
    expect(tally.unanimous).toBe(true)
  })

  it('is never unanimous with nobody present', () => {
    // Otherwise an empty room would start a match with no players in it.
    const room = finished({ seats: ['a', 'b'], presentPlayerIds: [], rematchVotes: [] })
    expect(tallyRematch(room).unanimous).toBe(false)
  })
})

describe('resolveRematch', () => {
  it('starts once everyone present agrees', () => {
    const room = finished({
      seats: ['a', 'b'],
      presentPlayerIds: ['a', 'b'],
      rematchVotes: ['a', 'b'],
    })
    expect(resolveRematch(room, duel, 'b').ok).toBe(true)
  })

  it('waits, reporting the tally, while a vote is outstanding', () => {
    const room = finished({
      seats: ['a', 'b'],
      presentPlayerIds: ['a', 'b'],
      rematchVotes: ['a'],
    })
    const resolution = resolveRematch(room, duel, 'a')
    expect(resolution.ok).toBe(false)
    expect(resolution.ok === false && resolution.code).toBe('awaiting_votes')
    expect(resolution.ok === false && 'tally' in resolution && resolution.tally.voted).toEqual([
      'a',
    ])
  })

  it('refuses a room that has not finished', () => {
    const room = makeRoom({ seats: ['a', 'b'], presentPlayerIds: ['a', 'b'] })
    expect(resolveRematch(room, duel, 'a')).toEqual({ ok: false, code: 'match_not_finished' })
  })

  it('refuses a spectator', () => {
    const room = finished({
      seats: ['a', 'b'],
      spectatorPlayerIds: ['w'],
      presentPlayerIds: ['a', 'b', 'w'],
    })
    expect(resolveRematch(room, duel, 'w')).toEqual({ ok: false, code: 'not_seated' })
  })

  it('refuses when too few players remain to fill the game', () => {
    const room = finished({ seats: ['a', 'b'], presentPlayerIds: ['a'], rematchVotes: ['a'] })
    expect(resolveRematch(room, duel, 'a')).toEqual({ ok: false, code: 'below_min_players' })
  })

  it('lets the host force a rematch past a missing vote', () => {
    const room = finished({
      seats: ['a', 'b'],
      hostPlayerId: 'a',
      presentPlayerIds: ['a', 'b'],
      rematchVotes: ['a'],
    })
    expect(resolveRematch(room, duel, 'a', { force: true }).ok).toBe(true)
  })

  it('refuses a force from a non-host', () => {
    const room = finished({
      seats: ['a', 'b'],
      hostPlayerId: 'a',
      presentPlayerIds: ['a', 'b'],
      rematchVotes: ['b'],
    })
    expect(resolveRematch(room, duel, 'b', { force: true })).toEqual({
      ok: false,
      code: 'not_host',
    })
  })

  it('keeps the rejection enumeration exhaustive', () => {
    expect([...REMATCH_REJECTIONS]).toEqual([
      'match_not_finished',
      'not_seated',
      'below_min_players',
      'not_host',
    ])
  })
})

describe('votes', () => {
  it('records a vote', () => {
    const room = finished({ seats: ['a', 'b'] })
    expect(withRematchVote(room, 'a')).toEqual({ rematchVotes: ['a'] })
  })

  it('is idempotent — voting twice is one vote', () => {
    const room = finished({ seats: ['a', 'b'], rematchVotes: ['a'] })
    expect(withRematchVote(room, 'a')).toEqual({})
  })

  it('withdraws a vote', () => {
    const room = finished({ seats: ['a', 'b'], rematchVotes: ['a', 'b'] })
    expect(withoutRematchVote(room, 'a')).toEqual({ rematchVotes: ['b'] })
  })

  it('ignores withdrawing a vote nobody cast', () => {
    expect(withoutRematchVote(finished({ seats: ['a', 'b'] }), 'a')).toEqual({})
  })
})

describe('rematchRevision — the room becomes a lobby again', () => {
  const room = finished({
    seats: ['a', 'b'],
    presentPlayerIds: ['a', 'b'],
    rematchVotes: ['a', 'b'],
    secondPlayerJoinedAt: T0,
  })

  it('returns to a lobby and clears the match', () => {
    const next = apply(room, duel)
    expect(next.status).toBe('lobby')
    expect(next.finishedAt).toBeNull()
    // The match record lives in Postgres and outlives the room; the *room* must
    // stop claiming a finished match is in it.
    expect(next.currentMatchId).toBeNull()
  })

  it('keeps the code, so the link in the group chat still works', () => {
    expect(apply(room, duel).code).toBe(room.code)
  })

  it('clears the votes and counts the match', () => {
    const next = apply(room, duel)
    expect(next.rematchVotes).toEqual([])
    expect(next.matchesPlayed).toBe(1)
  })

  it('leaves the countdown to be armed by the next tick, not here', () => {
    // One place owns the 3-second rule; arming it here would let the two disagree.
    expect(apply(room, duel).startCountdownEndsAt).toBeNull()
  })

  it('readies everyone, because they have just voted for this match', () => {
    expect(apply(room, duel).seats.every((seat) => seat.isReady)).toBe(true)
  })

  it('keeps the room out of the no-opponent expiry', () => {
    // A match was demonstrably played here. A null would let the 30-minute timer
    // expire a lobby full of people mid-conversation about their next game.
    const never = finished({
      seats: ['a', 'b'],
      presentPlayerIds: ['a', 'b'],
      secondPlayerJoinedAt: null,
    })
    expect(apply(never, duel).secondPlayerJoinedAt).toBe(NOW)
  })

  it('does not re-stamp an existing second-player time', () => {
    expect(apply(room, duel).secondPlayerJoinedAt).toBe(T0)
  })

  it('frees the seat of a player who is no longer present', () => {
    // They are not in the electorate, so keeping their seat would either block
    // minPlayers or start a match with a seat nobody is behind.
    const gone = finished({
      seats: ['a', 'b', 'c', 'd'],
      presentPlayerIds: ['a', 'b', 'c'],
    })
    const next = apply(gone, quad)
    expect(next.seats.filter((seat) => seat.occupantPlayerId !== null)).toHaveLength(3)
    expect(occupantsOf(next)).not.toContain('d')
  })
})

describe('rematchRevision — rotation', () => {
  it('rotates seats for a team-less game, so turn order advances', () => {
    const room = finished({
      seats: ['a', 'b'],
      presentPlayerIds: ['a', 'b'],
      matchesPlayed: 0,
    })
    expect(occupantsOf(apply(room, duel))).toEqual(['b', 'a'])
  })

  it('advances by exactly one seat per match, cycling every arrangement', () => {
    // The offset is applied to the seats as they already are, so it is a
    // constant one. Using `matchesPlayed` would compound — 1, then 3, then 6
    // seats cumulatively — and three players would land back on their original
    // seating twice in a row instead of cycling.
    let room: Room = finished({
      seats: ['a', 'b', 'c', null],
      presentPlayerIds: ['a', 'b', 'c'],
    })
    const seen: string[] = []
    for (let match = 0; match < 3; match += 1) {
      room = apply(room, quad)
      seen.push(
        occupantsOf(room)
          .filter((id): id is string => id !== null)
          .join(','),
      )
      room = { ...room, status: 'finished', finishedAt: NOW, presentPlayerIds: ['a', 'b', 'c'] }
    }
    // Every arrangement, once each, then back to the start.
    expect(seen).toEqual(['c,a,b', 'b,c,a', 'a,b,c'])
  })

  it('keeps the seats put under fixed teams and re-crews them', () => {
    // Rotating the occupants is the only way to change who plays which role when
    // the seat-to-team map belongs to the game.
    const room = finished({
      seats: ['a', 'b', 'c', 'd'],
      presentPlayerIds: ['a', 'b', 'c', 'd'],
    })
    const next = apply(room, { ...fixed, rematchRotation: 'seats' })
    expect(next.seats.map((seat) => seat.teamId)).toEqual(['team-1', 'team-2', 'team-1', 'team-2'])
    expect(occupantsOf(next)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('re-draws the sides for an auto-balanced game without moving anyone', () => {
    const room = finished({
      seats: ['a', 'b', 'c', 'd'],
      teamIds: ['team-1', 'team-1', 'team-2', 'team-2'],
      presentPlayerIds: ['a', 'b', 'c', 'd'],
    })
    const next = apply(room, teamed)
    // Seats unchanged — `teams` rotation re-forms the sides, it does not move
    // players between chairs.
    expect(occupantsOf(next)).toEqual(['a', 'b', 'c', 'd'])
    const sizes = next.seats.reduce<Record<string, number>>((counts, seat) => {
      if (seat.teamId !== null) counts[seat.teamId] = (counts[seat.teamId] ?? 0) + 1
      return counts
    }, {})
    expect(Object.values(sizes)).toEqual([2, 2])
  })

  it('leaves everything in place for a fixed-team game, which is the derived default', () => {
    const room = finished({
      seats: ['a', 'b', 'c', 'd'],
      presentPlayerIds: ['a', 'b', 'c', 'd'],
    })
    expect(fixed.rematchRotation).toBe('none')
    expect(occupantsOf(apply(room, fixed))).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('sameSeatsRematchRevision — "new game, same people"', () => {
  it('keeps the seats however the game would have rotated them', () => {
    // The button promises the seats stay as they are. Honouring that must not
    // depend on what the game declared.
    const room = finished({ seats: ['a', 'b'], presentPlayerIds: ['a', 'b'] })
    expect(duel.rematchRotation).toBe('seats')
    const next = reviseRoom(room, sameSeatsRematchRevision(room, duel, NOW), NOW)
    expect(occupantsOf(next)).toEqual(['a', 'b'])
    expect(next.status).toBe('lobby')
  })

  it("still frees an absent player's seat", () => {
    const room = finished({
      seats: ['a', 'b', 'c', null],
      presentPlayerIds: ['a', 'b'],
    })
    const next = reviseRoom(room, sameSeatsRematchRevision(room, quad, NOW), NOW)
    expect(occupantsOf(next)).toEqual(['a', 'b', null, null])
  })
})
