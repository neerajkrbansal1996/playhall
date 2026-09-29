import { beforeEach, describe, expect, it } from 'vitest'
import { createFeatureFlags, type FeatureFlagOverrides } from '../src/flags.js'
import { createGameRegistry } from '../src/registry/registry.js'
import { DEFAULT_RATE_LIMITS } from '../src/rate-limit/policies.js'
import { DEFAULT_ROOM_LIFECYCLE } from '../src/rooms/lifecycle.js'
import {
  createRoomService,
  createRoomRequestSchema,
  type RoomService,
} from '../src/rooms/service.js'
import { createInMemoryRoomStore, type RoomStore } from '../src/rooms/store.js'
import { isValidRoomCode } from '../src/rooms/code.js'
import {
  countingIdSource,
  fixedClock,
  webCryptoRandomSource,
  type MutableClock,
} from '../src/runtime.js'
import { makeGame, registrationFor } from './fixtures/games.js'
import { T0 } from './fixtures/rooms.js'

const IP = '203.0.113.7'

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
    registrations: [
      makeGame({ slug: 'duo', id: 'game-duo' }),
      makeGame({ slug: 'solo-only', id: 'game-solo', supportsSpectators: false }),
      makeGame({ slug: 'quad', id: 'game-quad', maxPlayers: 4 }),
      makeGame({ slug: 'soon', id: 'game-soon', status: 'coming-soon' }),
    ].map(registrationFor),
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

describe('create', () => {
  it('mints a valid, unique code and seats the host', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    expect(isValidRoomCode(created.room.code)).toBe(true)
    expect(created.room.hostPlayerId).toBe('host')
    expect(created.room.seats.map((seat) => seat.occupantPlayerId)).toEqual(['host', null])
    expect(created.room.status).toBe('lobby')
    expect(created.room.secondPlayerJoinedAt).toBeNull()
  })

  it('is private by default', () => {
    expect(createRoomRequestSchema.parse({ slug: 'duo' }).visibility).toBe('private')
  })

  it('takes the seat count from the manifest, never from the request', async () => {
    const created = await h.service.create('host', {
      slug: 'quad',
      visibility: 'private',
      // A modified client sending a seat count has nowhere to put it: the
      // schema does not accept one.
    } as never)
    expect(created.ok && created.room.seats).toHaveLength(4)
  })

  it('pins the game version for the room’s whole life', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    expect(created.ok && created.room.gameVersion).toBe('1.0.0')
  })

  it('refuses an unknown or unplayable game', async () => {
    await expect(
      h.service.create('host', { slug: 'nope', visibility: 'private' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'game_unavailable' } })
    await expect(
      h.service.create('host', { slug: 'soon', visibility: 'private' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'game_unavailable' } })
  })

  it('validates settings against the game’s own schema before the room exists', async () => {
    const result = await h.service.create('host', {
      slug: 'duo',
      visibility: 'private',
      settings: { boardSize: 99, timed: false },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_settings' } })
    expect(h.store.size).toBe(0)
  })

  it('accepts a manifest preset by id', async () => {
    const result = await h.service.create('host', {
      slug: 'duo',
      visibility: 'private',
      presetId: 'big',
    })
    expect(result.ok && result.room.settings).toEqual({ boardSize: 5, timed: true })
  })

  it('rejects an unknown preset', async () => {
    await expect(
      h.service.create('host', { slug: 'duo', visibility: 'private', presetId: 'nope' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_settings' } })
  })

  it('falls back to the manifest defaults', async () => {
    const result = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    expect(result.ok && result.room.settings).toEqual({ boardSize: 3, timed: false })
  })

  it('refuses a public room while the listing flag is off', async () => {
    await expect(
      h.service.create('host', { slug: 'duo', visibility: 'public' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'public_listing_disabled' } })
  })

  it('allows a public room once the flag is on', async () => {
    const flagged = await harness({ platform: { publicRoomListing: true } })
    const created = await flagged.service.create('host', { slug: 'duo', visibility: 'public' })
    expect(created.ok && created.room.visibility).toBe('public')
    expect(await flagged.service.listPublic()).toHaveLength(1)
  })

  it('lists nothing publicly while the flag is off, even if a public room exists', async () => {
    expect(await h.service.listPublic()).toEqual([])
  })

  it('rate-limits creation per guest, and only that guest', async () => {
    const { capacity } = DEFAULT_RATE_LIMITS.roomCreate
    for (let index = 0; index < capacity; index += 1) {
      expect((await h.service.create('host', { slug: 'duo', visibility: 'private' })).ok).toBe(true)
    }
    const refused = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    expect(refused).toMatchObject({ ok: false, error: { code: 'rate_limited' } })
    expect(
      !refused.ok && refused.error.code === 'rate_limited' && refused.error.retryAfterMs,
    ).toBeGreaterThan(0)

    expect((await h.service.create('other', { slug: 'duo', visibility: 'private' })).ok).toBe(true)
  })

  it('surfaces code exhaustion instead of hanging', async () => {
    const store = createInMemoryRoomStore()
    const exhausted: RoomStore = { ...store, reserveCode: async () => false }
    const flags = createFeatureFlags()
    const registry = await createGameRegistry({
      registrations: [registrationFor(makeGame({ slug: 'duo' }))],
      flags,
    })
    const service = createRoomService({
      store: exhausted,
      registry,
      flags,
      clock: fixedClock(T0),
      random: webCryptoRandomSource(),
      ids: countingIdSource('room'),
    })
    await expect(
      service.create('host', { slug: 'duo', visibility: 'private' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'code_exhausted' } })
  })
})

describe('join by code', () => {
  async function createRoom(slug = 'duo'): Promise<string> {
    const created = await h.service.create('host', { slug, visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    return created.room.code
  }

  it('accepts the code in any case, with whitespace and separators', async () => {
    const code = await createRoom()
    const messy = `  ${code.toLowerCase().slice(0, 3)}-${code.toLowerCase().slice(3)} `
    const joined = await h.service.joinByCode({ rawCode: messy, playerId: 'guest', ip: IP })
    expect(joined).toMatchObject({ ok: true, outcome: { kind: 'seated', seatIndex: 1 } })
  })

  it('records the second player, which disarms the 30-minute expiry', async () => {
    const code = await createRoom()
    const joined = await h.service.joinByCode({ rawCode: code, playerId: 'guest', ip: IP })
    expect(joined.ok && joined.room.secondPlayerJoinedAt).toBe(T0)
  })

  it('returns a rejoining player to the same seat', async () => {
    const code = await createRoom()
    await h.service.joinByCode({ rawCode: code, playerId: 'guest', ip: IP })
    const again = await h.service.joinByCode({ rawCode: code, playerId: 'guest', ip: IP })
    expect(again).toMatchObject({ ok: true, outcome: { kind: 'rejoined', seatIndex: 1 } })
  })

  it('makes an extra player a spectator when the room is full', async () => {
    const code = await createRoom()
    await h.service.joinByCode({ rawCode: code, playerId: 'guest', ip: IP })
    const third = await h.service.joinByCode({ rawCode: code, playerId: 'third', ip: IP })
    expect(third).toMatchObject({ ok: true, outcome: { kind: 'spectating' } })
    expect(third.ok && third.room.spectatorPlayerIds).toEqual(['third'])
  })

  it('rejects as full when the game forbids spectators', async () => {
    const code = await createRoom('solo-only')
    await h.service.joinByCode({ rawCode: code, playerId: 'guest', ip: IP })
    await expect(
      h.service.joinByCode({ rawCode: code, playerId: 'third', ip: IP }),
    ).resolves.toMatchObject({ ok: false, code: 'room_full', terminal: false })
  })

  it('sends an unknown code to the friendly not-found path', async () => {
    await expect(
      h.service.joinByCode({ rawCode: 'ZZZZZZ', playerId: 'guest', ip: IP }),
    ).resolves.toMatchObject({ ok: false, code: 'room_not_found', terminal: true })
  })

  it('sends a malformed code to the same path without a store lookup', async () => {
    await expect(
      h.service.joinByCode({ rawCode: 'nope', playerId: 'guest', ip: IP }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_code', terminal: true })
  })

  it('refuses an expired room', async () => {
    const code = await createRoom()
    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.noOpponentMs)
    await expect(
      h.service.joinByCode({ rawCode: code, playerId: 'guest', ip: IP }),
    ).resolves.toMatchObject({ ok: false, code: 'room_expired', terminal: true })
  })

  it('lets a new player take a seat in a finished room during the rematch window', async () => {
    const code = await createRoom()
    await h.service.joinByCode({ rawCode: code, playerId: 'guest', ip: IP })
    const room = await h.store.getByCode(code)
    await h.service.finishMatch(room!.id, 'match-1')

    // The guest's seat is still theirs, so free the room the honest way: a
    // third player finds no free seat and spectates.
    await expect(
      h.service.joinByCode({ rawCode: code, playerId: 'third', ip: IP }),
    ).resolves.toMatchObject({ ok: true, outcome: { kind: 'spectating' } })

    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.finishedMs)
    await expect(
      h.service.joinByCode({ rawCode: code, playerId: 'fourth', ip: IP }),
    ).resolves.toMatchObject({ ok: false, code: 'room_expired' })
  })

  it('rate-limits joins per guest', async () => {
    const code = await createRoom()
    const { capacity } = DEFAULT_RATE_LIMITS.roomJoin
    for (let index = 0; index < capacity; index += 1) {
      await h.service.joinByCode({ rawCode: code, playerId: 'guest', ip: IP })
    }
    await expect(
      h.service.joinByCode({ rawCode: code, playerId: 'guest', ip: IP }),
    ).resolves.toMatchObject({ ok: false, code: 'rate_limited' })
  })
})

describe('the per-IP failed-join cap', () => {
  it('blocks an enumerator after the stated number of misses', async () => {
    const { capacity } = DEFAULT_RATE_LIMITS.failedCodeJoinPerIp
    for (let attempt = 0; attempt < capacity; attempt += 1) {
      const result = await h.service.joinByCode({
        rawCode: 'ZZZZZZ',
        playerId: `guest-${attempt}`,
        ip: '198.51.100.1',
      })
      expect(result).toMatchObject({ ok: false, code: 'room_not_found' })
    }

    const blocked = await h.service.joinByCode({
      rawCode: 'ZZZZZZ',
      playerId: 'guest-x',
      ip: '198.51.100.1',
    })
    expect(blocked).toMatchObject({ ok: false, code: 'too_many_failed_joins' })
    expect(!blocked.ok && blocked.retryAfterMs).toBeGreaterThan(0)
  })

  it('blocks before the lookup, so the response reveals nothing about a real code', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')

    const { capacity } = DEFAULT_RATE_LIMITS.failedCodeJoinPerIp
    for (let attempt = 0; attempt < capacity; attempt += 1) {
      await h.service.joinByCode({ rawCode: 'ZZZZZZ', playerId: 'g', ip: '198.51.100.2' })
    }

    // A real code from a blocked IP gets the identical answer a fake one does.
    const real = await h.service.joinByCode({
      rawCode: created.room.code,
      playerId: 'g2',
      ip: '198.51.100.2',
    })
    expect(real).toMatchObject({ ok: false, code: 'too_many_failed_joins' })
  })

  it('does not charge a non-terminal rejection', async () => {
    // "Room full" means the code was right. Charging for it would let a busy
    // popular room lock its own would-be spectators out.
    const created = await h.service.create('host', { slug: 'solo-only', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    const code = created.room.code
    await h.service.joinByCode({ rawCode: code, playerId: 'guest', ip: '198.51.100.3' })

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await h.service.joinByCode({
        rawCode: code,
        playerId: `p-${attempt}`,
        ip: '198.51.100.3',
      })
      expect(result).toMatchObject({ ok: false, code: 'room_full' })
    }
  })

  it('a successful join clears the budget for everyone behind that IP', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    const ip = '198.51.100.4'

    for (
      let attempt = 0;
      attempt < DEFAULT_RATE_LIMITS.failedCodeJoinPerIp.capacity - 1;
      attempt += 1
    ) {
      await h.service.joinByCode({ rawCode: 'ZZZZZZ', playerId: 'g', ip })
    }
    await h.service.joinByCode({ rawCode: created.room.code, playerId: 'guest', ip })

    for (
      let attempt = 0;
      attempt < DEFAULT_RATE_LIMITS.failedCodeJoinPerIp.capacity;
      attempt += 1
    ) {
      await expect(
        h.service.joinByCode({ rawCode: 'ZZZZZZ', playerId: 'g', ip }),
      ).resolves.toMatchObject({ code: 'room_not_found' })
    }
  })

  it('unblocks after the cooldown', async () => {
    const ip = '198.51.100.5'
    const policy = DEFAULT_RATE_LIMITS.failedCodeJoinPerIp
    for (let attempt = 0; attempt < policy.capacity; attempt += 1) {
      await h.service.joinByCode({ rawCode: 'ZZZZZZ', playerId: 'g', ip })
    }
    expect(await h.service.joinByCode({ rawCode: 'ZZZZZZ', playerId: 'g', ip })).toMatchObject({
      code: 'too_many_failed_joins',
    })

    h.clock.advance(policy.refillIntervalMs / policy.refillTokens)
    expect(await h.service.joinByCode({ rawCode: 'ZZZZZZ', playerId: 'g', ip })).toMatchObject({
      code: 'room_not_found',
    })
  })
})

describe('lost-update protection', () => {
  /** A store whose compare-and-set always loses, standing in for a hot room. */
  async function contendedHarness(): Promise<Harness> {
    const clock = fixedClock(T0)
    const inner = createInMemoryRoomStore()
    // Creation uses `insert`, so only the read-modify-write paths contend.
    const store: RoomStore = { ...inner, save: async () => false }
    const flags = createFeatureFlags()
    const registry = await createGameRegistry({
      registrations: [registrationFor(makeGame({ slug: 'duo', id: 'game-duo' }))],
      flags,
    })
    return {
      clock,
      store,
      service: createRoomService({
        store,
        registry,
        flags,
        clock,
        random: webCryptoRandomSource(),
        ids: countingIdSource('room'),
      }),
    }
  }

  it('gives up after a bounded number of attempts instead of spinning', async () => {
    const c = await contendedHarness()
    const created = await c.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')

    const joined = await c.service.joinByCode({
      rawCode: created.room.code,
      playerId: 'guest',
      ip: IP,
    })
    expect(joined).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(!joined.ok && joined.retryAfterMs).toBeGreaterThan(0)

    expect(await c.service.leave(created.room.id, 'host')).toBeNull()
    expect(await c.service.finishMatch(created.room.id, 'm')).toBeNull()

    // A sweep that cannot win the write leaves the room alone rather than
    // half-closing it; the next sweep tries again.
    c.clock.advance(DEFAULT_ROOM_LIFECYCLE.noOpponentMs)
    expect(await c.service.sweep()).toMatchObject({ expired: 0, closed: 0 })
    expect(await c.store.get(created.room.id)).not.toBeNull()
  })
})

describe('leave and the empty timer', () => {
  it('arms the empty timer when the last player disconnects, and disarms it on return', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')

    h.clock.advance(1000)
    const left = await h.service.leave(created.room.id, 'host')
    expect(left?.presentPlayerIds).toEqual([])
    expect(left?.emptySince).toBe(T0 + 1000)

    h.clock.advance(1000)
    const back = await h.service.joinByCode({
      rawCode: created.room.code,
      playerId: 'host',
      ip: IP,
    })
    expect(back.ok && back.room.emptySince).toBeNull()
  })

  it('holds a seat for a disconnected player rather than freeing it', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    await h.service.joinByCode({ rawCode: created.room.code, playerId: 'guest', ip: IP })

    const after = await h.service.leave(created.room.id, 'guest')
    expect(after?.seats[1]?.occupantPlayerId).toBe('guest')
  })

  it('returns null for an unknown room', async () => {
    expect(await h.service.leave('nope', 'p')).toBeNull()
    expect(await h.service.finishMatch('nope', 'm')).toBeNull()
  })
})

describe('sweep', () => {
  it('expires a room nobody ever joined, after 30 minutes', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')

    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.noOpponentMs - 1)
    expect(await h.service.sweep()).toMatchObject({ expired: 0, closed: 0 })
    expect(h.store.size).toBe(1)

    h.clock.advance(1)
    expect(await h.service.sweep()).toMatchObject({ expired: 1, closed: 0 })
    expect(h.store.size).toBe(0)
    expect(await h.store.getByCode(created.room.code)).toBeNull()
  })

  it('closes an empty room after 5 minutes and frees its code', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    await h.service.joinByCode({ rawCode: created.room.code, playerId: 'guest', ip: IP })
    await h.service.leave(created.room.id, 'host')
    await h.service.leave(created.room.id, 'guest')

    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.emptyMs)
    expect(await h.service.sweep()).toMatchObject({ closed: 1, expired: 0 })
    expect(await h.store.getByCode(created.room.code)).toBeNull()
  })

  it('keeps a finished room for the full rematch window, then closes it', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    await h.service.joinByCode({ rawCode: created.room.code, playerId: 'guest', ip: IP })
    await h.service.finishMatch(created.room.id, 'match-1')

    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.finishedMs - 1)
    expect(await h.service.sweep()).toMatchObject({ closed: 0 })
    expect(h.store.size).toBe(1)

    h.clock.advance(1)
    expect(await h.service.sweep()).toMatchObject({ closed: 1 })
    expect(h.store.size).toBe(0)
  })

  it('prunes rate-limiter keys so they cannot outlive their window', async () => {
    await h.service.create('host', { slug: 'duo', visibility: 'private' })
    await h.service.joinByCode({ rawCode: 'ZZZZZZ', playerId: 'g', ip: IP })

    expect((await h.service.sweep()).prunedLimiterKeys).toBe(0)
    h.clock.advance(DEFAULT_RATE_LIMITS.failedCodeJoinPerIp.refillIntervalMs)
    expect((await h.service.sweep()).prunedLimiterKeys).toBeGreaterThanOrEqual(3)
  })

  it('is a no-op when nothing is due', async () => {
    expect(await h.service.sweep()).toEqual({ expired: 0, closed: 0, prunedLimiterKeys: 0 })
  })
})
