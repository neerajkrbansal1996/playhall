/**
 * A minimal real-time game implemented against the real-time contract.
 *
 * M1 deliverable: prove the *shape* compiles and that a tick loop, binary
 * codecs and per-viewer snapshots can be expressed without reaching outside
 * `@playhall/game-sdk`. The room runner, the netcode kit and the real Tag Arena
 * are M6 and board-gated — nothing here runs in production.
 *
 * It deliberately exercises the parts that would otherwise only be checked in
 * M6: a world mutated in place by `tick`, an input clamped server-side, and a
 * snapshot that redacts by distance (hidden information in a real-time game).
 */

import { z } from 'zod'
import {
  DEFAULT_DISCONNECT_POLICY,
  PUBLIC,
  type BinaryCodec,
  type GameEvent,
  type GameManifest,
  type MatchResult,
  type RealtimeContext,
  type RealtimeGameServer,
  type SeatId,
  type SeatRoster,
  type Viewer,
  standingsFromWinners,
} from '../../src/index.js'

export const settingsSchema = z.object({
  roundSeconds: z.number().int().min(30).max(600),
  arenaRadius: z.number().positive(),
})
export type TagArenaSettings = z.infer<typeof settingsSchema>

export const inputSchema = z.object({
  /** Desired movement direction. Magnitude is clamped server-side. */
  moveX: z.number(),
  moveY: z.number(),
  tag: z.boolean(),
})
export type TagArenaInput = z.infer<typeof inputSchema>

interface Player {
  seatId: SeatId
  x: number
  y: number
  vx: number
  vy: number
  wantsTag: boolean
  isIt: boolean
  tagCount: number
}

export interface TagArenaWorld {
  players: Player[]
  elapsedMs: number
  roundMs: number
  arenaRadius: number
}

export interface TagArenaSnapshot {
  readonly tick: number
  readonly players: readonly {
    readonly seatId: SeatId
    readonly x: number
    readonly y: number
    readonly isIt: boolean
  }[]
}

type TagArenaEvent = GameEvent<'tagged', { readonly from: SeatId; readonly to: SeatId }>

const MAX_SPEED_UNITS_PER_SECOND = 6
const TAG_RADIUS = 1.2
/** How far a player can see. Beyond this, others are not in the snapshot. */
const VISION_RADIUS = 20

/** Stand-in codecs. `@playhall/netcode` supplies the real writer/reader in M6. */
const inputCodec: BinaryCodec<TagArenaInput> = {
  id: 'tag-arena.input.v1',
  encode(value, out) {
    out.quantised(value.moveX, -1, 1, 8)
    out.quantised(value.moveY, -1, 1, 8)
    out.bool(value.tag)
  },
  decode(input) {
    return {
      moveX: input.quantised(-1, 1, 8),
      moveY: input.quantised(-1, 1, 8),
      tag: input.bool(),
    }
  },
}

const snapshotCodec: BinaryCodec<TagArenaSnapshot> = {
  id: 'tag-arena.snapshot.v1',
  encode(value, out) {
    out.varuint(value.tick)
    out.varuint(value.players.length)
    for (const player of value.players) {
      out.string(player.seatId)
      out.quantised(player.x, -64, 64, 16)
      out.quantised(player.y, -64, 64, 16)
      out.bool(player.isIt)
    }
  },
  decode(input) {
    const tick = input.varuint()
    const count = input.varuint()
    const players = Array.from({ length: count }, () => ({
      seatId: input.string() as SeatId,
      x: input.quantised(-64, 64, 16),
      y: input.quantised(-64, 64, 16),
      isIt: input.bool(),
    }))
    return { tick, players }
  },
}

export const manifest: GameManifest<TagArenaSettings> = {
  id: 'tag-arena',
  slug: 'tag-arena',
  name: 'Tag Arena',
  shortDescription: 'Real-time tag. The contract fixture for the M6 netcode kit.',
  thumbnail: 'assets/thumbnail.png',
  category: 'action',
  minPlayers: 2,
  maxPlayers: 12,
  teams: 'none',
  turnModel: 'realtime',
  realtime: {
    tickRate: 30,
    snapshotRate: 15,
    requires3D: true,
    assetBundleSizeKb: 1800,
    supportedInputs: ['pointer', 'touch', 'keyboard', 'gamepad'],
    minClientSpec: { webgl2: true, minDeviceMemoryGb: 2, minDownlinkKbps: 500 },
  },
  hasHiddenInformation: true,
  usesRandomness: true,
  supportsSpectators: true,
  supportsBots: false,
  settingsSchema,
  defaultSettings: { roundSeconds: 180, arenaRadius: 32 },
  presets: [
    {
      id: 'standard',
      label: 'Standard',
      settings: { roundSeconds: 180, arenaRadius: 32 },
      isDefault: true,
    },
  ],
  timers: [{ id: 'round', kind: 'match', description: 'Round length.', pausesOnDisconnect: false }],
  status: 'coming-soon',
  version: '0.1.0',
  sdkContractVersion: 1,
}

export const server: RealtimeGameServer<
  TagArenaWorld,
  TagArenaInput,
  TagArenaSnapshot,
  TagArenaSettings,
  TagArenaEvent
> = {
  inputSchema,
  inputCodec,
  snapshotCodec,

  createWorld(ctx: RealtimeContext, settings: TagArenaSettings, seats: SeatRoster): TagArenaWorld {
    return {
      players: seats.map((seat, index) => ({
        seatId: seat.seatId,
        // Spawn points come from ctx.rng, so a replay respawns identically.
        x: ctx.rng.int(-10, 11),
        y: ctx.rng.int(-10, 11),
        vx: 0,
        vy: 0,
        wantsTag: false,
        isIt: index === 0,
        tagCount: 0,
      })),
      elapsedMs: 0,
      roundMs: settings.roundSeconds * 1000,
      arenaRadius: settings.arenaRadius,
    }
  },

  onInput(_ctx, world, seatId, input) {
    const player = world.players.find((candidate) => candidate.seatId === seatId)
    if (player === undefined) return world

    // The client asked to move; the server decides how fast. A modified client
    // sending moveX: 1000 gets the same speed as everyone else.
    const magnitude = Math.hypot(input.moveX, input.moveY)
    const scale = magnitude > 1 ? 1 / magnitude : 1
    player.vx = input.moveX * scale * MAX_SPEED_UNITS_PER_SECOND
    player.vy = input.moveY * scale * MAX_SPEED_UNITS_PER_SECOND
    player.wantsTag = input.tag
    return world
  },

  tick(_ctx, world, dtMs) {
    const dt = dtMs / 1000
    const events: TagArenaEvent[] = []

    for (const player of world.players) {
      player.x += player.vx * dt
      player.y += player.vy * dt
      const distance = Math.hypot(player.x, player.y)
      if (distance > world.arenaRadius) {
        player.x = (player.x / distance) * world.arenaRadius
        player.y = (player.y / distance) * world.arenaRadius
      }
    }

    for (const tagger of world.players) {
      if (!tagger.isIt || !tagger.wantsTag) continue
      for (const target of world.players) {
        if (target === tagger) continue
        if (Math.hypot(target.x - tagger.x, target.y - tagger.y) > TAG_RADIUS) continue
        tagger.isIt = false
        tagger.tagCount += 1
        target.isIt = true
        events.push({
          type: 'tagged',
          payload: { from: tagger.seatId, to: target.seatId },
          audience: PUBLIC,
        })
        break
      }
    }

    world.elapsedMs += dtMs
    return { world, events }
  },

  getSnapshotFor(world, viewer: Viewer, options): TagArenaSnapshot {
    const self =
      viewer.kind === 'seat'
        ? world.players.find((player) => player.seatId === viewer.seatId)
        : undefined

    // Redaction in a real-time game is a distance cull, not a field mask: a
    // player who is not visible is simply absent from the bytes, so no
    // modified client can render them.
    const visible =
      self === undefined
        ? world.players
        : world.players.filter(
            (player) => Math.hypot(player.x - self.x, player.y - self.y) <= VISION_RADIUS,
          )

    return {
      tick: options.tick,
      players: visible.map((player) => ({
        seatId: player.seatId,
        x: player.x,
        y: player.y,
        isIt: player.isIt,
      })),
    }
  },

  onPlayerLeave(_ctx, world, seatId) {
    world.players = world.players.filter((player) => player.seatId !== seatId)
    return world
  },

  getResult(world): MatchResult | null {
    if (world.elapsedMs < world.roundMs) return null
    const best = Math.max(...world.players.map((player) => player.tagCount))
    const winners = world.players.filter((player) => player.tagCount === best)
    return {
      reason: 'completed',
      standings: standingsFromWinners(
        world.players.map((player) => player.seatId),
        winners.map((player) => player.seatId),
      ),
    }
  },

  disconnectPolicy: {
    ...DEFAULT_DISCONNECT_POLICY,
    graceMs: 10_000,
    onGraceExpired: 'nothing',
    pauseTimersDuringGrace: false,
  },
}
