import { describe, expect, it } from 'vitest'
import { createInMemoryRoomStore } from '../src/rooms/store.js'
import { DEFAULT_ROOM_LIFECYCLE } from '../src/rooms/lifecycle.js'
import { T0, makeRoom } from './fixtures/rooms.js'

describe('code reservation', () => {
  it('is atomic: a second reservation of the same code fails', async () => {
    const store = createInMemoryRoomStore()
    expect(await store.reserveCode('ABC234', 'room-1')).toBe(true)
    expect(await store.reserveCode('ABC234', 'room-2')).toBe(false)
  })

  it('frees the code when released', async () => {
    const store = createInMemoryRoomStore()
    await store.reserveCode('ABC234', 'room-1')
    await store.releaseCode('ABC234')
    expect(await store.reserveCode('ABC234', 'room-2')).toBe(true)
  })

  it('resolves a room by its code, which is what /r/:CODE needs', async () => {
    const store = createInMemoryRoomStore()
    const room = makeRoom()
    await store.reserveCode(room.code, room.id)
    await store.insert(room)
    expect((await store.getByCode(room.code))?.id).toBe(room.id)
    expect(await store.getByCode('ZZZZZZ')).toBeNull()
  })

  it('returns null for a reserved code whose room was never inserted', async () => {
    const store = createInMemoryRoomStore()
    await store.reserveCode('ABC234', 'ghost')
    expect(await store.getByCode('ABC234')).toBeNull()
  })
})

describe('compare-and-set', () => {
  it('accepts a write against the current snapshot', async () => {
    const store = createInMemoryRoomStore()
    const room = makeRoom()
    await store.insert(room)
    expect(await store.save(room, { ...room, updatedAt: room.updatedAt + 1 })).toBe(true)
  })

  it('rejects a write against a stale snapshot, so no update is lost', async () => {
    const store = createInMemoryRoomStore()
    const room = makeRoom()
    await store.insert(room)

    const winner = { ...room, updatedAt: room.updatedAt + 1, spectatorPlayerIds: ['a'] }
    expect(await store.save(room, winner)).toBe(true)

    const loser = { ...room, updatedAt: room.updatedAt + 2, spectatorPlayerIds: ['b'] }
    expect(await store.save(room, loser)).toBe(false)
    expect((await store.get(room.id))?.spectatorPlayerIds).toEqual(['a'])
  })

  it('rejects a write to a removed room', async () => {
    const store = createInMemoryRoomStore()
    const room = makeRoom()
    await store.insert(room)
    await store.remove(room.id)
    expect(await store.save(room, { ...room, updatedAt: room.updatedAt + 1 })).toBe(false)
  })
})

describe('removal', () => {
  it('frees the code so it can be re-minted', async () => {
    const store = createInMemoryRoomStore()
    const room = makeRoom()
    await store.reserveCode(room.code, room.id)
    await store.insert(room)
    await store.remove(room.id)

    expect(await store.get(room.id)).toBeNull()
    expect(await store.getByCode(room.code)).toBeNull()
    expect(store.size).toBe(0)
    expect(await store.reserveCode(room.code, 'room-2')).toBe(true)
  })

  it('is safe on an unknown id', async () => {
    const store = createInMemoryRoomStore()
    await expect(store.remove('nope')).resolves.toBeUndefined()
  })
})

describe('queries', () => {
  it('lists only public lobbies, newest first, up to the limit', async () => {
    const store = createInMemoryRoomStore()
    await store.insert({ ...makeRoom(), id: 'a', visibility: 'public', createdAt: T0 })
    await store.insert({ ...makeRoom(), id: 'b', visibility: 'public', createdAt: T0 + 10 })
    await store.insert({ ...makeRoom(), id: 'c', visibility: 'private' })
    await store.insert({
      ...makeRoom(),
      id: 'd',
      visibility: 'public',
      status: 'in_progress',
    })

    expect((await store.listPublic(10)).map((room) => room.id)).toEqual(['b', 'a'])
    expect((await store.listPublic(1)).map((room) => room.id)).toEqual(['b'])
  })

  it('returns exactly the rooms whose deadline has passed', async () => {
    const store = createInMemoryRoomStore()
    await store.insert({ ...makeRoom(), id: 'due', presentPlayerIds: ['host'] })
    await store.insert({
      ...makeRoom(),
      id: 'safe',
      seats: [
        { index: 0, occupantPlayerId: 'host' },
        { index: 1, occupantPlayerId: 'guest' },
      ],
      secondPlayerJoinedAt: T0,
      status: 'in_progress',
    })

    expect(await store.dueForSweep(T0, 10)).toEqual([])
    const due = await store.dueForSweep(T0 + DEFAULT_ROOM_LIFECYCLE.noOpponentMs, 10)
    expect(due.map((room) => room.id)).toEqual(['due'])
  })

  it('honours the sweep limit', async () => {
    const store = createInMemoryRoomStore()
    for (let index = 0; index < 5; index += 1) {
      await store.insert({ ...makeRoom(), id: `r-${index}`, presentPlayerIds: ['host'] })
    }
    expect(await store.dueForSweep(T0 + DEFAULT_ROOM_LIFECYCLE.noOpponentMs, 2)).toHaveLength(2)
  })
})
