import { describe, expect, it } from 'vitest'
import { toCatalogEntry, type GameCatalogEntry } from '@playhall/game-sdk'
import {
  JOIN_REJECTION_CODES,
  type ResolveJoinInput,
  applyJoin,
  canonicalizeRoomCode,
  chargesFailedJoinBudget,
  isTerminalRejection,
  resolveJoin,
} from '../src/rooms/join.js'
import { DEFAULT_ROOM_LIFECYCLE, type RoomLifecyclePolicy } from '../src/rooms/lifecycle.js'
import { seatingPolicyFor } from '../src/seats/policy.js'
import { seatIndexOf } from '../src/rooms/types.js'
import { makeGame } from './fixtures/games.js'
import { T0, makeRoom } from './fixtures/rooms.js'

const spectatable: GameCatalogEntry = toCatalogEntry(makeGame({ slug: 'fixture' }).manifest)
/** `applyJoin` needs the seating policy so a join re-derives teams. */
const policy = seatingPolicyFor(spectatable)
const noSpectators: GameCatalogEntry = toCatalogEntry(
  makeGame({ slug: 'fixture', supportsSpectators: false }).manifest,
)

const NOW = T0 + 60_000

/**
 * `resolveJoin` under the shipped deadlines, overridable per call.
 *
 * The join matrix is about seats and spectators, not about policy numbers, so
 * naming the policy at all sixteen call sites would be noise. The cases that
 * *do* vary it live in `lifecycle.test.ts` and `room-service.test.ts` — the
 * policy is a required argument on `resolveJoin` itself precisely so a
 * production caller cannot quietly inherit a default the store disagrees with.
 */
function join(input: Omit<ResolveJoinInput, 'lifecycle'> & { lifecycle?: RoomLifecyclePolicy }) {
  return resolveJoin({ lifecycle: DEFAULT_ROOM_LIFECYCLE, ...input })
}

describe('code normalisation', () => {
  it('is case-insensitive and trims whitespace', () => {
    expect(canonicalizeRoomCode('  abc234 ')).toBe('ABC234')
    expect(canonicalizeRoomCode('ABC234')).toBe('ABC234')
    expect(canonicalizeRoomCode('\tAbC234\n')).toBe('ABC234')
  })

  it('strips separators a chat app or a keyboard inserts', () => {
    expect(canonicalizeRoomCode('ABC-234')).toBe('ABC234')
    expect(canonicalizeRoomCode('ABC 234')).toBe('ABC234')
    expect(canonicalizeRoomCode('abc.234')).toBe('ABC234')
  })

  it('drops an excluded character rather than guessing what it meant', () => {
    // 0/O/1/I/L are excluded from the alphabet, so a typed one is a misread
    // and there is no in-alphabet character to fold it to. Dropping it leaves
    // five usable characters, which fails the length check and lands on the
    // friendly not-found path — the right answer, and never a wrong room.
    for (const typo of ['ABCI34', 'ABCL34', 'ABC034', 'ABCO34']) {
      expect(canonicalizeRoomCode(typo)).toBeNull()
    }
  })

  it('still resolves a valid code that carries a stray excluded character', () => {
    expect(canonicalizeRoomCode('ABC234O')).toBe('ABC234')
  })

  it('returns null for anything that is not a complete code', () => {
    expect(canonicalizeRoomCode('')).toBeNull()
    expect(canonicalizeRoomCode('ABC23')).toBeNull()
    expect(canonicalizeRoomCode('ABC2345')).toBeNull()
    expect(canonicalizeRoomCode('!!!!!!')).toBeNull()
  })
})

describe('the join matrix', () => {
  it('rejects an unknown room', () => {
    expect(join({ room: null, playerId: 'p', game: spectatable, now: NOW })).toMatchObject({
      kind: 'rejected',
      code: 'room_not_found',
      terminal: true,
    })
  })

  it('rejects a closed room', () => {
    const room = { ...makeRoom(), status: 'closed' as const }
    expect(join({ room, playerId: 'p', game: spectatable, now: NOW })).toMatchObject({
      code: 'room_expired',
      terminal: true,
    })
  })

  it('rejects a room that is past a lifecycle deadline but not yet swept', () => {
    // The sweeper runs on an interval, so a player can always reach a room in
    // the window between its deadline and its sweep. The join path must apply
    // the same rule rather than letting them into a dead room.
    const room = makeRoom({ presentPlayerIds: ['host'] })
    const past = T0 + DEFAULT_ROOM_LIFECYCLE.noOpponentMs + 1
    expect(join({ room, playerId: 'p', game: spectatable, now: past })).toMatchObject({
      code: 'room_expired',
      terminal: true,
    })
  })

  it('rejects a room whose game the registry cannot resolve', () => {
    expect(join({ room: makeRoom(), playerId: 'p', game: null, now: NOW })).toMatchObject({
      code: 'game_unavailable',
      terminal: false,
    })
  })

  it('takes a free seat in a lobby', () => {
    const outcome = join({ room: makeRoom(), playerId: 'p', game: spectatable, now: NOW })
    expect(outcome).toEqual({ kind: 'seated', seatIndex: 1, isRejoin: false })
  })

  it('returns the same seat to a player who already holds one', () => {
    const room = makeRoom({ seats: ['host', 'guest'] })
    expect(join({ room, playerId: 'guest', game: spectatable, now: NOW })).toEqual({
      kind: 'rejoined',
      seatIndex: 1,
      isRejoin: true,
    })
  })

  it('returns a spectator to spectating rather than seating them', () => {
    const room = makeRoom({ seats: ['host', null], spectatorPlayerIds: ['watcher'] })
    expect(join({ room, playerId: 'watcher', game: spectatable, now: NOW })).toEqual({
      kind: 'spectating',
      isRejoin: true,
    })
  })

  it('spectates when the room is full and the game allows it', () => {
    const room = makeRoom({ seats: ['host', 'guest'], secondPlayerJoinedAt: T0 })
    expect(join({ room, playerId: 'p', game: spectatable, now: NOW })).toEqual({
      kind: 'spectating',
      isRejoin: false,
    })
  })

  it('rejects as full when the game forbids spectators', () => {
    const room = makeRoom({ seats: ['host', 'guest'], secondPlayerJoinedAt: T0 })
    expect(join({ room, playerId: 'p', game: noSpectators, now: NOW })).toMatchObject({
      code: 'room_full',
      terminal: false,
    })
  })

  it('spectates a match in progress even when a seat is free', () => {
    // A seat vacated mid-match still belongs to the player who left. Filling
    // it is seat substitution (PER-13), not a join.
    const room = makeRoom({
      status: 'in_progress',
      seats: ['host', null],
      secondPlayerJoinedAt: T0,
    })
    expect(join({ room, playerId: 'p', game: spectatable, now: NOW })).toEqual({
      kind: 'spectating',
      isRejoin: false,
    })
  })

  it('lets a new player take a free seat in a finished room, for the rematch', () => {
    const room = makeRoom({
      status: 'finished',
      seats: ['host', null],
      secondPlayerJoinedAt: T0,
      finishedAt: NOW - 1000,
    })
    expect(join({ room, playerId: 'p', game: spectatable, now: NOW })).toEqual({
      kind: 'seated',
      seatIndex: 1,
      isRejoin: false,
    })
  })

  it('rejoins a disconnected seated player to their own seat mid-match', () => {
    const room = makeRoom({
      status: 'in_progress',
      seats: ['host', 'guest'],
      secondPlayerJoinedAt: T0,
      presentPlayerIds: ['host'],
    })
    expect(join({ room, playerId: 'guest', game: spectatable, now: NOW })).toEqual({
      kind: 'rejoined',
      seatIndex: 1,
      isRejoin: true,
    })
  })
})

describe('terminal classification', () => {
  it('marks exactly the codes that mean "this link will never work"', () => {
    const terminal = JOIN_REJECTION_CODES.filter(isTerminalRejection)
    expect(terminal).toEqual(['invalid_code', 'room_not_found', 'room_expired'])
  })

  /**
   * Deliberately a *different* set from the terminal one. Terminal answers the
   * UI's question ("is this link dead?"); this answers the enumeration
   * defence's question ("was this person guessing?"). A code for a room that
   * has just closed is evidence of an invitation, not of a guess.
   */
  it('charges the per-IP budget only for codes that never named a room', () => {
    const charged = JOIN_REJECTION_CODES.filter(chargesFailedJoinBudget)
    expect(charged).toEqual(['invalid_code', 'room_not_found'])
    expect(chargesFailedJoinBudget('room_expired')).toBe(false)
  })
})

describe('applyJoin', () => {
  it('seats the player, marks them present and clears the empty timer', () => {
    const room = makeRoom({ presentPlayerIds: [], emptySince: T0 + 1000 })
    const outcome = join({ room, playerId: 'guest', game: spectatable, now: NOW })
    const next = applyJoin(room, 'guest', outcome, NOW, policy)

    expect(seatIndexOf(next, 'guest')).toBe(1)
    expect(next.presentPlayerIds).toContain('guest')
    expect(next.emptySince).toBeNull()
    expect(next.updatedAt).toBe(NOW)
  })

  it('records the second player, which disarms the 30-minute expiry', () => {
    const room = makeRoom({ presentPlayerIds: ['host'] })
    const next = applyJoin(
      room,
      'guest',
      join({ room, playerId: 'guest', game: spectatable, now: NOW }),
      NOW,
      policy,
    )
    expect(next.secondPlayerJoinedAt).toBe(NOW)
  })

  it('does not count the host re-taking a seat as a second player', () => {
    const empty = makeRoom({ seats: [null, null], presentPlayerIds: [] })
    const next = applyJoin(
      empty,
      'host',
      join({ room: empty, playerId: 'host', game: spectatable, now: NOW }),
      NOW,
      policy,
    )
    expect(next.secondPlayerJoinedAt).toBeNull()
  })

  it('never re-stamps an existing second-player time', () => {
    const room = makeRoom({ seats: ['host', null], secondPlayerJoinedAt: T0 + 5 })
    const next = applyJoin(
      room,
      'third',
      join({ room, playerId: 'third', game: spectatable, now: NOW }),
      NOW,
      policy,
    )
    expect(next.secondPlayerJoinedAt).toBe(T0 + 5)
  })

  it('promotes a spectator out of the spectator list when they take a seat', () => {
    const room = makeRoom({ seats: ['host', null], spectatorPlayerIds: ['watcher'] })
    // A spectator resolves to `spectating`; seat promotion is a deliberate
    // host/seat action, so drive `applyJoin` with the seated outcome directly.
    const next = applyJoin(room, 'watcher', { kind: 'seated', seatIndex: 1, isRejoin: false }, NOW, policy)
    expect(next.spectatorPlayerIds).toEqual([])
    expect(seatIndexOf(next, 'watcher')).toBe(1)
  })

  it('adds a spectator once, not twice', () => {
    const room = makeRoom({ seats: ['host', 'guest'], secondPlayerJoinedAt: T0 })
    const first = applyJoin(room, 'w', { kind: 'spectating', isRejoin: false }, NOW, policy)
    const second = applyJoin(first, 'w', { kind: 'spectating', isRejoin: true }, NOW + 1, policy)
    expect(second.spectatorPlayerIds).toEqual(['w'])
    expect(second.presentPlayerIds.filter((id) => id === 'w')).toHaveLength(1)
  })

  it('is a no-op for a rejection', () => {
    const room = makeRoom()
    expect(
      applyJoin(room, 'p', { kind: 'rejected', code: 'room_full', terminal: false }, NOW, policy),
    ).toBe(room)
  })

  it('does not mutate the input room', () => {
    const room = makeRoom()
    const snapshot = JSON.stringify(room)
    applyJoin(room, 'guest', { kind: 'seated', seatIndex: 1, isRejoin: false }, NOW, policy)
    expect(JSON.stringify(room)).toBe(snapshot)
  })

  it('bumps the version on every revision, so the store can tell writes apart', () => {
    const room = makeRoom()
    const seated = applyJoin(room, 'guest', { kind: 'seated', seatIndex: 1, isRejoin: false }, NOW, policy)
    expect(seated.version).toBe(room.version + 1)

    // Same instant, so `updatedAt` cannot distinguish them; the counter must.
    const spectating = applyJoin(room, 'other', { kind: 'spectating', isRejoin: false }, NOW, policy)
    expect(spectating.updatedAt).toBe(seated.updatedAt)
    expect(spectating.version).toBe(room.version + 1)
  })

  it('restarts the rematch window when a seat is taken in a finished room', () => {
    const room = makeRoom({ status: 'finished', finishedAt: T0, seats: ['host', null] })
    const next = applyJoin(room, 'guest', { kind: 'seated', seatIndex: 1, isRejoin: false }, NOW, policy)
    // Without this, someone seated at minute 14 of the 15-minute window gets
    // sixty seconds to agree to a rematch.
    expect(next.finishedAt).toBe(NOW)
  })

  it('leaves the rematch window alone for a spectator or a rejoin', () => {
    const room = makeRoom({ status: 'finished', finishedAt: T0, seats: ['host', 'guest'] })
    expect(applyJoin(room, 'w', { kind: 'spectating', isRejoin: false }, NOW, policy).finishedAt).toBe(T0)
    expect(
      applyJoin(room, 'guest', { kind: 'rejoined', seatIndex: 1, isRejoin: true }, NOW, policy).finishedAt,
    ).toBe(T0)
  })

  it('leaves the rematch window null while a room is still in its lobby', () => {
    const room = makeRoom()
    expect(
      applyJoin(room, 'guest', { kind: 'seated', seatIndex: 1, isRejoin: false }, NOW, policy).finishedAt,
    ).toBeNull()
  })
})
