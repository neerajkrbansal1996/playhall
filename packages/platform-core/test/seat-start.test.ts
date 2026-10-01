import { describe, expect, it } from 'vitest'
import { toCatalogEntry } from '@playhall/game-sdk'
import {
  AUTO_START_COUNTDOWN_MS,
  type SeatingPolicy,
  seatingPolicyFor,
} from '../src/seats/policy.js'
import {
  START_BLOCK_REASONS,
  evaluateAutoStart,
  resolveHostStart,
  seatingSnapshot,
  startBlockers,
} from '../src/seats/start.js'
import { makeGame } from './fixtures/games.js'
import { T0, makeRoom } from './fixtures/rooms.js'

const policyFor = (options: Parameters<typeof makeGame>[0]): SeatingPolicy =>
  seatingPolicyFor(toCatalogEntry(makeGame(options).manifest))

/** A duel: min === max, so it auto-starts when it fills. */
const duel = policyFor({ slug: 'duel', minPlayers: 2, maxPlayers: 2 })
/** A party game: a player range, so the host presses Start. */
const party = policyFor({ slug: 'party', minPlayers: 3, maxPlayers: 6 })
const teamed = policyFor({
  slug: 'teamed',
  teams: 'auto-balanced',
  minPlayers: 4,
  maxPlayers: 4,
})
const withBots = policyFor({
  slug: 'bots',
  minPlayers: 2,
  maxPlayers: 2,
  supportsBots: true,
})

const NOW = T0 + 10_000

describe('seatingSnapshot', () => {
  it('counts seated and ready players', () => {
    const room = makeRoom({ seats: ['a', 'b', 'c', null], notReady: [1] })
    const snapshot = seatingSnapshot(room, party)
    expect(snapshot.seated).toBe(3)
    expect(snapshot.ready).toBe(2)
  })

  it('reports a full room', () => {
    expect(seatingSnapshot(makeRoom({ seats: ['a', 'b'] }), duel).full).toBe(true)
    expect(seatingSnapshot(makeRoom({ seats: ['a', null] }), duel).full).toBe(false)
  })

  it('counts a bot seat towards full but not towards the headcount', () => {
    // The room has no free seat for a person, yet it is a player short — so the
    // two facts are reported separately rather than collapsed.
    const room = makeRoom({ seats: ['a', null], botSeats: [1] })
    const snapshot = seatingSnapshot(room, withBots)
    expect(snapshot.full).toBe(true)
    expect(snapshot.seated).toBe(1)
    expect(snapshot.unfilledBotSeats).toBe(1)
  })

  it('explains the wait rather than just refusing', () => {
    // The lobby renders this. A greyed-out button with no reason is the failure
    // mode it exists to avoid.
    const room = makeRoom({ seats: ['a', 'b', null, null, null, null] })
    expect(seatingSnapshot(room, party).blockers).toContain('below_min_players')
  })
})

describe('startBlockers', () => {
  it('is empty for a full, ready duel', () => {
    expect(startBlockers(makeRoom({ seats: ['a', 'b'] }), duel)).toEqual([])
  })

  it('refuses a duel with a free seat', () => {
    expect(startBlockers(makeRoom({ seats: ['a', null] }), duel)).toContain('not_full')
  })

  it('does not require a full room for a host-started game', () => {
    // Only `auto_when_full` requires it; a party game starting at 3 of 6 is the
    // whole point of the mode.
    const room = makeRoom({ seats: ['a', 'b', 'c', null, null, null] })
    expect(startBlockers(room, party)).toEqual([])
  })

  it('refuses a host-started game below minPlayers', () => {
    const room = makeRoom({ seats: ['a', 'b', null, null, null, null] })
    expect(startBlockers(room, party)).toEqual(['below_min_players'])
  })

  it('refuses an outstanding ready check', () => {
    const room = makeRoom({ seats: ['a', 'b'], notReady: [1] })
    expect(startBlockers(room, duel)).toEqual(['awaiting_ready'])
  })

  it('lets the host override readiness, and nothing else', () => {
    // A host can see whether they are waiting for a person or for someone who
    // wandered off. They cannot start a roster the game cannot run.
    const notReady = makeRoom({ seats: ['a', 'b'], notReady: [1] })
    expect(startBlockers(notReady, duel, true)).toEqual([])

    const short = makeRoom({ seats: ['a', null, null, null, null, null] })
    expect(startBlockers(short, party, true)).toEqual(['below_min_players'])
  })

  it('refuses an unfillable bot seat even with a host override', () => {
    const room = makeRoom({ seats: ['a', null], botSeats: [1] })
    expect(startBlockers(room, withBots, true)).toContain('bot_seat_unfilled')
  })

  it('refuses unbalanced teams even with a host override', () => {
    const room = makeRoom({
      seats: ['a', 'b', 'c', 'd'],
      teamIds: ['team-1', 'team-1', 'team-1', 'team-2'],
    })
    expect(startBlockers(room, teamed, true)).toContain('teams_unbalanced')
  })

  it('refuses a room that is not a lobby', () => {
    expect(startBlockers(makeRoom({ seats: ['a', 'b'], status: 'in_progress' }), duel)).toContain(
      'not_in_lobby',
    )
    // A finished room restarts through `applyRematch`, which re-crews it. Letting
    // `start` act on one would begin a second match without clearing the first.
    expect(startBlockers(makeRoom({ seats: ['a', 'b'], status: 'finished' }), duel)).toContain(
      'not_in_lobby',
    )
  })

  it('keeps the reason enumeration exhaustive', () => {
    expect([...START_BLOCK_REASONS]).toEqual([
      'not_in_lobby',
      'below_min_players',
      'not_full',
      'awaiting_ready',
      'bot_seat_unfilled',
      'teams_unbalanced',
    ])
  })
})

describe('evaluateAutoStart — the fixed-size path', () => {
  it('arms a 3-second countdown when the room fills', () => {
    const room = makeRoom({ seats: ['a', 'b'] })
    expect(evaluateAutoStart(room, duel, NOW)).toEqual({
      action: 'arm',
      endsAt: NOW + AUTO_START_COUNTDOWN_MS,
    })
  })

  it('does nothing while a seat is free', () => {
    expect(evaluateAutoStart(makeRoom({ seats: ['a', null] }), duel, NOW)).toEqual({
      action: 'none',
    })
  })

  it('does not re-arm an already-armed countdown', () => {
    // Re-arming would push the deadline out on every tick, so the match would
    // never start.
    const room = makeRoom({ seats: ['a', 'b'], startCountdownEndsAt: NOW + 1_000 })
    expect(evaluateAutoStart(room, duel, NOW)).toEqual({ action: 'none' })
  })

  it('cancels when a player un-readies inside the window', () => {
    // Un-ready is the escape hatch for a mistaken tap on a shared link.
    const room = makeRoom({
      seats: ['a', 'b'],
      notReady: [1],
      startCountdownEndsAt: NOW + 1_000,
    })
    expect(evaluateAutoStart(room, duel, NOW)).toEqual({ action: 'cancel' })
  })

  it('re-arms after the roster qualifies again', () => {
    const ready = makeRoom({ seats: ['a', 'b'] })
    expect(evaluateAutoStart(ready, duel, NOW).action).toBe('arm')
  })

  it('starts once the deadline has passed', () => {
    const room = makeRoom({ seats: ['a', 'b'], startCountdownEndsAt: NOW })
    expect(evaluateAutoStart(room, duel, NOW)).toEqual({ action: 'start' })
  })

  it('starts on the deadline even if the roster has since stopped qualifying', () => {
    // Reaching the deadline is the commitment. Re-checking here would let a
    // player un-readying in the same millisecond win a race against a match
    // every other client has already been told is starting.
    const room = makeRoom({
      seats: ['a', 'b'],
      notReady: [1],
      startCountdownEndsAt: NOW - 1,
    })
    expect(evaluateAutoStart(room, duel, NOW)).toEqual({ action: 'start' })
  })

  it('is total in (room, now), so a restart recovers the same answer', () => {
    const room = makeRoom({ seats: ['a', 'b'], startCountdownEndsAt: NOW + 500 })
    expect(evaluateAutoStart(room, duel, NOW)).toEqual(evaluateAutoStart(room, duel, NOW))
    expect(evaluateAutoStart(room, duel, NOW + 1_000).action).toBe('start')
  })
})

describe('evaluateAutoStart — the host-started path', () => {
  it('never arms a countdown', () => {
    const full = makeRoom({ seats: ['a', 'b', 'c', 'd', 'e', 'f'] })
    expect(evaluateAutoStart(full, party, NOW)).toEqual({ action: 'none' })
  })

  it('disarms a stale countdown rather than starting behind the host', () => {
    const room = makeRoom({
      seats: ['a', 'b', 'c', null, null, null],
      startCountdownEndsAt: NOW + 1_000,
    })
    expect(evaluateAutoStart(room, party, NOW)).toEqual({ action: 'cancel' })
  })

  it('still fires a countdown that has already expired', () => {
    // The deadline is the commitment whatever the mode; leaving it armed and
    // never firing would strand the room.
    const room = makeRoom({ seats: ['a', 'b', 'c'], startCountdownEndsAt: NOW - 1 })
    expect(evaluateAutoStart(room, party, NOW)).toEqual({ action: 'start' })
  })

  it('does nothing for a room with no countdown', () => {
    const room = makeRoom({ seats: ['a', 'b', 'c', null, null, null] })
    expect(evaluateAutoStart(room, party, NOW)).toEqual({ action: 'none' })
  })
})

describe('resolveHostStart', () => {
  it('lets the host start a qualifying room', () => {
    const room = makeRoom({ seats: ['a', 'b', 'c', null, null, null], hostPlayerId: 'a' })
    expect(resolveHostStart(room, party, 'a')).toEqual({ ok: true })
  })

  it('refuses a non-host separately from a roster problem', () => {
    // The caller should refuse the actor, not explain the roster to them.
    const room = makeRoom({ seats: ['a', 'b', 'c', null, null, null], hostPlayerId: 'a' })
    expect(resolveHostStart(room, party, 'b')).toEqual({ ok: false, reasons: [], notHost: true })
  })

  it('reports the roster reasons to the host', () => {
    const room = makeRoom({ seats: ['a', null, null, null, null, null], hostPlayerId: 'a' })
    const resolution = resolveHostStart(room, party, 'a')
    expect(resolution.ok).toBe(false)
    expect(resolution.ok === false && resolution.reasons).toEqual(['below_min_players'])
  })

  it('lets the host skip the countdown of a full auto-start room', () => {
    // Two players who are plainly ready should not have to watch three seconds
    // elapse, and that is the host's call.
    const room = makeRoom({
      seats: ['a', 'b'],
      hostPlayerId: 'a',
      startCountdownEndsAt: NOW + 2_000,
    })
    expect(resolveHostStart(room, duel, 'a')).toEqual({ ok: true })
  })

  it('honours the host override for readiness', () => {
    const room = makeRoom({ seats: ['a', 'b'], hostPlayerId: 'a', notReady: [1] })
    expect(resolveHostStart(room, duel, 'a')).toEqual({
      ok: false,
      reasons: ['awaiting_ready'],
    })
    expect(resolveHostStart(room, duel, 'a', { force: true })).toEqual({ ok: true })
  })
})
