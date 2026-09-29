/**
 * The real-time server contract.
 *
 * **Types and shape only in M1.** The room runner, the netcode kit and the
 * game-server fleet are M6 and board-gated. This file exists now so that every
 * M1 decision — the lobby, seats, the registry, the manifest, results — is made
 * against a platform that already knows real-time games exist. Retrofitting a
 * tick loop onto a request/response platform is the expensive mistake this
 * package is meant to prevent.
 *
 * Differences from the turn-based contract, and why:
 *
 * - **`tick(ctx, world, dt)` may mutate `world` in place.** At 30 Hz with a
 *   12-player world and a < 5 ms p99 budget, allocating a fresh world per tick
 *   is not affordable. Determinism is preserved the same way a lockstep engine
 *   preserves it: given the same starting world and the same ordered sequence
 *   of `(input, tick)` pairs, the resulting world must be byte-identical. The
 *   function must still be free of I/O, ambient time and ambient randomness.
 * - **Inputs and snapshots are binary.** See `binary.ts`.
 * - **`getSnapshotFor` takes a baseline** so the codec can send a delta.
 *
 * ## The `shared/` convention
 *
 * A real-time game splits into three folders:
 *
 *   games/<game>/src/server/   — authoritative; may read the full world
 *   games/<game>/src/client/   — rendering, input capture, prediction
 *   games/<game>/src/shared/   — simulation that must run identically on both
 *
 * `shared/` is the only code a client is allowed to re-execute for prediction
 * and reconciliation. It therefore obeys the strictest form of the purity rule:
 * no I/O, no ambient clock, no ambient randomness, no `window`, no `process`,
 * and no import from `server/` or `client/`. CI enforces the import direction
 * (`shared/` may not import its siblings) alongside the package-level
 * dependency-boundary rule.
 *
 * The client predicting with `shared/` never makes it authoritative. The server
 * result always wins; the client reconciles.
 */

import type { z } from 'zod'
import type { BinaryCodec } from './binary.js'
import type { RealtimeContext } from './context.js'
import type { DisconnectPolicy, DisconnectReason } from './disconnect.js'
import type { GameEvent } from './events.js'
import type { SeatId } from './ids.js'
import type { GameManifest } from './manifest.js'
import type { MatchResult } from './result.js'
import type { Seat, SeatRoster } from './seats.js'
import type { TimerCommand } from './timers.js'
import type { Viewer } from './viewer.js'

export interface TickResult<TWorld, TEvent extends GameEvent = GameEvent> {
  /** May be the same object as the input world. */
  readonly world: TWorld
  readonly events: readonly TEvent[]
  readonly timers?: readonly TimerCommand[]
}

export interface SnapshotOptions {
  /**
   * The last tick this viewer is known to have acknowledged, or null when a
   * full snapshot is required (first join, or too far behind to delta).
   */
  readonly baselineTick: number | null
  /** The tick this snapshot describes. */
  readonly tick: number
}

export interface RealtimeGameServer<
  TWorld,
  TInput,
  TSnapshot,
  TSettings,
  TEvent extends GameEvent = GameEvent,
> {
  /** Validates a decoded input before the game sees it. Never trust the client. */
  readonly inputSchema: z.ZodType<TInput>
  readonly inputCodec: BinaryCodec<TInput>
  readonly snapshotCodec: BinaryCodec<TSnapshot>

  createWorld(ctx: RealtimeContext, settings: TSettings, seats: SeatRoster): TWorld

  /**
   * Buffers one player input. Returns the world so an immutable implementation
   * is possible; returning the same (mutated) object is the expected case.
   *
   * `input` has already been schema-validated. The game is still responsible
   * for rejecting inputs that are well-formed but impossible — a movement
   * vector longer than the speed cap, a fire rate above the weapon's, a tick
   * from the future. **The server decides where a player is.**
   */
  onInput(ctx: RealtimeContext, world: TWorld, seatId: SeatId, input: TInput): TWorld

  /** Advances the simulation by `dtMs`. Target: < 5 ms p99 for 12 players. */
  tick(ctx: RealtimeContext, world: TWorld, dtMs: number): TickResult<TWorld, TEvent>

  /** The real-time equivalent of `getViewFor`. Same rule: redact here or leak. */
  getSnapshotFor(world: TWorld, viewer: Viewer, options: SnapshotOptions): TSnapshot

  onPlayerJoin?(ctx: RealtimeContext, world: TWorld, seat: Seat): TWorld
  onPlayerLeave?(
    ctx: RealtimeContext,
    world: TWorld,
    seatId: SeatId,
    reason: DisconnectReason,
  ): TWorld
  onPlayerReconnect?(ctx: RealtimeContext, world: TWorld, seatId: SeatId): TWorld

  getResult(world: TWorld): MatchResult | null

  readonly disconnectPolicy: DisconnectPolicy
}

export type AnyRealtimeGameServer = RealtimeGameServer<unknown, unknown, unknown, unknown, GameEvent>

export interface RealtimeGameDefinition<
  TWorld,
  TInput,
  TSnapshot,
  TSettings,
  TEvent extends GameEvent = GameEvent,
> {
  readonly manifest: GameManifest<TSettings>
  readonly server: RealtimeGameServer<TWorld, TInput, TSnapshot, TSettings, TEvent>
}
