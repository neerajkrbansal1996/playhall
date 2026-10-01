/**
 * The match log: the ordered record of every state mutation in a match.
 *
 * See ADR-0013. The log plus `(seed, settings, roster, gameVersion)` is the sole
 * tier of record for a live match — Redis is a cache that must be safe to lose
 * (ADR-0001 §6.1). Crash recovery replays this log; so does the `determinism`
 * conformance check, which is what keeps the two honest about each other.
 *
 * The load-bearing invariant, from which every field below follows:
 *
 * > **The runner appends exactly one entry for every game entry point it calls
 * > that returned an `ApplyResult`.**
 *
 * `applyAction`, `onTimer`, `onDisconnect` and `onReconnect` all return an
 * `ApplyResult`, so all four are logged. An action-only log silently drops the
 * other three, and a match restored from it comes back missing every
 * timer-driven and lifecycle-driven transition — a flagged clock un-flagged, a
 * skipped turn un-skipped. The state is plausible and wrong, and nothing
 * errors.
 *
 * `createInitialState` is the one mutation that is *not* an entry: it is
 * sequence 0 and is reconstructed from `(seed, settings, roster)`, which the
 * match row already carries.
 */

import type { DisconnectReason } from './disconnect.js'
import type { SeatId, TimerId } from './ids.js'

/**
 * Fields every entry carries, whatever produced it.
 *
 * `nowMs` is the reason this type exists rather than a bare action tuple.
 * `ctx.now` is an input to the reducer like any other, so a game that reads it
 * — to stamp a move time, to decide whether a grace window has elapsed —
 * diverges on replay unless the live value is replayed back verbatim. It cannot
 * be recomputed: for an action it is the instant the server accepted the
 * message, and for a timer it is the deadline, which the live match may have
 * fired late. Recording it is the only correct answer, and recording it on
 * *every* entry is what makes `ctx.now` reconstruction a single rule instead of
 * four.
 */
export interface MatchLogEntryBase {
  /**
   * `GameContext.sequence` for this mutation. Strictly increasing, and with
   * `seed` it determines `ctx.rng`, so it is replayed rather than re-counted:
   * re-deriving it from array position would shift every RNG stream the moment
   * a log is read from an offset.
   */
  readonly sequence: number
  /**
   * The exact `ctx.now` the live match used, verbatim. Replay feeds this back
   * in; it never consults a clock of its own.
   */
  readonly nowMs: number
}

/** An action a seat sent, accepted by `validateAction` and applied. */
export interface ActionLogEntry<TAction> extends MatchLogEntryBase {
  readonly kind: 'action'
  readonly seatId: SeatId
  readonly action: TAction
}

/**
 * A timer the game asked for fired, and `onTimer` mutated state.
 *
 * There is no `dueAtMs` field: the deadline *is* `nowMs`, because the runner
 * uses the deadline as `ctx.now` when it fires a timer. Two fields would let
 * the runner and the replayer disagree about which one is the clock; one field
 * cannot.
 *
 * `seatId` is `null` for a match-wide timer, matching `onTimer`'s signature.
 */
export interface TimerLogEntry extends MatchLogEntryBase {
  readonly kind: 'timer'
  readonly timerId: TimerId
  readonly seatId: SeatId | null
}

/**
 * A seat dropped and the game's `onDisconnect` mutated *rules* state.
 *
 * This does not contradict ADR-0008 §8, which keeps presence out of game state
 * so that a network blip is not a logged mutation. An entry is written only
 * when the game implements the hook — i.e. only when the drop changed rules
 * state and therefore has to survive a restart. A game that omits
 * `onDisconnect` logs nothing and consumes no sequence number, which is almost
 * every game.
 */
export interface DisconnectLogEntry extends MatchLogEntryBase {
  readonly kind: 'disconnect'
  readonly seatId: SeatId
  readonly reason: DisconnectReason
}

/** A seat came back and the game's `onReconnect` mutated rules state. */
export interface ReconnectLogEntry extends MatchLogEntryBase {
  readonly kind: 'reconnect'
  readonly seatId: SeatId
}

/**
 * One appended mutation. Discriminated on `kind` so adding a fifth mutating
 * entry point is a compile error at every `switch` rather than a silently
 * dropped transition — which is exactly how the action-only shape failed.
 */
export type MatchLogEntry<TAction> =
  ActionLogEntry<TAction> | TimerLogEntry | DisconnectLogEntry | ReconnectLogEntry

/** The persisted log of a match, in append order. */
export type MatchLog<TAction> = readonly MatchLogEntry<TAction>[]

/**
 * The `kind` values, for a `zod` enum or a Postgres check constraint without a
 * second copy of the list.
 */
export const MATCH_LOG_ENTRY_KINDS = ['action', 'timer', 'disconnect', 'reconnect'] as const

export type MatchLogEntryKind = (typeof MATCH_LOG_ENTRY_KINDS)[number]
