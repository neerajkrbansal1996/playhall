import { beforeEach, describe, expect, it } from 'vitest'
import { createFeatureFlags, type FeatureFlagOverrides } from '../src/flags.js'
import { createGameRegistry } from '../src/registry/registry.js'
import {
  decideRealtimeBinding,
  publicRoomSummary,
  realtimeJoinTarget,
} from '../src/rooms/realtime-binding.js'
import { createRoomService, type RoomService } from '../src/rooms/service.js'
import { createInMemoryRoomStore, type RoomStore } from '../src/rooms/store.js'
import {
  countingIdSource,
  fixedClock,
  webCryptoRandomSource,
  type MutableClock,
} from '../src/runtime.js'
import { makeGame, registrationFor } from './fixtures/games.js'
import { T0, makeRoom } from './fixtures/rooms.js'

const IP = '203.0.113.9'
const HANDLE = 'cly-7f3a19'

interface Harness {
  readonly service: RoomService
  readonly store: RoomStore
  readonly clock: MutableClock
}

async function harness(overrides: FeatureFlagOverrides = {}): Promise<Harness> {
  const clock = fixedClock(T0)
  const store = createInMemoryRoomStore()
  const flags = createFeatureFlags(overrides)
  const registry = await createGameRegistry({
    registrations: [makeGame({ slug: 'duo', id: 'game-duo' })].map(registrationFor),
    flags,
  })
  const service = createRoomService({
    store,
    registry,
    flags,
    clock,
    random: webCryptoRandomSource(),
    ids: countingIdSource('room'),
  })
  return { service, store, clock }
}

let h: Harness
beforeEach(async () => {
  h = await harness()
})

async function hostedRoom(): Promise<{ id: string; code: string }> {
  const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
  if (!created.ok) throw new Error('fixture room could not be created')
  return { id: created.room.id, code: created.room.code }
}

describe('the binding rule', () => {
  it('binds an unbound room', () => {
    expect(decideRealtimeBinding(makeRoom(), HANDLE)).toEqual({ action: 'bind' })
  })

  it('treats a repeat of the same handle as a no-op, so a retry is safe', () => {
    const room = makeRoom({ realtimeRoomId: HANDLE })
    expect(decideRealtimeBinding(room, HANDLE)).toEqual({ action: 'noop' })
  })

  it('refuses to re-point a bound room at a different handle', () => {
    // Overwriting here is how a lobby silently splits in half: half the players
    // land in one framework room, half in the other, and both look correct.
    const room = makeRoom({ realtimeRoomId: HANDLE })
    expect(decideRealtimeBinding(room, 'cly-other')).toEqual({
      action: 'reject',
      code: 'already_bound',
    })
  })

  it('refuses a blank handle', () => {
    for (const handle of ['', '   ']) {
      expect(decideRealtimeBinding(makeRoom(), handle)).toEqual({
        action: 'reject',
        code: 'invalid_handle',
      })
    }
  })

  it('binds a room that is mid-match or in its rematch window', () => {
    // Both are legitimate: a restart re-creates the framework room under a live
    // match (ADR-0001 §6.1), and a finished room stays open for rematch.
    for (const status of ['in_progress', 'finished'] as const) {
      expect(decideRealtimeBinding(makeRoom({ status }), HANDLE)).toEqual({ action: 'bind' })
    }
  })

  it('refuses a closed room, whose framework room is already gone', () => {
    expect(decideRealtimeBinding(makeRoom({ status: 'closed' }), HANDLE)).toEqual({
      action: 'reject',
      code: 'room_closed',
    })
  })
})

describe('bindRealtimeRoom', () => {
  it('stores the handle on the room record, not a second key', async () => {
    const room = await hostedRoom()
    const result = await h.service.bindRealtimeRoom(room.id, HANDLE)
    expect(result).toMatchObject({ ok: true, bound: true })

    // The mapping is reachable from the code the player typed — that is the
    // whole point — and it inherits the room's lifecycle because it *is* the
    // room record.
    const byCode = await h.store.getByCode(room.code)
    expect(byCode?.realtimeRoomId).toBe(HANDLE)
  })

  it('is idempotent for the same handle and reports that it wrote nothing', async () => {
    const room = await hostedRoom()
    await h.service.bindRealtimeRoom(room.id, HANDLE)
    await expect(h.service.bindRealtimeRoom(room.id, HANDLE)).resolves.toMatchObject({
      ok: true,
      bound: false,
    })
  })

  it('reports the incumbent handle when a second room claims the same platform room', async () => {
    const room = await hostedRoom()
    await h.service.bindRealtimeRoom(room.id, HANDLE)
    await expect(h.service.bindRealtimeRoom(room.id, 'cly-duplicate')).resolves.toEqual({
      ok: false,
      error: { code: 'already_bound', realtimeRoomId: HANDLE },
    })
  })

  it('refuses an unknown room', async () => {
    await expect(h.service.bindRealtimeRoom('room-404', HANDLE)).resolves.toEqual({
      ok: false,
      error: { code: 'room_not_found' },
    })
  })

  it('refuses a blank handle', async () => {
    const room = await hostedRoom()
    await expect(h.service.bindRealtimeRoom(room.id, ' ')).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_handle' },
    })
  })

  it('reports contention, not a missing room, when the retry budget runs out', async () => {
    // A `room_not_found` here would send the realtime service off to create a
    // second framework room for a room that is very much alive.
    const room = await hostedRoom()
    const contended: RoomStore = { ...h.store, save: async () => false }
    const service = createRoomService({
      store: contended,
      registry: await createGameRegistry({
        registrations: [makeGame({ slug: 'duo', id: 'game-duo' })].map(registrationFor),
        flags: createFeatureFlags(),
      }),
      flags: createFeatureFlags(),
      clock: h.clock,
      random: webCryptoRandomSource(),
      ids: countingIdSource('room'),
    })
    await expect(service.bindRealtimeRoom(room.id, HANDLE)).resolves.toEqual({
      ok: false,
      error: { code: 'contended', retryAfterMs: 50 },
    })
  })

  it('bumps updatedAt so a concurrent writer notices the binding', async () => {
    const room = await hostedRoom()
    h.clock.advance(5)
    await h.service.bindRealtimeRoom(room.id, HANDLE)
    expect((await h.store.get(room.id))?.updatedAt).toBe(T0 + 5)
  })
})

describe('the join target', () => {
  it('hands a seated player the handle and their seat index', () => {
    const room = makeRoom({ seats: ['host', 'guest'], realtimeRoomId: HANDLE })
    expect(realtimeJoinTarget(room, 'guest')).toEqual({
      ok: true,
      roomId: 'room-1',
      realtimeRoomId: HANDLE,
      seatIndex: 1,
    })
  })

  it('hands a spectator the handle with no seat', () => {
    const room = makeRoom({
      seats: ['host', 'guest'],
      spectatorPlayerIds: ['watcher'],
      realtimeRoomId: HANDLE,
    })
    expect(realtimeJoinTarget(room, 'watcher')).toMatchObject({ ok: true, seatIndex: null })
  })

  it('refuses a player the join matrix never admitted', () => {
    // The handle is a join capability on its own, so reaching for it without
    // going through joinByCode must not work.
    const room = makeRoom({ realtimeRoomId: HANDLE })
    expect(realtimeJoinTarget(room, 'stranger')).toEqual({ ok: false, code: 'not_admitted' })
  })

  it('tells an admitted player to wait rather than guess an unbound handle', () => {
    expect(realtimeJoinTarget(makeRoom(), 'host')).toEqual({ ok: false, code: 'not_bound' })
  })
})

describe('realtimeTarget via the service', () => {
  it('resolves for the host once the room is bound', async () => {
    const room = await hostedRoom()
    await h.service.bindRealtimeRoom(room.id, HANDLE)
    await expect(h.service.realtimeTarget(room.id, 'host')).resolves.toEqual({
      ok: true,
      roomId: room.id,
      realtimeRoomId: HANDLE,
      seatIndex: 0,
    })
  })

  it('answers not_admitted for an unknown room, so the refusal leaks no room id', async () => {
    await expect(h.service.realtimeTarget('room-404', 'host')).resolves.toEqual({
      ok: false,
      code: 'not_admitted',
    })
  })
})

describe('joinByCode carries the mapping', () => {
  it('returns code -> handle -> seat in one step for the joiner', async () => {
    const room = await hostedRoom()
    await h.service.bindRealtimeRoom(room.id, HANDLE)

    const joined = await h.service.joinByCode({
      // Deliberately messy: the mapping step must sit behind the same
      // normalisation a pasted code goes through.
      rawCode: ` ${room.code.toLowerCase()} `,
      playerId: 'guest',
      ip: IP,
    })
    expect(joined).toMatchObject({
      ok: true,
      realtime: { ok: true, realtimeRoomId: HANDLE, seatIndex: 1 },
    })
  })

  it('admits the joiner even when the realtime room is not up yet', async () => {
    const room = await hostedRoom()
    const joined = await h.service.joinByCode({ rawCode: room.code, playerId: 'guest', ip: IP })
    expect(joined).toMatchObject({
      ok: true,
      realtime: { ok: false, code: 'not_bound' },
    })
    // The seat is theirs regardless — the lobby does not wait on the transport.
    expect(joined.ok && joined.room.seats[1]?.occupantPlayerId).toBe('guest')
  })

  it('gives a full room a spectator target, not a seat', async () => {
    const room = await hostedRoom()
    await h.service.bindRealtimeRoom(room.id, HANDLE)
    await h.service.joinByCode({ rawCode: room.code, playerId: 'guest', ip: IP })

    const third = await h.service.joinByCode({ rawCode: room.code, playerId: 'third', ip: IP })
    expect(third).toMatchObject({
      ok: true,
      realtime: { ok: true, realtimeRoomId: HANDLE, seatIndex: null },
    })
  })
})

describe('the public listing', () => {
  it('cannot leak a join capability, because a summary has no room to put one', async () => {
    const flagged = await harness({ platform: { publicRoomListing: true } })
    const created = await flagged.service.create('host', { slug: 'duo', visibility: 'public' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await flagged.service.bindRealtimeRoom(created.room.id, HANDLE)

    const listed = await flagged.service.listPublic()
    expect(listed).toHaveLength(1)
    const entry = listed[0]!
    expect(Object.keys(entry).sort()).toEqual([
      'createdAt',
      'gameId',
      'gameSlug',
      'gameVersion',
      'id',
      'seatsTaken',
      'seatsTotal',
      'spectatorCount',
      'status',
    ])
    expect(JSON.stringify(entry)).not.toContain(created.room.code)
    expect(JSON.stringify(entry)).not.toContain(HANDLE)
  })

  it('counts seats and spectators without naming anyone', () => {
    const summary = publicRoomSummary(
      makeRoom({
        seats: ['host', null],
        spectatorPlayerIds: ['watcher'],
        realtimeRoomId: HANDLE,
      }),
    )
    expect(summary).toEqual({
      id: 'room-1',
      gameId: 'fixture',
      gameSlug: 'fixture',
      gameVersion: '1.0.0',
      status: 'lobby',
      seatsTotal: 2,
      seatsTaken: 1,
      spectatorCount: 1,
      createdAt: T0,
    })
  })
})
