/**
 * The seat service: the *order* the seat rules run in.
 *
 * Everything the service composes is pure and tested next door — the team maths
 * in `seat-teams`, succession in `seat-host`, the start rules in `seat-start`,
 * the rematch revision in `seat-rematch`. What is only testable here is what the
 * service's docstring claims for itself, so those four claims are what this file
 * is organised around:
 *
 * 1. Actor guards run **inside** the compare-and-set loop, against state read in
 *    the same attempt. `the guard runs against fresh state` is the load-bearing
 *    test: it is the one that fails if somebody hoists a guard out of the loop
 *    for readability, and the failure mode it prevents — a host who lost the
 *    crown mid-tick still being able to kick — is a privilege escalation.
 * 2. Teams are re-derived after *every* seat change.
 * 3. A seat change invalidates the start agreement.
 * 4. Nothing reads a game id; an unresolvable game is a refusal, not a default.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createFeatureFlags } from '../src/flags.js'
import { createGameRegistry } from '../src/registry/registry.js'
import { createInMemoryRoomStore, type RoomStore } from '../src/rooms/store.js'
import type { Room } from '../src/rooms/types.js'
import { fixedClock, type MutableClock } from '../src/runtime.js'
import type { BotSeatProvider } from '../src/seats/bots.js'
import { AUTO_START_COUNTDOWN_MS } from '../src/seats/policy.js'
import {
  createSeatService,
  type SeatMutationResult,
  type SeatService,
} from '../src/seats/service.js'
import { makeGame, registrationFor } from './fixtures/games.js'
import { makeRoom, T0, type RoomOverrides } from './fixtures/rooms.js'

/** `makeRoom`'s default game id, so an unqualified room resolves. */
const DUEL = 'fixture'
/** Variable-size: `minPlayers !== maxPlayers`, so `host_starts`. */
const PARTY = 'game-party'
/** Four seats, platform-owned sides. */
const SQUADS = 'game-squads'
/** Four seats, game-owned sides: the seat index decides the team. */
const RELAY = 'game-relay'
const BOTTED = 'game-botted'

const provider: BotSeatProvider = {
  id: 'stub',
  supports: (gameId) => gameId === BOTTED,
  claim: async () => ({ playerId: 'bot-1', displayName: 'Bot', isBot: true }),
  release: async () => {},
}

interface Harness {
  readonly service: SeatService
  readonly store: RoomStore
  readonly clock: MutableClock
  /** Seeds a room and returns it. */
  seed(overrides?: RoomOverrides): Promise<Room>
}

async function harness(
  options: { readonly botProviders?: readonly BotSeatProvider[] } = {},
): Promise<Harness> {
  const clock = fixedClock(T0)
  const store = createInMemoryRoomStore()
  const flags = createFeatureFlags()
  const registry = await createGameRegistry({
    registrations: [
      makeGame({ slug: DUEL, id: DUEL }),
      makeGame({ slug: 'party', id: PARTY, minPlayers: 2, maxPlayers: 4 }),
      makeGame({
        slug: 'squads',
        id: SQUADS,
        minPlayers: 4,
        maxPlayers: 4,
        teams: 'auto-balanced',
      }),
      makeGame({
        slug: 'relay',
        id: RELAY,
        minPlayers: 4,
        maxPlayers: 4,
        teams: 'fixed',
        teamCount: 2,
      }),
      makeGame({ slug: 'botted', id: BOTTED, supportsBots: true }),
    ].map(registrationFor),
    flags,
  })
  const service = createSeatService({
    store,
    registry,
    clock,
    ...(options.botProviders === undefined ? {} : { botProviders: options.botProviders }),
  })
  return {
    service,
    store,
    clock,
    async seed(overrides: RoomOverrides = {}) {
      const room = makeRoom(overrides)
      await store.insert(room)
      return room
    },
  }
}

let h: Harness
beforeEach(async () => {
  h = await harness()
})

/** The room a successful mutation produced. Fails loudly on a refusal. */
function applied(result: SeatMutationResult): Room {
  if (!result.ok) {
    throw new Error(
      `expected a write, got ${JSON.stringify('refused' in result ? result.refused : result.error)}`,
    )
  }
  return result.room
}

/** The refusal reason, for the `refused` code specifically. */
function refusal(result: SeatMutationResult): unknown {
  if (result.ok) throw new Error('expected a refusal, got a write')
  return 'refused' in result ? result.refused : result.error
}

const occupants = (room: Room) => room.seats.map((seat) => seat.occupantPlayerId)
const teams = (room: Room) => room.seats.map((seat) => seat.teamId)

describe('the game must resolve before any seat rule is applied', () => {
  // Claim 4. A room whose game core cannot resolve has no seating rules, and
  // guessing them is how a two-player game gets started with five.
  it('refuses every mutation for an unregistered game', async () => {
    await h.seed({ gameId: 'not-registered' })
    expect(refusal(await h.service.setReady('room-1', 'host', true))).toEqual({
      code: 'game_unavailable',
    })
    expect(refusal(await h.service.start('room-1', 'host'))).toEqual({
      code: 'game_unavailable',
    })
    expect(refusal(await h.service.kick('room-1', 'host', 'b'))).toEqual({
      code: 'game_unavailable',
    })
  })

  it('refuses the read too, rather than serving an unredactable room', async () => {
    await h.seed({ gameId: 'not-registered' })
    expect(await h.service.view('room-1', 'host')).toBeNull()
  })

  it('reports no policy for a room whose game is gone', async () => {
    expect(h.service.policyFor(makeRoom({ gameId: 'not-registered' }))).toBeNull()
  })

  it('projects the policy from the manifest, never from the id', async () => {
    // Two games, same core, different rules — and the only difference the
    // service sees is the projection.
    expect(h.service.policyFor(makeRoom({ gameId: DUEL }))?.startMode).toBe('auto_when_full')
    expect(h.service.policyFor(makeRoom({ gameId: PARTY }))?.startMode).toBe('host_starts')
  })

  it('answers a missing room as not found, not as a refusal', async () => {
    expect(refusal(await h.service.setReady('nope', 'host', true))).toEqual({
      code: 'room_not_found',
    })
    expect(await h.service.view('nope', 'host')).toBeNull()
  })

  it('refuses to revise a closed room', async () => {
    await h.seed({ status: 'closed', closedAt: T0, closeReason: 'host_closed' })
    expect(refusal(await h.service.setReady('room-1', 'host', true))).toEqual({
      code: 'room_closed',
      closeReason: 'host_closed',
    })
  })
})

describe('guards run inside the compare-and-set loop', () => {
  /**
   * A store whose first save loses the race, and loses it to a write that moves
   * the crown. The second attempt therefore reads a room in which the actor is
   * no longer host.
   */
  async function contended(seed: Room): Promise<Harness> {
    const base = await harness()
    await base.store.insert(seed)
    let firstSave = true
    const racing: RoomStore = {
      ...base.store,
      async save(previous, next) {
        if (firstSave) {
          firstSave = false
          await base.store.save(previous, {
            ...previous,
            hostPlayerId: 'rival',
            version: previous.version + 1,
          })
          return false
        }
        return base.store.save(previous, next)
      },
    }
    const flags = createFeatureFlags()
    const registry = await createGameRegistry({
      registrations: [makeGame({ slug: DUEL, id: DUEL })].map(registrationFor),
      flags,
    })
    return {
      ...base,
      store: racing,
      service: createSeatService({ store: racing, registry, clock: base.clock }),
    }
  }

  it('the guard runs against fresh state, so a host who lost the crown cannot act', async () => {
    // The whole reason the guards are not hoisted out of the retry loop. Attempt
    // one passes the host check and loses the write; attempt two must re-judge
    // against the room as it now is, and refuse.
    const raced = await contended(makeRoom({ seats: ['host', 'b'] }))
    const result = await raced.service.transferHost('room-1', 'host', 'b')
    expect(refusal(result)).toEqual({ code: 'refused', reason: 'not_host' })

    const after = await raced.store.get('room-1')
    expect(after?.hostPlayerId).toBe('rival')
  })

  it('retries and rebuilds on the fresh state when the lost race is irrelevant', async () => {
    // The control for the test above. `setReady`'s guard does not care who the
    // host is, so losing the same race must end in a successful write — proving
    // the refusal above comes from re-judging the guard and not from the retry
    // itself being broken. The surviving `rival` is the other half: the retry
    // re-read the room and applied its change on top of the racing write
    // instead of clobbering it back.
    const raced = await contended(makeRoom({ seats: ['host', 'b'], notReady: [1] }))
    const after = applied(await raced.service.setReady('room-1', 'b', true))
    expect(after.seats[1]?.isReady).toBe(true)
    expect(after.hostPlayerId).toBe('rival')
  })
})

describe('setReady', () => {
  it('sets the flag for a seated player', async () => {
    await h.seed({ seats: ['host', 'b'], notReady: [1] })
    const room = applied(await h.service.setReady('room-1', 'b', true))
    expect(room.seats[1]?.isReady).toBe(true)
  })

  it('refuses a player who holds no seat', async () => {
    await h.seed({ seats: ['host', null], spectatorPlayerIds: ['watcher'] })
    expect(refusal(await h.service.setReady('room-1', 'watcher', true))).toEqual({
      code: 'refused',
      reason: 'not_a_member',
    })
  })

  it('un-readying disarms an armed countdown', async () => {
    // The entire point of the flag: a mistaken tap on a shared link is
    // recoverable inside the 3-second window.
    await h.seed({ seats: ['host', 'b'], startCountdownEndsAt: T0 + 3_000 })
    const room = applied(await h.service.setReady('room-1', 'b', false))
    expect(room.startCountdownEndsAt).toBeNull()
  })

  it('re-readying does not re-arm the countdown here', async () => {
    // `tickAutoStart` owns arming, so the 3-second rule lives in one place.
    await h.seed({ seats: ['host', 'b'], notReady: [1] })
    const room = applied(await h.service.setReady('room-1', 'b', true))
    expect(room.startCountdownEndsAt).toBeNull()
  })
})

describe('moveSeat', () => {
  it('swaps a player with whoever is in the target seat', async () => {
    await h.seed({ seats: ['host', 'b', null, null], gameId: PARTY })
    const room = applied(await h.service.moveSeat('room-1', 'host', 1))
    expect(occupants(room)).toEqual(['b', 'host', null, null])
  })

  it('is self-service, not a host privilege', async () => {
    await h.seed({ seats: ['host', 'b', null, null], gameId: PARTY })
    const room = applied(await h.service.moveSeat('room-1', 'b', 2))
    expect(occupants(room)).toEqual(['host', null, 'b', null])
  })

  it('refuses a seat held open for a bot', async () => {
    await h.seed({ seats: ['host', 'b', null, null], botSeats: [2], gameId: PARTY })
    expect(refusal(await h.service.moveSeat('room-1', 'b', 2))).toEqual({
      code: 'refused',
      reason: 'seat_occupied',
    })
  })

  it('refuses mid-match, so turn order cannot move under the game', async () => {
    await h.seed({ seats: ['host', 'b'], status: 'in_progress' })
    expect(refusal(await h.service.moveSeat('room-1', 'b', 0))).toEqual({
      code: 'refused',
      reason: 'match_in_progress',
    })
  })

  it('refuses a seat index that does not exist', async () => {
    await h.seed({ seats: ['host', 'b'] })
    expect(refusal(await h.service.moveSeat('room-1', 'b', 9))).toEqual({
      code: 'refused',
      reason: 'no_such_seat',
    })
  })

  it('refuses a non-member', async () => {
    await h.seed({ seats: ['host', null] })
    expect(refusal(await h.service.moveSeat('room-1', 'stranger', 1))).toEqual({
      code: 'refused',
      reason: 'not_a_member',
    })
  })

  it('drops the start agreement, because the roster changed shape', async () => {
    // Claim 3. Nobody is held to a "ready" they gave for a different roster.
    await h.seed({
      seats: ['host', 'b', null, null],
      gameId: PARTY,
      startCountdownEndsAt: T0 + 3_000,
    })
    const room = applied(await h.service.moveSeat('room-1', 'b', 2))
    expect(room.startCountdownEndsAt).toBeNull()
    expect(room.seats.some((seat) => seat.isReady)).toBe(false)
  })

  it('re-derives the teams, so seating and teaming cannot disagree', async () => {
    // Claim 2, and the reason it is claim 2: the room is seeded deliberately
    // lopsided, as a policy change would leave it.
    await h.seed({
      seats: ['a', 'b', 'c', 'd'],
      gameId: SQUADS,
      teamIds: ['team-1', 'team-1', 'team-1', 'team-1'],
    })
    const room = applied(await h.service.moveSeat('room-1', 'd', 0))
    const sizes = new Map<string, number>()
    for (const teamId of teams(room)) {
      sizes.set(teamId as string, (sizes.get(teamId as string) ?? 0) + 1)
    }
    expect([...sizes.values()].sort()).toEqual([2, 2])
  })
})

describe('assignSeat', () => {
  it('lets the host seat a member at an index', async () => {
    await h.seed({ seats: ['host', 'b', null, null], gameId: PARTY })
    const room = applied(await h.service.assignSeat('room-1', 'host', 'b', 3))
    expect(occupants(room)).toEqual(['host', null, null, 'b'])
  })

  it('refuses anybody but the host', async () => {
    await h.seed({ seats: ['host', 'b', null, null], gameId: PARTY })
    expect(refusal(await h.service.assignSeat('room-1', 'b', 'b', 3))).toEqual({
      code: 'refused',
      reason: 'not_host',
    })
  })

  it('promotes a spectator out of the spectator list when it seats them', async () => {
    // Or the same person is counted twice: once in a seat, once in the
    // spectator count every player is shown.
    await h.seed({
      seats: ['host', null],
      spectatorPlayerIds: ['watcher'],
      presentPlayerIds: ['host', 'watcher'],
    })
    const room = applied(await h.service.assignSeat('room-1', 'host', 'watcher', 1))
    expect(occupants(room)).toEqual(['host', 'watcher'])
    expect(room.spectatorPlayerIds).toEqual([])
  })

  it('stamps the second-player clock when the arrival is not the host', async () => {
    // The 30-minute no-opponent timer hangs off this field.
    await h.seed({ seats: ['host', null], spectatorPlayerIds: ['watcher'] })
    h.clock.set(T0 + 5_000)
    const room = applied(await h.service.assignSeat('room-1', 'host', 'watcher', 1))
    expect(room.secondPlayerJoinedAt).toBe(T0 + 5_000)
  })

  it('does not stamp it for the host alone', async () => {
    await h.seed({ seats: [null, 'host', null, null], gameId: PARTY })
    const room = applied(await h.service.assignSeat('room-1', 'host', 'host', 0))
    expect(room.secondPlayerJoinedAt).toBeNull()
  })

  it('refuses a seat somebody else holds', async () => {
    await h.seed({ seats: ['host', 'b', null, null], gameId: PARTY })
    expect(refusal(await h.service.assignSeat('room-1', 'host', 'b', 0))).toEqual({
      code: 'refused',
      reason: 'seat_occupied',
    })
  })

  it('refuses a bot-reserved seat', async () => {
    await h.seed({ seats: ['host', 'b', null, null], botSeats: [3], gameId: PARTY })
    expect(refusal(await h.service.assignSeat('room-1', 'host', 'b', 3))).toEqual({
      code: 'refused',
      reason: 'seat_occupied',
    })
  })

  it('refuses somebody who is not in the room at all', async () => {
    await h.seed({ seats: ['host', null] })
    expect(refusal(await h.service.assignSeat('room-1', 'host', 'stranger', 1))).toEqual({
      code: 'refused',
      reason: 'not_a_member',
    })
  })

  it('refuses a seat index that does not exist', async () => {
    await h.seed({ seats: ['host', 'b'] })
    expect(refusal(await h.service.assignSeat('room-1', 'host', 'b', 9))).toEqual({
      code: 'refused',
      reason: 'no_such_seat',
    })
  })

  it('refuses mid-match and after the room closes to changes', async () => {
    await h.seed({ seats: ['host', 'b'], status: 'in_progress' })
    expect(refusal(await h.service.assignSeat('room-1', 'host', 'b', 0))).toEqual({
      code: 'refused',
      reason: 'match_in_progress',
    })
  })

  it('is idempotent on the seat the target already holds', async () => {
    await h.seed({ seats: ['host', 'b', null, null], gameId: PARTY })
    const room = applied(await h.service.assignSeat('room-1', 'host', 'b', 1))
    expect(occupants(room)).toEqual(['host', 'b', null, null])
  })
})

describe('chooseTeam', () => {
  it('balances the sides around the player who picked', async () => {
    await h.seed({ seats: ['a', 'b', 'c', 'd'], gameId: SQUADS })
    const room = applied(await h.service.chooseTeam('room-1', 'c', 'team-2'))
    expect(room.seats[2]?.teamId).toBe('team-2')
    expect(teams(room).filter((teamId) => teamId === 'team-2')).toHaveLength(2)
  })

  it('keeps the ready flags, because a team change is not a seat change', async () => {
    // Nobody's turn order moved, so the start agreement stands.
    await h.seed({ seats: ['a', 'b', 'c', 'd'], gameId: SQUADS })
    const room = applied(await h.service.chooseTeam('room-1', 'c', 'team-2'))
    expect(room.seats.every((seat) => seat.isReady)).toBe(true)
  })

  it('refuses a game with no teams', async () => {
    await h.seed({ seats: ['host', 'b'] })
    expect(refusal(await h.service.chooseTeam('room-1', 'b', 'team-2'))).toEqual({
      code: 'refused',
      reason: 'teams_not_enabled',
    })
  })

  it('refuses under fixed teams, where the seat decides the side', async () => {
    // The seat-to-team map belongs to the game, so the way to change sides is
    // `moveSeat`. Reported as `teams_not_enabled` rather than `no_such_team`
    // because the game *has* the team — choosing is what is not on offer.
    await h.seed({ seats: ['a', 'b', 'c', 'd'], gameId: RELAY })
    expect(refusal(await h.service.chooseTeam('room-1', 'a', 'team-2'))).toEqual({
      code: 'refused',
      reason: 'teams_not_enabled',
    })
  })

  it('refuses a team the policy does not define', async () => {
    await h.seed({ seats: ['a', 'b', 'c', 'd'], gameId: SQUADS })
    expect(refusal(await h.service.chooseTeam('room-1', 'a', 'team-9'))).toEqual({
      code: 'refused',
      reason: 'no_such_team',
    })
  })

  it('refuses a player with no seat', async () => {
    await h.seed({ seats: ['a', 'b', 'c', null], gameId: SQUADS })
    expect(refusal(await h.service.chooseTeam('room-1', 'stranger', 'team-2'))).toEqual({
      code: 'refused',
      reason: 'not_a_member',
    })
  })

  it('refuses mid-match', async () => {
    await h.seed({ seats: ['a', 'b', 'c', 'd'], gameId: SQUADS, status: 'in_progress' })
    expect(refusal(await h.service.chooseTeam('room-1', 'a', 'team-2'))).toEqual({
      code: 'refused',
      reason: 'match_in_progress',
    })
  })
})

describe('transferHost and kick', () => {
  it('moves the crown to a named member', async () => {
    await h.seed({ seats: ['host', 'b'] })
    expect(applied(await h.service.transferHost('room-1', 'host', 'b')).hostPlayerId).toBe('b')
  })

  it('refuses a transfer from anybody but the host', async () => {
    await h.seed({ seats: ['host', 'b'] })
    expect(refusal(await h.service.transferHost('room-1', 'b', 'b'))).toEqual({
      code: 'refused',
      reason: 'not_host',
    })
  })

  it('frees the kicked player’s seat', async () => {
    await h.seed({ seats: ['host', 'b'] })
    const room = applied(await h.service.kick('room-1', 'host', 'b'))
    expect(occupants(room)).toEqual(['host', null])
  })

  it('removes the kicked player from presence, so the empty timer can arm', async () => {
    // Otherwise the room stays "occupied" by somebody who cannot come back.
    await h.seed({ seats: ['host', 'b'] })
    const room = applied(await h.service.kick('room-1', 'host', 'b'))
    expect(room.presentPlayerIds).toEqual(['host'])
  })

  it('takes the kicked player’s rematch vote with them', async () => {
    // Otherwise a kick could *complete* a rematch vote using the ballot of
    // somebody who has just been removed.
    await h.seed({
      seats: ['host', 'b'],
      status: 'finished',
      finishedAt: T0,
      rematchVotes: ['host', 'b'],
    })
    const room = applied(await h.service.kick('room-1', 'host', 'b'))
    expect(room.rematchVotes).toEqual(['host'])
  })

  it('removes a kicked spectator from the count', async () => {
    await h.seed({
      seats: ['host', 'b'],
      spectatorPlayerIds: ['watcher'],
      presentPlayerIds: ['host', 'b', 'watcher'],
    })
    const room = applied(await h.service.kick('room-1', 'host', 'watcher'))
    expect(room.spectatorPlayerIds).toEqual([])
    expect(room.presentPlayerIds).toEqual(['host', 'b'])
  })

  it('refuses a kick from a non-host, and a host kicking themselves', async () => {
    await h.seed({ seats: ['host', 'b'] })
    expect(refusal(await h.service.kick('room-1', 'b', 'host'))).toEqual({
      code: 'refused',
      reason: 'not_host',
    })
    expect(refusal(await h.service.kick('room-1', 'host', 'host'))).toEqual({
      code: 'refused',
      reason: 'cannot_kick_self',
    })
  })

  it('re-balances the teams a kick left short', async () => {
    await h.seed({ seats: ['a', 'b', 'c', 'd'], gameId: SQUADS, hostPlayerId: 'a' })
    const room = applied(await h.service.kick('room-1', 'a', 'd'))
    const sizes = new Map<string, number>()
    for (const seat of room.seats) {
      if (seat.occupantPlayerId === null) continue
      sizes.set(seat.teamId as string, (sizes.get(seat.teamId as string) ?? 0) + 1)
    }
    // Three players across two sides is two-and-one; the only wrong answer is
    // a side that kept two when the other has one and a spare share.
    expect([...sizes.values()].sort()).toEqual([1, 2])
  })
})

describe('closeLobby', () => {
  it('closes the room, clears presence and disarms the countdown', async () => {
    await h.seed({ seats: ['host', 'b'], startCountdownEndsAt: T0 + 3_000 })
    h.clock.set(T0 + 1_000)
    const room = applied(await h.service.closeLobby('room-1', 'host'))
    expect(room.status).toBe('closed')
    expect(room.closeReason).toBe('host_closed')
    expect(room.closedAt).toBe(T0 + 1_000)
    expect(room.presentPlayerIds).toEqual([])
    expect(room.startCountdownEndsAt).toBeNull()
  })

  it('refuses anybody but the host', async () => {
    await h.seed({ seats: ['host', 'b'] })
    expect(refusal(await h.service.closeLobby('room-1', 'b'))).toEqual({
      code: 'refused',
      reason: 'not_host',
    })
  })

  it('cannot be revised again once closed', async () => {
    await h.seed({ seats: ['host', 'b'] })
    applied(await h.service.closeLobby('room-1', 'host'))
    expect(refusal(await h.service.closeLobby('room-1', 'host'))).toEqual({
      code: 'room_closed',
      closeReason: 'host_closed',
    })
  })
})

describe('start — the host-pressed path', () => {
  it('starts a variable-size game once minPlayers is met', async () => {
    await h.seed({ seats: ['host', 'b', null, null], gameId: PARTY })
    const result = await h.service.start('room-1', 'host')
    const room = applied(result)
    expect(room.status).toBe('in_progress')
    expect(result.ok && result.outcome).toBe('match_started')
  })

  it('does not require a full room for a variable-size game', async () => {
    // Only `auto_when_full` requires every seat taken — that is the difference
    // between the two start paths.
    await h.seed({ seats: ['host', 'b', 'c', null], gameId: PARTY })
    expect(applied(await h.service.start('room-1', 'host')).status).toBe('in_progress')
  })

  it('refuses below minPlayers, and says why', async () => {
    await h.seed({ seats: ['host', null, null, null], gameId: PARTY })
    expect(refusal(await h.service.start('room-1', 'host'))).toEqual({
      code: 'not_startable',
      reasons: ['below_min_players'],
    })
  })

  it('refuses anybody but the host', async () => {
    await h.seed({ seats: ['host', 'b', null, null], gameId: PARTY })
    expect(refusal(await h.service.start('room-1', 'b'))).toEqual({
      code: 'refused',
      reason: 'not_host',
    })
  })

  it('reports an outstanding ready check as a blocker', async () => {
    await h.seed({ seats: ['host', 'b', null, null], gameId: PARTY, notReady: [1] })
    expect(refusal(await h.service.start('room-1', 'host'))).toEqual({
      code: 'not_startable',
      reasons: ['awaiting_ready'],
    })
  })

  it('lets the host force past the ready check', async () => {
    // Readiness is the one blocker a host may override: they can see the lobby.
    await h.seed({ seats: ['host', 'b', null, null], gameId: PARTY, notReady: [1] })
    expect(applied(await h.service.start('room-1', 'host', { force: true })).status).toBe(
      'in_progress',
    )
  })

  it('does not let force past a roster the game cannot run', async () => {
    await h.seed({ seats: ['host', null, null, null], gameId: PARTY, notReady: [0] })
    expect(refusal(await h.service.start('room-1', 'host', { force: true }))).toEqual({
      code: 'not_startable',
      reasons: ['below_min_players'],
    })
  })

  it('refuses to start a room that is not a lobby', async () => {
    await h.seed({ seats: ['host', 'b', null, null], gameId: PARTY, status: 'in_progress' })
    expect(refusal(await h.service.start('room-1', 'host'))).toEqual({
      code: 'not_startable',
      reasons: ['not_in_lobby'],
    })
  })
})

describe('tickAutoStart — the countdown path', () => {
  it('arms a 3-second countdown when a fixed-size game fills', async () => {
    await h.seed({ seats: ['host', 'b'] })
    const result = await h.service.tickAutoStart('room-1')
    const room = applied(result)
    expect(result.ok && result.outcome).toBe('countdown_armed')
    expect(room.startCountdownEndsAt).toBe(T0 + AUTO_START_COUNTDOWN_MS)
  })

  it('writes nothing on a quiet room', async () => {
    // A version bump is a delta every client has to fetch, and this runs on
    // every sweep tick against every live room.
    await h.seed({ seats: ['host', null] })
    const before = await h.store.get('room-1')
    expect(refusal(await h.service.tickAutoStart('room-1'))).toEqual({ code: 'no_change' })
    expect((await h.store.get('room-1'))?.version).toBe(before?.version)
  })

  it('is idempotent once armed', async () => {
    await h.seed({ seats: ['host', 'b'], startCountdownEndsAt: T0 + AUTO_START_COUNTDOWN_MS })
    expect(refusal(await h.service.tickAutoStart('room-1'))).toEqual({ code: 'no_change' })
  })

  it('starts the match when the countdown has run out', async () => {
    await h.seed({ seats: ['host', 'b'], startCountdownEndsAt: T0 + AUTO_START_COUNTDOWN_MS })
    h.clock.set(T0 + AUTO_START_COUNTDOWN_MS)
    const result = await h.service.tickAutoStart('room-1')
    expect(result.ok && result.outcome).toBe('match_started')
    const room = applied(result)
    expect(room.status).toBe('in_progress')
    expect(room.startCountdownEndsAt).toBeNull()
  })

  it('cancels the countdown when somebody un-readies inside the window', async () => {
    await h.seed({
      seats: ['host', 'b'],
      notReady: [1],
      startCountdownEndsAt: T0 + AUTO_START_COUNTDOWN_MS,
    })
    const result = await h.service.tickAutoStart('room-1')
    expect(result.ok && result.outcome).toBe('countdown_cancelled')
    expect(applied(result).startCountdownEndsAt).toBeNull()
  })

  it('cancels rather than starting when the roster is one the game cannot run', async () => {
    // The countdown has fired, but a seat emptied. Readiness no longer gets a
    // say at this point; a roster below minPlayers still does.
    await h.seed({ seats: ['host', null], startCountdownEndsAt: T0 })
    h.clock.set(T0 + AUTO_START_COUNTDOWN_MS)
    const result = await h.service.tickAutoStart('room-1')
    expect(result.ok && result.outcome).toBe('countdown_cancelled')
    expect(applied(result).status).toBe('lobby')
  })

  it('starts even if somebody un-readied in the firing millisecond', async () => {
    // Every client has already been told the match is starting; a race on the
    // ready flag must not beat that.
    await h.seed({ seats: ['host', 'b'], notReady: [1], startCountdownEndsAt: T0 })
    h.clock.set(T0)
    const result = await h.service.tickAutoStart('room-1')
    expect(result.ok && result.outcome).toBe('match_started')
  })

  it('cancels a stale countdown on a host-driven game', async () => {
    // Otherwise a mode change would start a host-driven game behind the host.
    await h.seed({
      seats: ['host', 'b', null, null],
      gameId: PARTY,
      startCountdownEndsAt: T0 + AUTO_START_COUNTDOWN_MS,
    })
    const result = await h.service.tickAutoStart('room-1')
    expect(result.ok && result.outcome).toBe('countdown_cancelled')
  })

  it('never arms a countdown for a host-driven game', async () => {
    await h.seed({ seats: ['host', 'b', null, null], gameId: PARTY })
    expect(refusal(await h.service.tickAutoStart('room-1'))).toEqual({ code: 'no_change' })
  })
})

describe('voteRematch', () => {
  const finished = (overrides: RoomOverrides = {}) => ({
    seats: ['host', 'b'] as readonly (string | null)[],
    status: 'finished' as const,
    finishedAt: T0,
    currentMatchId: 'match-1',
    matchesPlayed: 1,
    ...overrides,
  })

  it('records the first vote without starting anything', async () => {
    await h.seed(finished())
    const result = await h.service.voteRematch('room-1', 'host')
    expect(result.ok && result.outcome).toBe('rematch_vote_recorded')
    const room = applied(result)
    expect(room.rematchVotes).toEqual(['host'])
    expect(room.status).toBe('finished')
  })

  it('starts the rematch when the last present player agrees', async () => {
    await h.seed(finished({ rematchVotes: ['host'] }))
    const result = await h.service.voteRematch('room-1', 'b')
    expect(result.ok && result.outcome).toBe('rematch_started')
    const room = applied(result)
    expect(room.status).toBe('lobby')
    expect(room.rematchVotes).toEqual([])
    expect(room.currentMatchId).toBeNull()
    expect(room.matchesPlayed).toBe(2)
  })

  it('rotates the seats, so turn order advances', async () => {
    await h.seed(finished({ rematchVotes: ['host'] }))
    const room = applied(await h.service.voteRematch('room-1', 'b'))
    expect(occupants(room)).toEqual(['b', 'host'])
  })

  it('keeps the seats put for "new game, same people"', async () => {
    await h.seed(finished({ rematchVotes: ['host'] }))
    const room = applied(await h.service.voteRematch('room-1', 'b', { sameSeats: true }))
    expect(occupants(room)).toEqual(['host', 'b'])
    expect(room.status).toBe('lobby')
  })

  it('lets the host force the rematch past a missing vote', async () => {
    await h.seed(finished())
    const result = await h.service.voteRematch('room-1', 'host', { force: true })
    expect(result.ok && result.outcome).toBe('rematch_started')
  })

  it('refuses a force from anybody but the host', async () => {
    await h.seed(finished())
    expect(refusal(await h.service.voteRematch('room-1', 'b', { force: true }))).toEqual({
      code: 'rematch_refused',
      reason: 'not_host',
    })
  })

  it('refuses a room that is not finished', async () => {
    await h.seed({ seats: ['host', 'b'] })
    expect(refusal(await h.service.voteRematch('room-1', 'host'))).toEqual({
      code: 'rematch_refused',
      reason: 'match_not_finished',
    })
  })

  it('refuses a player who holds no seat', async () => {
    await h.seed(finished({ spectatorPlayerIds: ['watcher'] }))
    expect(refusal(await h.service.voteRematch('room-1', 'watcher'))).toEqual({
      code: 'rematch_refused',
      reason: 'not_seated',
    })
  })

  it('refuses once the electorate has dropped below minPlayers', async () => {
    await h.seed(finished({ presentPlayerIds: ['host'] }))
    expect(refusal(await h.service.voteRematch('room-1', 'host'))).toEqual({
      code: 'rematch_refused',
      reason: 'below_min_players',
    })
  })

  it('withdraws a vote', async () => {
    await h.seed(finished({ rematchVotes: ['host'] }))
    const room = applied(await h.service.withdrawRematchVote('room-1', 'host'))
    expect(room.rematchVotes).toEqual([])
  })
})

describe('reserveBotSeat', () => {
  it('refuses when the game does not declare bot support', async () => {
    // Checked before the registry, so the host hears about their game rather
    // than about the platform's inventory.
    await h.seed({ seats: ['host', null] })
    expect(refusal(await h.service.reserveBotSeat('room-1', 'host', 1, true))).toEqual({
      code: 'bot_unavailable',
      reason: 'bots_not_supported',
    })
  })

  it('refuses when no provider plays the game — always the answer in v1', async () => {
    await h.seed({ gameId: BOTTED, seats: ['host', null] })
    expect(refusal(await h.service.reserveBotSeat('room-1', 'host', 1, true))).toEqual({
      code: 'bot_unavailable',
      reason: 'no_provider',
    })
  })

  it('holds the seat when a provider exists', async () => {
    const withBots = await harness({ botProviders: [provider] })
    await withBots.seed({ gameId: BOTTED, seats: ['host', null] })
    const room = applied(await withBots.service.reserveBotSeat('room-1', 'host', 1, true))
    expect(room.seats[1]?.reservedFor).toBe('bot')
  })

  it('releases a held seat without consulting a provider', async () => {
    // Releasing must work even for a game whose provider has gone away, or a
    // room could be stuck holding a seat it can never fill.
    await h.seed({ gameId: BOTTED, seats: ['host', null], botSeats: [1] })
    const room = applied(await h.service.reserveBotSeat('room-1', 'host', 1, false))
    expect(room.seats[1]?.reservedFor).toBeNull()
  })

  it('refuses anybody but the host', async () => {
    const withBots = await harness({ botProviders: [provider] })
    await withBots.seed({ gameId: BOTTED, seats: ['host', 'b'] })
    expect(refusal(await withBots.service.reserveBotSeat('room-1', 'b', 1, true))).toEqual({
      code: 'refused',
      reason: 'not_host',
    })
  })

  it('refuses an occupied seat, a missing seat, and a room mid-match', async () => {
    const withBots = await harness({ botProviders: [provider] })
    await withBots.seed({ gameId: BOTTED, seats: ['host', 'b'] })
    expect(refusal(await withBots.service.reserveBotSeat('room-1', 'host', 1, true))).toEqual({
      code: 'refused',
      reason: 'seat_occupied',
    })
    expect(refusal(await withBots.service.reserveBotSeat('room-1', 'host', 9, true))).toEqual({
      code: 'refused',
      reason: 'no_such_seat',
    })

    const playing = await harness({ botProviders: [provider] })
    await playing.seed({ gameId: BOTTED, seats: ['host', null], status: 'in_progress' })
    expect(refusal(await playing.service.reserveBotSeat('room-1', 'host', 1, true))).toEqual({
      code: 'refused',
      reason: 'match_in_progress',
    })
  })
})

describe('view — redaction of the room envelope', () => {
  const populated: RoomOverrides = {
    seats: ['host', 'b'],
    realtimeRoomId: 'realtime-secret',
    spectatorPlayerIds: ['watcher-1', 'watcher-2'],
    presentPlayerIds: ['host', 'watcher-1'],
    startCountdownEndsAt: T0 + 3_000,
  }

  it('never carries the realtime handle, the spectator roster, or raw presence', async () => {
    // Enumerated against the view's own keys rather than by spot-checking three
    // fields: the day somebody adds a leak, the assertion is what catches it.
    await h.seed(populated)
    const view = await h.service.view('room-1', 'host')
    expect(view).not.toBeNull()
    const keys = Object.keys(view as object)
    expect(keys).not.toContain('realtimeRoomId')
    expect(keys).not.toContain('spectatorPlayerIds')
    expect(keys).not.toContain('presentPlayerIds')
    expect(JSON.stringify(view)).not.toContain('realtime-secret')
    expect(JSON.stringify(view)).not.toContain('watcher-1')
  })

  it('shows a spectator count, never a guest list', async () => {
    await h.seed(populated)
    expect((await h.service.view('room-1', 'host'))?.spectatorCount).toBe(2)
  })

  it('shows a member their own seat, the host, and presence per seat', async () => {
    await h.seed(populated)
    const view = await h.service.view('room-1', 'b')
    expect(view?.viewerKind).toBe('player')
    expect(view?.viewerSeatIndex).toBe(1)
    expect(view?.isHost).toBe(false)
    expect(view?.seats.map((seat) => seat.isSelf)).toEqual([false, true])
    expect(view?.seats.map((seat) => seat.isHost)).toEqual([true, false])
    // `b` is seated but not in `presentPlayerIds` — a disconnected player still
    // holds their seat, and the lobby has to be able to show that.
    expect(view?.seats.map((seat) => seat.isPresent)).toEqual([true, false])
  })

  it('tells the host they are the host', async () => {
    await h.seed(populated)
    expect((await h.service.view('room-1', 'host'))?.isHost).toBe(true)
  })

  it('classifies a spectator, and still gives them the code', async () => {
    await h.seed(populated)
    const view = await h.service.view('room-1', 'watcher-1')
    expect(view?.viewerKind).toBe('spectator')
    expect(view?.viewerSeatIndex).toBeNull()
    expect(view?.code).toBe('ABC234')
  })

  it('withholds the code and the occupants from a stranger', async () => {
    // The code is a capability: handing it to a viewer the join matrix has not
    // admitted would mint one out of a read.
    await h.seed(populated)
    const view = await h.service.view('room-1', 'nobody')
    expect(view?.viewerKind).toBe('stranger')
    expect(view?.code).toBeNull()
    expect(view?.seats.map((seat) => seat.occupantPlayerId)).toEqual([null, null])
  })

  it('treats a viewerless read as a stranger, not as a laxer code path', async () => {
    // The link-preview renderer and the public listing have no viewer.
    await h.seed(populated)
    const view = await h.service.view('room-1', null)
    expect(view?.viewerKind).toBe('stranger')
    expect(view?.code).toBeNull()
    expect(view?.viewerSeatIndex).toBeNull()
    expect(view?.isHost).toBe(false)
    expect(view?.seats.every((seat) => !seat.isSelf)).toBe(true)
  })

  it('carries the start snapshot the lobby renders its wait from', async () => {
    await h.seed({ seats: ['host', null, null, null], gameId: PARTY })
    const view = await h.service.view('room-1', 'host')
    expect(view?.start.seated).toBe(1)
    expect(view?.start.minMet).toBe(false)
    expect(view?.start.blockers).toEqual(['below_min_players'])
  })

  it('carries the countdown and the rematch tally as counts', async () => {
    await h.seed({
      seats: ['host', 'b'],
      status: 'finished',
      finishedAt: T0,
      rematchVotes: ['host'],
      matchesPlayed: 2,
      startCountdownEndsAt: T0 + 3_000,
    })
    const view = await h.service.view('room-1', 'host')
    expect(view?.rematch).toEqual({ voted: 1, eligible: 2 })
    expect(view?.matchesPlayed).toBe(2)
    expect(view?.startCountdownEndsAt).toBe(T0 + 3_000)
  })

  it('marks a bot-held seat without inventing an occupant', async () => {
    await h.seed({ gameId: BOTTED, seats: ['host', null], botSeats: [1] })
    const view = await h.service.view('room-1', 'host')
    expect(view?.seats.map((seat) => seat.isReservedForBot)).toEqual([false, true])
    expect(view?.seats[1]?.occupantPlayerId).toBeNull()
  })

  it('reflects the game and settings the room pinned', async () => {
    await h.seed({ seats: ['host', 'b'] })
    const view = await h.service.view('room-1', 'host')
    expect(view?.gameId).toBe(DUEL)
    expect(view?.gameVersion).toBe('1.0.0')
    expect(view?.settings).toEqual({ boardSize: 3, timed: false })
  })
})
