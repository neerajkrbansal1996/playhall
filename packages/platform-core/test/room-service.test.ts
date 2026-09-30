import { beforeEach, describe, expect, it } from 'vitest'
import { createFeatureFlags, type FeatureFlagOverrides } from '../src/flags.js'
import { createGameRegistry } from '../src/registry/registry.js'
import { DEFAULT_RATE_LIMITS } from '../src/rate-limit/policies.js'
import {
  DEFAULT_ROOM_LIFECYCLE,
  type RoomLifecyclePolicy,
  nextRoomDeadline,
} from '../src/rooms/lifecycle.js'
import { chargesFailedJoinBudget, isTerminalRejection } from '../src/rooms/join.js'
import {
  createRoomService,
  createRoomRequestSchema,
  type RoomService,
} from '../src/rooms/service.js'
import { createInMemoryRoomStore, type RoomStore } from '../src/rooms/store.js'
import { RoomCodeSourceError, isValidRoomCode } from '../src/rooms/code.js'
import {
  countingIdSource,
  fixedClock,
  tickingClock,
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

  it('lets a broken entropy source fail loudly rather than reporting exhaustion', async () => {
    const flags = createFeatureFlags()
    const registry = await createGameRegistry({
      registrations: [registrationFor(makeGame({ slug: 'duo' }))],
      flags,
    })
    const service = createRoomService({
      store: createInMemoryRoomStore(),
      registry,
      flags,
      clock: fixedClock(T0),
      random: { randomBytes: () => new Uint8Array(0) },
      ids: countingIdSource('room'),
    })
    // "We ran out of codes" is a claim about the 887-million-code space and
    // would send an operator looking in exactly the wrong place. A CSPRNG
    // that has stopped producing bytes is a server fault and must read as one.
    await expect(service.create('host', { slug: 'duo', visibility: 'private' })).rejects.toThrow(
      RoomCodeSourceError,
    )
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

  it('restarts the rematch window when a new player re-crews a finished room', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    const { code, id } = created.room
    await h.service.finishMatch(id, 'match-1')

    // Seat 1 is free, so someone arriving near the end of the window is
    // re-crewing for a rematch, not turning up to a room that is about to
    // close under them. Sixty seconds is not enough to agree to a game.
    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.finishedMs - 60_000)
    await expect(
      h.service.joinByCode({ rawCode: code, playerId: 'guest', ip: IP }),
    ).resolves.toMatchObject({ ok: true, outcome: { kind: 'seated' } })

    // The window now runs from the moment they sat down.
    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.finishedMs - 1)
    expect(await h.service.sweep()).toMatchObject({ closed: 0 })
    h.clock.advance(1)
    expect(await h.service.sweep()).toMatchObject({ closed: 1 })
  })

  it('does not restart the rematch window for a spectator', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    const { code, id } = created.room
    await h.service.joinByCode({ rawCode: code, playerId: 'guest', ip: IP })
    await h.service.finishMatch(id, 'match-1')

    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.finishedMs - 1)
    await expect(
      h.service.joinByCode({ rawCode: code, playerId: 'watcher', ip: IP }),
    ).resolves.toMatchObject({ ok: true, outcome: { kind: 'spectating' } })

    h.clock.advance(1)
    expect(await h.service.sweep()).toMatchObject({ closed: 1 })
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

/**
 * The seat race, run under two clocks on purpose.
 *
 * `fixedClock` puts both writes in the same millisecond, which is the exact
 * condition under which a compare-and-set on `updatedAt` compares equal and
 * lets the stale write through. `tickingClock` moves time on every read, so a
 * pass there proves the protection is not merely a side effect of time
 * standing still. A regression to a timestamp token fails the first; a
 * regression that depends on time moving fails the second.
 */
describe.each([
  ['a clock that does not move', () => fixedClock(T0)],
  ['a clock that advances on every read', () => tickingClock(T0)],
])('concurrent joins for the last seat, under %s', (_label, makeClock) => {
  it('seats exactly one player and sends the loser to the spectators', async () => {
    const clock = makeClock()
    const inner = createInMemoryRoomStore()
    const flags = createFeatureFlags()
    const registry = await createGameRegistry({
      registrations: [registrationFor(makeGame({ slug: 'duo', id: 'game-duo' }))],
      flags,
    })

    // Both joiners read the room before either writes — the interleaving a
    // single-threaded event loop produces the moment a store is a network
    // call rather than a Map.
    let release: () => void = () => {}
    const bothHaveRead = new Promise<void>((resolve) => {
      let arrived = 0
      release = () => {
        arrived += 1
        if (arrived === 2) resolve()
      }
    })
    let gateArmed = true
    const store: RoomStore = {
      ...inner,
      async getByCode(code) {
        const room = await inner.getByCode(code)
        if (gateArmed) {
          release()
          await bothHaveRead
        }
        return room
      },
    }

    const service = createRoomService({
      store,
      registry,
      flags,
      clock,
      random: webCryptoRandomSource(),
      ids: countingIdSource('room'),
    })

    const created = await service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')

    const [first, second] = await Promise.all([
      service.joinByCode({ rawCode: created.room.code, playerId: 'alice', ip: '198.51.100.1' }),
      service.joinByCode({ rawCode: created.room.code, playerId: 'bob', ip: '198.51.100.2' }),
    ])
    // The loser's compare-and-set retry re-reads; let it through the gate.
    gateArmed = false

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    const kinds = [first.outcome.kind, second.outcome.kind].sort()
    expect(kinds).toEqual(['seated', 'spectating'])

    const room = await store.get(created.room.id)
    expect(room?.seats.map((seat) => seat.occupantPlayerId)).toEqual([
      'host',
      expect.stringMatching(/^(alice|bob)$/),
    ])
    // The decisive assertion: nobody was overwritten. The player who lost the
    // seat is still in the room, as a spectator.
    expect([...(room?.spectatorPlayerIds ?? [])]).toHaveLength(1)
    expect(
      new Set([...(room?.spectatorPlayerIds ?? []), room?.seats[1]?.occupantPlayerId]),
    ).toEqual(new Set(['alice', 'bob']))
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
    // `contended`, not `rate_limited`. The player spent one join token and got
    // no further than the store's own contention; blaming them for it would
    // both mislead the UI ("slow down") and hide a hot room from operators.
    expect(joined).toMatchObject({ ok: false, code: 'contended', terminal: false })
    expect(!joined.ok && joined.retryAfterMs).toBeGreaterThan(0)
    expect(chargesFailedJoinBudget('contended')).toBe(false)
    expect(isTerminalRejection('contended')).toBe(false)

    // Contention is reported as contention, never as a missing room. The two
    // are opposite instructions: retry, versus give up and treat the room as
    // gone. A `finishMatch` told "not found" would leave the room in_progress
    // with no `finishedAt`, which arms no deadline at all — the room would
    // never be swept and the players would sit in a match that never ended.
    await expect(c.service.leave(created.room.id, 'host')).resolves.toEqual({
      ok: false,
      error: { code: 'contended', retryAfterMs: expect.any(Number) },
    })
    await expect(c.service.finishMatch(created.room.id, 'm')).resolves.toEqual({
      ok: false,
      error: { code: 'contended', retryAfterMs: expect.any(Number) },
    })

    // A sweep that cannot win the write leaves the room alone rather than
    // half-closing it; the next sweep tries again.
    c.clock.advance(DEFAULT_ROOM_LIFECYCLE.noOpponentMs)
    expect(await c.service.sweep()).toMatchObject({ expired: 0, closed: 0 })
    expect(await c.store.get(created.room.id)).not.toBeNull()
  })

  it('still reports a genuinely missing room as not found', async () => {
    const c = await contendedHarness()
    await expect(c.service.leave('nope', 'p')).resolves.toEqual({
      ok: false,
      error: { code: 'room_not_found' },
    })
  })
})

describe('a closed room is terminal', () => {
  /** Creates a room, then closes it through the sweeper's own 30-minute path. */
  async function closedRoom(): Promise<string> {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.noOpponentMs)
    expect(await h.service.sweep()).toMatchObject({ expired: 1 })
    return created.room.id
  }

  it('refuses to finish a match in a room the sweeper has already closed', async () => {
    const roomId = await closedRoom()

    await expect(h.service.finishMatch(roomId, 'match-1')).resolves.toEqual({
      ok: false,
      error: { code: 'room_closed', closeReason: 'no_opponent' },
    })

    // The record is untouched: still closed, still carrying why and when.
    const after = await h.store.get(roomId)
    expect(after).toMatchObject({ status: 'closed', closeReason: 'no_opponent' })
    expect(after?.closedAt).not.toBeNull()
  })

  it('refuses a leave against a closed room rather than writing to a tombstone', async () => {
    const roomId = await closedRoom()
    const before = await h.store.get(roomId)

    await expect(h.service.leave(roomId, 'host')).resolves.toEqual({
      ok: false,
      error: { code: 'room_closed', closeReason: 'no_opponent' },
    })
    // Not even a version bump: a refused mutation is not a write.
    expect(await h.store.get(roomId)).toEqual(before)
  })

  it('room_closed is not room_not_found, because the room is still readable', async () => {
    const roomId = await closedRoom()
    expect(await h.store.get(roomId)).not.toBeNull()
    await expect(h.service.finishMatch('no-such-room', 'm')).resolves.toEqual({
      ok: false,
      error: { code: 'room_not_found' },
    })
  })

  it('keeps the removal deadline armed, so the tombstone cannot be stranded', async () => {
    const roomId = await closedRoom()
    await h.service.finishMatch(roomId, 'match-1')

    // The resurrection bug this guards: `status: 'finished'` over a tombstone
    // moves the room off `roomDeadlines`' closed branch, the `remove` candidate
    // disappears, and the room drops out of `dueForSweep` forever — a leaked
    // key holding a reserved code.
    const room = await h.store.get(roomId)
    if (room === null) throw new Error('tombstone vanished')
    expect(nextRoomDeadline(room)).toBe(room.closedAt! + DEFAULT_ROOM_LIFECYCLE.ttlGraceMs)

    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.ttlGraceMs)
    expect(await h.service.sweep()).toMatchObject({ removed: 1 })
    expect(h.store.size).toBe(0)
  })

  it('keeps a stranger out of a room the platform has told everyone is over', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    const { code, id } = created.room

    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.noOpponentMs)
    await h.service.sweep()
    await h.service.finishMatch(id, 'match-1')

    await expect(
      h.service.joinByCode({ rawCode: code, playerId: 'stranger', ip: IP }),
    ).resolves.toMatchObject({ ok: false, code: 'room_expired', terminal: true })
  })

  it('still lets a finished room be re-crewed — finished is not terminal', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    await h.service.joinByCode({ rawCode: created.room.code, playerId: 'guest', ip: IP })

    const finished = await h.service.finishMatch(created.room.id, 'match-1')
    expect(finished.ok).toBe(true)
    // A second call is legal too: the rematch window is a live room's window.
    await expect(h.service.finishMatch(created.room.id, 'match-2')).resolves.toMatchObject({
      ok: true,
    })
    await expect(h.service.leave(created.room.id, 'guest')).resolves.toMatchObject({ ok: true })
  })

  it('catches a room that closes between compare-and-set attempts', async () => {
    // The guard sits inside the retry loop because the sweeper runs
    // concurrently with every mutation. A store that loses the first write and
    // closes the room underneath must produce `room_closed`, not a write.
    const clock = fixedClock(T0)
    const inner = createInMemoryRoomStore()
    let attempts = 0
    const store: RoomStore = {
      ...inner,
      async get(roomId) {
        const room = await inner.get(roomId)
        attempts += 1
        if (attempts === 1 || room === null) return room
        return { ...room, status: 'closed', closedAt: clock.now(), closeReason: 'empty' }
      },
      async save(previous, next) {
        // Lose the first race so the loop takes a second look.
        return attempts <= 1 ? false : inner.save(previous, next)
      },
    }
    const flags = createFeatureFlags()
    const registry = await createGameRegistry({
      registrations: [registrationFor(makeGame({ slug: 'duo', id: 'game-duo' }))],
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
    const created = await service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')

    await expect(service.finishMatch(created.room.id, 'm')).resolves.toEqual({
      ok: false,
      error: { code: 'room_closed', closeReason: 'empty' },
    })
  })
})

describe('leave and the empty timer', () => {
  it('arms the empty timer when the last player disconnects, and disarms it on return', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')

    h.clock.advance(1000)
    const left = await h.service.leave(created.room.id, 'host')
    expect(left.ok && left.room.presentPlayerIds).toEqual([])
    expect(left.ok && left.room.emptySince).toBe(T0 + 1000)

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
    expect(after.ok && after.room.seats[1]?.occupantPlayerId).toBe('guest')
  })

  it('reports an unknown room as not found', async () => {
    const notFound = { ok: false, error: { code: 'room_not_found' } }
    await expect(h.service.leave('nope', 'p')).resolves.toEqual(notFound)
    await expect(h.service.finishMatch('nope', 'm')).resolves.toEqual(notFound)
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
    expect(await h.service.sweep()).toMatchObject({ expired: 1, closed: 0, removed: 0 })
    expect((await h.store.get(created.room.id))?.status).toBe('closed')

    // The tombstone, not the room, is what holds the code now.
    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.ttlGraceMs)
    expect(await h.service.sweep()).toMatchObject({ removed: 1 })
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

    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.ttlGraceMs)
    expect(await h.service.sweep()).toMatchObject({ removed: 1 })
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
    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.ttlGraceMs)
    expect(await h.service.sweep()).toMatchObject({ removed: 1 })
    expect(h.store.size).toBe(0)
  })

  it('keeps a closed room as a tombstone for the grace window, then removes it', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')

    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.noOpponentMs)
    await h.service.sweep()

    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.ttlGraceMs - 1)
    expect(await h.service.sweep()).toMatchObject({ removed: 0 })
    expect(h.store.size).toBe(1)

    h.clock.advance(1)
    expect(await h.service.sweep()).toMatchObject({ removed: 1 })
    expect(h.store.size).toBe(0)
  })

  it('tells a player on a just-dead link the room is over, and does not charge their IP', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    const { code } = created.room

    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.noOpponentMs)
    await h.service.sweep()

    // Far more arrivals than the per-IP failure budget: four friends on one
    // office Wi-Fi all tapping the same stale invite must not lock each other
    // out. They hold a real code, which is the opposite of enumeration.
    const budget = DEFAULT_RATE_LIMITS.failedCodeJoinPerIp.capacity
    for (let attempt = 0; attempt < budget + 2; attempt += 1) {
      await expect(
        h.service.joinByCode({ rawCode: code, playerId: `p${attempt}`, ip: IP }),
      ).resolves.toMatchObject({ ok: false, code: 'room_expired' })
    }

    // A guessed code from the same IP is still charged, so the enumeration
    // defence is intact.
    await expect(
      h.service.joinByCode({ rawCode: 'ZZZZZZ', playerId: 'q', ip: IP }),
    ).resolves.toMatchObject({ ok: false, code: 'room_not_found' })
  })

  it('charges the IP once the tombstone is gone and the code reads as unknown', async () => {
    const created = await h.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    const { code } = created.room

    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.noOpponentMs)
    await h.service.sweep()
    h.clock.advance(DEFAULT_ROOM_LIFECYCLE.ttlGraceMs)
    await h.service.sweep()

    await expect(
      h.service.joinByCode({ rawCode: code, playerId: 'late', ip: IP }),
    ).resolves.toMatchObject({ ok: false, code: 'room_not_found' })
  })

  it('prunes rate-limiter keys so they cannot outlive their window', async () => {
    await h.service.create('host', { slug: 'duo', visibility: 'private' })
    await h.service.joinByCode({ rawCode: 'ZZZZZZ', playerId: 'g', ip: IP })

    expect((await h.service.sweep()).prunedLimiterKeys).toBe(0)
    h.clock.advance(DEFAULT_RATE_LIMITS.failedCodeJoinPerIp.refillIntervalMs)
    expect((await h.service.sweep()).prunedLimiterKeys).toBeGreaterThanOrEqual(3)
  })

  it('is a no-op when nothing is due', async () => {
    expect(await h.service.sweep()).toEqual({
      expired: 0,
      closed: 0,
      removed: 0,
      prunedLimiterKeys: 0,
    })
  })
})

describe('a configured lifecycle policy is the one that runs', () => {
  // `RoomLifecyclePolicy` is public API and every other test in this file runs
  // the default, which is how the store's `dueForSweep` came to score candidates
  // under `DEFAULT_ROOM_LIFECYCLE` regardless of configuration. Under a short
  // policy the defaulted store selected nothing, so no room was ever swept and
  // the default-policy control case stayed green throughout.
  const FAST: RoomLifecyclePolicy = Object.freeze({
    noOpponentMs: 30_000,
    emptyMs: 5_000,
    finishedMs: 15_000,
    ttlGraceMs: 1_000,
  })

  async function fastHarness(): Promise<Harness> {
    const clock = fixedClock(T0)
    const store = createInMemoryRoomStore(FAST)
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
        lifecycle: FAST,
      }),
    }
  }

  it('sweeps on the configured deadlines, not on the defaults', async () => {
    const f = await fastHarness()
    const created = await f.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')

    f.clock.advance(FAST.noOpponentMs - 1)
    expect(await f.service.sweep()).toMatchObject({ expired: 0 })

    f.clock.advance(1)
    // Was 0 before the fix: the store still scored this room 30 minutes out, so
    // it never entered the candidate set the verdict would have expired.
    expect(await f.service.sweep()).toMatchObject({ expired: 1 })

    f.clock.advance(FAST.ttlGraceMs)
    expect(await f.service.sweep()).toMatchObject({ removed: 1 })
    expect(f.store.size).toBe(0)
  })

  it('runs the configured finished and empty windows too', async () => {
    const f = await fastHarness()
    const created = await f.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    await f.service.joinByCode({ rawCode: created.room.code, playerId: 'guest', ip: IP })
    await f.service.finishMatch(created.room.id, 'match-1')

    f.clock.advance(FAST.finishedMs)
    expect(await f.service.sweep()).toMatchObject({ closed: 1 })
  })

  it('scores the store and judges the service under one policy', async () => {
    const f = await fastHarness()
    expect(f.store.lifecycle).toEqual(FAST)

    const created = await f.service.create('host', { slug: 'duo', visibility: 'private' })
    if (!created.ok) throw new Error('setup failed')
    // The property the two halves have to agree on: the deadline the store
    // scores a room by is the deadline the verdict is taken against.
    expect(nextRoomDeadline(created.room, f.store.lifecycle)).toBe(T0 + FAST.noOpponentMs)
    expect(nextRoomDeadline(created.room)).not.toBe(T0 + FAST.noOpponentMs)
  })

  it('refuses to start when the service and the store disagree', async () => {
    const flags = createFeatureFlags()
    const registry = await createGameRegistry({
      registrations: [registrationFor(makeGame({ slug: 'duo', id: 'game-duo' }))],
      flags,
    })
    const wire = (
      lifecycle: RoomLifecyclePolicy | undefined,
      store = createInMemoryRoomStore(FAST),
    ) =>
      createRoomService({
        store,
        registry,
        flags,
        clock: fixedClock(T0),
        random: webCryptoRandomSource(),
        ids: countingIdSource('room'),
        lifecycle,
      })

    // The mismatch that used to be silent, and presents as "the lifecycle
    // timers are configured and nothing ever expires".
    expect(() => wire(DEFAULT_ROOM_LIFECYCLE)).toThrow(/disagrees with store\.lifecycle/)
    // Agreement by value, not by reference.
    expect(() => wire({ ...FAST })).not.toThrow()
    // Omitting it takes the store's policy, so there is nothing to disagree with.
    expect(() => wire(undefined)).not.toThrow()
    expect(() => wire(undefined, createInMemoryRoomStore())).not.toThrow()
  })
})
