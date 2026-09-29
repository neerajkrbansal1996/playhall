import { describe, expect, it } from 'vitest'
import * as platform from '../src/index.js'
import { ROOM_CODE_ALPHABET } from '@playhall/shared'
import { freeSeatIndex, isRoomMember, seatIndexOf, seatedPlayerIds } from '../src/rooms/types.js'
import {
  countingIdSource,
  fixedClock,
  randomIdSource,
  sequenceRandomSource,
} from '../src/runtime.js'
import { makeRoom } from './fixtures/rooms.js'

describe('the package surface', () => {
  it('re-exports the room-code alphabet, so no consumer re-declares it', () => {
    expect(platform.ROOM_CODE_ALPHABET).toBe(ROOM_CODE_ALPHABET)
    expect(platform.ROOM_CODE_LENGTH).toBe(6)
  })

  it('reports the code space in the build info', () => {
    expect(platform.platformBuildInfo()).toEqual({
      platformCore: platform.PLATFORM_CORE_VERSION,
      roomCodeSpace: 887_503_681,
    })
  })

  it('exports every entry point the realtime service and the web shell need', () => {
    for (const name of [
      'createGameRegistry',
      'createFeatureFlags',
      'createRoomService',
      'createInMemoryRoomStore',
      'createTokenBucketLimiter',
      'createFailedJoinGuard',
      'parseRoute',
      'routes',
      'buildSitemap',
      'buildRobotsTxt',
      'evaluateRoomLifecycle',
      'roomKeyTtlMs',
      'canonicalizeRoomCode',
      'resolveJoin',
    ]) {
      expect(platform).toHaveProperty(name)
    }
  })
})

describe('room helpers', () => {
  const room = makeRoom({ seats: ['host', 'guest'], spectatorPlayerIds: ['watcher'] })

  it('lists seated players in seat order, skipping empty seats', () => {
    expect(seatedPlayerIds(room)).toEqual(['host', 'guest'])
    expect(seatedPlayerIds(makeRoom({ seats: [null, 'guest'] }))).toEqual(['guest'])
  })

  it('finds the first free seat, or null when full', () => {
    expect(freeSeatIndex(makeRoom())).toBe(1)
    expect(freeSeatIndex(room)).toBeNull()
  })

  it('locates a player by seat', () => {
    expect(seatIndexOf(room, 'guest')).toBe(1)
    expect(seatIndexOf(room, 'nobody')).toBeNull()
  })

  it('counts both seated players and spectators as members', () => {
    expect(isRoomMember(room, 'host')).toBe(true)
    expect(isRoomMember(room, 'watcher')).toBe(true)
    expect(isRoomMember(room, 'stranger')).toBe(false)
  })
})

describe('runtime ports', () => {
  it('drives a clock by hand', () => {
    const clock = fixedClock(1000)
    expect(clock.now()).toBe(1000)
    clock.advance(50)
    expect(clock.now()).toBe(1050)
    clock.set(7)
    expect(clock.now()).toBe(7)
  })

  it('cycles a deterministic byte sequence and rejects an empty one', () => {
    const source = sequenceRandomSource([1, 2])
    expect([...source.randomBytes(5)]).toEqual([1, 2, 1, 2, 1])
    expect(() => sequenceRandomSource([])).toThrow(RangeError)
  })

  it('mints hex ids of the requested width', () => {
    const ids = randomIdSource(sequenceRandomSource([0x0a, 0xff]), 4)
    expect(ids.newId()).toBe('0aff0aff')
  })

  it('mints counted ids for tests', () => {
    const ids = countingIdSource('room')
    expect([ids.newId(), ids.newId()]).toEqual(['room-1', 'room-2'])
    expect(countingIdSource().newId()).toBe('id-1')
  })
})
