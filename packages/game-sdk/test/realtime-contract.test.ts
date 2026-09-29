/**
 * Exercises the real-time contract against the Tag Arena fixture.
 *
 * The room runner is M6 and board-gated, so this test *is* the M1 loop: it
 * calls `createWorld` / `onInput` / `tick` / `getSnapshotFor` in the order a
 * 30 Hz runner would. That is enough to prove the shape holds up, that the
 * server can overrule a modified client, and that snapshots redact.
 */

import { describe, expect, it } from 'vitest'
import {
  type RealtimeContext,
  type Seat,
  asGameId,
  asMatchId,
  asMatchSeed,
  asPlayerId,
  asSeatId,
  createRealtimeContext,
  seatViewer,
  SPECTATOR,
} from '../src/index.js'
import { manifest, server, type TagArenaWorld } from './fixtures/tag-arena.js'

const SEED = asMatchSeed('arena-seed')
const seats: Seat[] = Array.from({ length: 4 }, (_, index) => ({
  seatId: asSeatId(`seat-${index}`),
  index,
  teamId: null,
  occupant: { playerId: asPlayerId(`p${index}`), displayName: `P${index}`, isBot: false },
}))

const settings = { roundSeconds: 60, arenaRadius: 32 }
const TICK_MS = 1000 / 30

function ctx(tick: number, seed = SEED): RealtimeContext {
  return createRealtimeContext({
    matchId: asMatchId('m1'),
    gameId: asGameId('tag-arena'),
    gameVersion: '0.1.0',
    sdkContractVersion: 1,
    now: 1_700_000_000_000 + tick * TICK_MS,
    seed,
    sequence: tick,
    tick,
    tickRate: manifest.realtime!.tickRate,
  })
}

/** Runs the loop a runner would run: inputs, then a tick, `ticks` times. */
function run(ticks: number, seed = SEED): TagArenaWorld {
  let world = server.createWorld(ctx(0, seed), settings, seats)
  for (let tick = 1; tick <= ticks; tick += 1) {
    for (const seat of seats) {
      world = server.onInput(ctx(tick, seed), world, seat.seatId, {
        moveX: 1,
        moveY: 0,
        tag: true,
      })
    }
    world = server.tick(ctx(tick, seed), world, TICK_MS).world
  }
  return world
}

describe('determinism', () => {
  it('same seed and same inputs produce an identical world', () => {
    expect(run(60)).toEqual(run(60))
  })

  it('a different seed produces different spawn points', () => {
    const a = server.createWorld(ctx(0), settings, seats)
    const b = server.createWorld(ctx(0, asMatchSeed('other')), settings, seats)
    expect(a.players.map((p) => [p.x, p.y])).not.toEqual(b.players.map((p) => [p.x, p.y]))
  })

  it('spawns every player inside the arena', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    expect(world.players).toHaveLength(seats.length)
    for (const player of world.players) {
      expect(Math.hypot(player.x, player.y)).toBeLessThanOrEqual(settings.arenaRadius)
    }
  })

  it('makes exactly one player "it" at the start', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    expect(world.players.filter((player) => player.isIt)).toHaveLength(1)
  })
})

describe('server authority over input', () => {
  it('clamps a movement vector longer than the speed cap', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    const seatId = seats[0]!.seatId

    // A modified client claiming a 1000-unit movement vector.
    server.onInput(ctx(1), world, seatId, { moveX: 1000, moveY: 0, tag: false })
    const cheating = world.players.find((p) => p.seatId === seatId)!
    const cheatingSpeed = Math.hypot(cheating.vx, cheating.vy)

    server.onInput(ctx(2), world, seatId, { moveX: 1, moveY: 0, tag: false })
    const honestSpeed = Math.hypot(cheating.vx, cheating.vy)

    expect(cheatingSpeed).toBeCloseTo(honestSpeed, 6)
    expect(cheatingSpeed).toBeCloseTo(6, 6)
  })

  it('keeps a diagonal input at the same speed as a straight one', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    const seatId = seats[0]!.seatId
    server.onInput(ctx(1), world, seatId, { moveX: 1, moveY: 1, tag: false })
    const player = world.players.find((p) => p.seatId === seatId)!
    expect(Math.hypot(player.vx, player.vy)).toBeCloseTo(6, 6)
  })

  it('ignores input for a seat that is not in the world', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    const before = structuredClone(world)
    server.onInput(ctx(1), world, asSeatId('ghost'), { moveX: 1, moveY: 1, tag: true })
    expect(world).toEqual(before)
  })

  it('keeps players inside the arena no matter how long they run', () => {
    const world = run(300)
    for (const player of world.players) {
      expect(Math.hypot(player.x, player.y)).toBeLessThanOrEqual(settings.arenaRadius + 1e-9)
    }
  })
})

describe('inputSchema', () => {
  it('rejects malformed input before the game sees it', () => {
    expect(server.inputSchema.safeParse({ moveX: 0, moveY: 0, tag: false }).success).toBe(true)
    expect(server.inputSchema.safeParse({ moveX: 'left', moveY: 0, tag: false }).success).toBe(
      false,
    )
    expect(server.inputSchema.safeParse({ moveX: 0, moveY: 0 }).success).toBe(false)
  })
})

describe('getSnapshotFor redaction', () => {
  it('omits players outside the vision radius of the viewer', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    const [near, far] = [world.players[0]!, world.players[1]!]
    near.x = 0
    near.y = 0
    far.x = 60
    far.y = 0

    const snapshot = server.getSnapshotFor(world, seatViewer(near.seatId), {
      baselineTick: null,
      tick: 1,
    })
    const visible = snapshot.players.map((player) => player.seatId)
    expect(visible).toContain(near.seatId)
    // Not masked, not zeroed — absent. A modified client has nothing to render.
    expect(visible).not.toContain(far.seatId)
  })

  it('includes a distant player once they come into range', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    const [near, far] = [world.players[0]!, world.players[1]!]
    near.x = 0
    near.y = 0
    far.x = 5
    far.y = 0

    const snapshot = server.getSnapshotFor(world, seatViewer(near.seatId), {
      baselineTick: null,
      tick: 1,
    })
    expect(snapshot.players.map((player) => player.seatId)).toContain(far.seatId)
  })

  it('carries the requested tick so the client can reconcile', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    expect(server.getSnapshotFor(world, SPECTATOR, { baselineTick: 40, tick: 42 }).tick).toBe(42)
  })
})

describe('binary codecs', () => {
  it('declares versioned codec ids for input and snapshot', () => {
    expect(server.inputCodec.id).toMatch(/\.v\d+$/)
    expect(server.snapshotCodec.id).toMatch(/\.v\d+$/)
  })

  it('round-trips an input through a writer/reader pair', () => {
    const { writer, reader } = recordingCodecPair()
    const input = { moveX: 0.5, moveY: -0.25, tag: true }
    server.inputCodec.encode(input, writer)
    expect(server.inputCodec.decode(reader)).toEqual(input)
  })
})

describe('lifecycle and result', () => {
  it('removes a seat that leaves', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    const leaving = seats[2]!.seatId
    server.onPlayerLeave!(ctx(1), world, leaving, 'left')
    expect(world.players.map((player) => player.seatId)).not.toContain(leaving)
  })

  it('is null until the round time is spent', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    expect(server.getResult(world)).toBeNull()
    world.elapsedMs = world.roundMs
    expect(server.getResult(world)).not.toBeNull()
  })

  it('ranks by tag count, with ties sharing rank 1', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    world.elapsedMs = world.roundMs
    world.players[0]!.tagCount = 3
    world.players[1]!.tagCount = 3
    world.players[2]!.tagCount = 1

    const result = server.getResult(world)!
    expect(result.standings).toHaveLength(world.players.length)
    expect(result.standings.filter((standing) => standing.rank === 1)).toHaveLength(2)
  })

  it('advances the clock by the tick delta', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    server.tick(ctx(1), world, TICK_MS)
    expect(world.elapsedMs).toBeCloseTo(TICK_MS, 6)
  })

  it('emits a public tag event when a tag lands', () => {
    const world = server.createWorld(ctx(0), settings, seats)
    const [tagger, target] = [world.players[0]!, world.players[1]!]
    tagger.isIt = true
    target.isIt = false
    tagger.x = 0
    tagger.y = 0
    target.x = 0.5
    target.y = 0
    tagger.wantsTag = true
    tagger.vx = 0
    tagger.vy = 0
    target.vx = 0
    target.vy = 0

    const { events } = server.tick(ctx(1), world, TICK_MS)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tagged',
      payload: { from: tagger.seatId, to: target.seatId },
      audience: { kind: 'public' },
    })
    expect(target.isIt).toBe(true)
    expect(tagger.isIt).toBe(false)
  })
})

/**
 * A minimal in-memory `BinaryWriter`/`BinaryReader` pair. `@atrium/netcode`
 * ships the real, buffer-backed implementation in M6; this only has to be
 * good enough to prove the codec contract round-trips.
 */
function recordingCodecPair() {
  const values: unknown[] = []
  let cursor = 0
  const take = <T>(): T => values[cursor++] as T

  const writer = {
    u8: (v: number) => void values.push(v),
    u16: (v: number) => void values.push(v),
    u32: (v: number) => void values.push(v),
    i8: (v: number) => void values.push(v),
    i16: (v: number) => void values.push(v),
    i32: (v: number) => void values.push(v),
    f32: (v: number) => void values.push(v),
    f64: (v: number) => void values.push(v),
    bool: (v: boolean) => void values.push(v),
    varuint: (v: number) => void values.push(v),
    varint: (v: number) => void values.push(v),
    quantised: (v: number) => void values.push(v),
    bytes: (v: Uint8Array) => void values.push(v),
    string: (v: string) => void values.push(v),
  }

  const reader = {
    u8: () => take<number>(),
    u16: () => take<number>(),
    u32: () => take<number>(),
    i8: () => take<number>(),
    i16: () => take<number>(),
    i32: () => take<number>(),
    f32: () => take<number>(),
    f64: () => take<number>(),
    bool: () => take<boolean>(),
    varuint: () => take<number>(),
    varint: () => take<number>(),
    quantised: () => take<number>(),
    bytes: () => take<Uint8Array>(),
    string: () => take<string>(),
    get bytesRemaining() {
      return values.length - cursor
    },
  }

  return { writer, reader }
}
