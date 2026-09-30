/**
 * The `timer:sync` message and the persisted snapshot, with their schemas.
 *
 * Two rules from the engineering standards meet here:
 *
 * 1. **Every JSON message has a `zod` schema.** `timer:sync` only ever travels
 *    server -> client, so parsing it on the server is not a trust boundary —
 *    but the *client* parses it, and a client that trusts an unvalidated frame
 *    is one malformed deploy away from rendering `NaN` on every clock. The
 *    snapshot schema is a genuine trust boundary: it is what comes back out of
 *    Redis after a restart, and a stale-shaped blob must fail loudly rather
 *    than resume a match with a plausible lie for a clock.
 * 2. **Absolute deadlines, not countdowns.** `deadlineAtMs` is in *server*
 *    time. The client converts with its measured offset. A countdown would
 *    bake the one-way latency into every clock permanently; a deadline is
 *    self-correcting on the next sync.
 *
 * `serverTime` rides on every sync so the client can re-estimate its offset
 * from any frame without a separate ping channel.
 */

import { z } from 'zod'

/** Serialisable state for one timer, as it appears on the wire. */
export const timerSyncEntrySchema = z.object({
  timerId: z.string().min(1),
  seatId: z.string().min(1).nullable(),
  kind: z.enum(['turn', 'chess-clock', 'phase', 'grace', 'match', 'custom']),
  state: z.enum(['running', 'paused', 'expired']),
  /** Remaining budget as of `serverTime`. Rendered directly when paused. */
  remainingMs: z.number().int().nonnegative(),
  /** Absolute server-time expiry while running; null when paused or expired. */
  deadlineAtMs: z.number().int().nullable(),
  /** Unspent `simple` delay for the current turn, as of `serverTime`. */
  delayRemainingMs: z.number().int().nonnegative(),
  version: z.number().int().positive(),
})
export type TimerSyncEntry = z.infer<typeof timerSyncEntrySchema>

/**
 * `timer:sync`. Sent on join, on reconnect, whenever a timer changes, and on a
 * low-rate keepalive so a long-idle client re-measures its offset.
 */
export const timerSyncMessageSchema = z.object({
  type: z.literal('timer:sync'),
  matchId: z.string().min(1),
  /** The server clock at the moment the frame was built. */
  serverTime: z.number().int(),
  /**
   * Echo of `clientMsgId` when this sync answers an explicit request. The
   * client needs it to pair the frame with the request it timed, which is the
   * whole basis of the round-trip estimate.
   */
  replyTo: z.string().min(1).nullable().optional(),
  timers: z.array(timerSyncEntrySchema),
})
export type TimerSyncMessage = z.infer<typeof timerSyncMessageSchema>

/** Client -> server: "resend the clocks and stamp them". */
export const timerSyncRequestSchema = z.object({
  type: z.literal('timer:sync-request'),
  clientMsgId: z.string().min(1).max(64),
})
export type TimerSyncRequest = z.infer<typeof timerSyncRequestSchema>

const playerClockConfigSchema = z.object({
  initialMs: z.number().int().nonnegative(),
  incrementMs: z.number().int().nonnegative(),
  delayMs: z.number().int().nonnegative(),
  delayMode: z.enum(['none', 'simple', 'bronstein']),
  maxMs: z.number().int().positive().nullable(),
})

const timerRecordSchema = z.object({
  timerId: z.string().min(1),
  seatId: z.string().min(1).nullable(),
  kind: z.enum(['turn', 'chess-clock', 'phase', 'grace', 'match', 'custom']),
  remainingMs: z.number().int().nonnegative(),
  startedAtMs: z.number().int().nullable(),
  delayRemainingMs: z.number().int().nonnegative(),
  turnElapsedMs: z.number().int().nonnegative(),
  clock: playerClockConfigSchema.nullable(),
  expired: z.boolean(),
  /**
   * Which hold scopes covered this timer when the snapshot was taken. Optional
   * with an empty default so a snapshot written by a pre-hold build still
   * restores — a live match must survive the deploy that introduces the field,
   * and an unheld timer is the correct reading of a snapshot that had no
   * concept of holds.
   *
   * In a `version: 2` snapshot this is derived state; the scopes on the
   * snapshot itself are the authority. In a `version: 1` snapshot it is the
   * *only* record of a hold, so `TimerService.restore` reads the scopes back
   * out of it.
   */
  holds: z.array(z.enum(['room', 'seat-disconnect', 'timer'])).default([]),
  version: z.number().int().positive(),
})

const snapshotBase = {
  matchId: z.string().min(1),
  savedAtMs: z.number().int(),
  timers: z.array(timerRecordSchema),
}

/**
 * The shape written before hold scopes moved off the record.
 *
 * Kept as a read path, not for nostalgia: a deploy lands while matches are live,
 * and the snapshot in Redis was written by the process we just replaced. The
 * scopes are recovered from each record's `holds` on the way in.
 */
export const timerSnapshotV1Schema = z.object({ version: z.literal(1), ...snapshotBase })

/**
 * The current shape.
 *
 * The four fields above `timers` are the ones a record cannot carry: who is on
 * move is game state, and a room freeze, an absent seat and a reducer's pause
 * are properties of the room, the seat and the timer id. Persisting them per
 * record loses every timer that was not running when the pause ran.
 */
export const timerSnapshotV2Schema = z.object({
  version: z.literal(2),
  ...snapshotBase,
  /** The seat whose `chess-clock` timers may run. Null between turns. */
  onMoveSeatId: z.string().min(1).nullable(),
  /** A host pause or a rematch vote: nothing in the room may run. */
  roomHeld: z.boolean(),
  /** Seats that are absent. */
  heldSeats: z.array(z.string().min(1)),
  /** Timer ids a game reducer paused explicitly. */
  heldTimers: z.array(z.string().min(1)),
})

/**
 * What goes into Redis under the room's key.
 *
 * `savedAtMs` is not decoration. A restored service compares it against the
 * restoring process's clock, and a snapshot from the future (wall clock stepped
 * backwards between the two processes) is rejected rather than used to hand
 * every player extra time.
 *
 * Reads accept either version; `TimerService.snapshot()` only ever writes v2.
 */
export const timerSnapshotSchema = z.discriminatedUnion('version', [
  timerSnapshotV1Schema,
  timerSnapshotV2Schema,
])
/** What we write. */
export type TimerSnapshot = z.infer<typeof timerSnapshotV2Schema>
/** What we accept. */
export type AnyTimerSnapshot = z.infer<typeof timerSnapshotSchema>
