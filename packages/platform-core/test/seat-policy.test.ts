import { describe, expect, it } from 'vitest'
import { toCatalogEntry } from '@playhall/game-sdk'
import {
  AUTO_START_COUNTDOWN_MS,
  LATE_JOIN_MODES,
  REMATCH_ROTATIONS,
  START_MODES,
  seatingPolicyFor,
  teamIdsFor,
} from '../src/seats/policy.js'
import { entryWithDeclarations, makeGame } from './fixtures/games.js'

const entryFor = (options: Parameters<typeof makeGame>[0]) =>
  toCatalogEntry(makeGame(options).manifest)

describe('seatingPolicyFor', () => {
  it('derives auto_when_full for a game with one playable roster', () => {
    const policy = seatingPolicyFor(entryFor({ slug: 'duel', minPlayers: 2, maxPlayers: 2 }))
    expect(policy.startMode).toBe('auto_when_full')
  })

  it('derives host_starts for a game with a player range', () => {
    const policy = seatingPolicyFor(entryFor({ slug: 'party', minPlayers: 3, maxPlayers: 8 }))
    expect(policy.startMode).toBe('host_starts')
  })

  it('defaults late join to spectate_only when the game declares nothing', () => {
    // The conservative answer, and the behaviour the join matrix had before the
    // rule was declarable — so no existing game changes shape.
    expect(seatingPolicyFor(entryFor({ slug: 'quiet' })).lateJoin).toBe('spectate_only')
  })

  it('honours a declared late-join mode', () => {
    const entry = entryWithDeclarations(makeGame({ slug: 'tag' }), {
      lateJoin: 'fill_empty_seats',
    })
    expect(seatingPolicyFor(entry).lateJoin).toBe('fill_empty_seats')
  })

  it('honours a declared rematch rotation over the derived default', () => {
    const entry = entryWithDeclarations(makeGame({ slug: 'solo-ish' }), {
      rematchRotation: 'none',
    })
    // A team-less game would otherwise derive `seats`.
    expect(seatingPolicyFor(entry).rematchRotation).toBe('none')
  })

  it('derives the rotation from the team mode when the game declares none', () => {
    expect(seatingPolicyFor(entryFor({ slug: 'a', teams: 'none' })).rematchRotation).toBe('seats')
    expect(
      seatingPolicyFor(entryFor({ slug: 'b', teams: 'auto-balanced', maxPlayers: 4 }))
        .rematchRotation,
    ).toBe('teams')
    // A fixed-team game owns its seat-to-team map, so the platform does not
    // re-draw it.
    expect(
      seatingPolicyFor(entryFor({ slug: 'c', teams: 'fixed', teamCount: 2, maxPlayers: 4 }))
        .rematchRotation,
    ).toBe('none')
  })

  it('gives an auto-balanced game without a declared count two teams', () => {
    const policy = seatingPolicyFor(entryFor({ slug: 'pairs', teams: 'auto-balanced' }))
    expect(policy.teamCount).toBe(2)
  })

  it('carries no team count for a team-less game', () => {
    expect(seatingPolicyFor(entryFor({ slug: 'solo' })).teamCount).toBeNull()
  })

  it('never reads a game id', () => {
    // Two games with different ids and identical manifest fields must produce
    // identical policies. This is the "games are plugins" invariant expressed as
    // a test rather than a comment.
    const a = seatingPolicyFor(entryFor({ slug: 'alpha', id: 'alpha' }))
    const b = seatingPolicyFor(entryFor({ slug: 'beta', id: 'beta' }))
    expect(a).toEqual(b)
  })
})

describe('teamIdsFor', () => {
  it('is empty for a team-less game', () => {
    expect(teamIdsFor(seatingPolicyFor(entryFor({ slug: 'solo' })))).toEqual([])
  })

  it('names teams from one, in canonical order', () => {
    const policy = seatingPolicyFor(
      entryFor({ slug: 'three', teams: 'fixed', teamCount: 3, maxPlayers: 6 }),
    )
    expect(teamIdsFor(policy)).toEqual(['team-1', 'team-2', 'team-3'])
  })
})

describe('declared constants', () => {
  it('counts down for three seconds', () => {
    expect(AUTO_START_COUNTDOWN_MS).toBe(3_000)
  })

  it('keeps the enumerations exhaustive', () => {
    expect([...LATE_JOIN_MODES]).toEqual(['spectate_only', 'fill_empty_seats'])
    expect([...START_MODES]).toEqual(['auto_when_full', 'host_starts'])
    expect([...REMATCH_ROTATIONS]).toEqual(['none', 'seats', 'teams'])
  })
})
