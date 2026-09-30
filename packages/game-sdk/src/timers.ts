/**
 * Timers.
 *
 * A game does not *start* a timer, it *asks* for one. `setTimer(...)` returns a
 * value; the room runner performs the scheduling. If games could schedule
 * directly they would need a handle to the runner, which is both a side effect
 * inside a supposedly pure reducer and a hole straight through the plugin
 * boundary. Returning commands keeps `applyAction` a pure function of its
 * inputs, which is what makes replay and crash recovery work.
 *
 * Delays are relative (`delayMs`). The runner resolves them against the same
 * `ctx.now` it passed in, so the same input always produces the same deadline.
 */

import type { SeatId, TimerId } from './ids.js'

export type TimerKind =
  /** One deadline for the seat to move; expiry is usually a forfeit or a pass. */
  | 'turn'
  /** A per-seat budget that counts down only while that seat is to move. */
  | 'chess-clock'
  /** A deadline for a whole phase, e.g. simultaneous bidding. */
  | 'phase'
  /** Reconnection grace. Usually driven by `disconnectPolicy`, not by the game. */
  | 'grace'
  /** A ceiling on the whole match. */
  | 'match'
  | 'custom'

/**
 * A timer the game declares in its manifest. Declaration lets the lobby show
 * time controls, and lets the platform reject an `onTimer` for an id the game
 * never declared.
 */
export interface TimerSpec {
  /** Unique within the manifest. Matches the `timerId` passed to `onTimer`. */
  readonly id: string
  readonly kind: TimerKind
  /** Developer-facing. Player-facing labels come from platform copy. */
  readonly description: string
  /** Whether the runner freezes this timer while its seat is disconnected. */
  readonly pausesOnDisconnect: boolean
}

export type TimerCommand =
  | {
      readonly op: 'set'
      readonly timerId: TimerId
      /**
       * The seat the timer belongs to, or null for a match-wide timer. Always
       * present: re-arming an existing timer transfers ownership to whatever
       * this says, so there is no "leave it as it was" value. See `setTimer`.
       */
      readonly seatId: SeatId | null
      /** Relative to the `ctx.now` of the call that returned this command. */
      readonly delayMs: number
      /** Replaces an existing timer with the same id (the default). */
      readonly replace?: boolean
    }
  | { readonly op: 'clear'; readonly timerId: TimerId }
  | { readonly op: 'pause'; readonly timerId: TimerId }
  | { readonly op: 'resume'; readonly timerId: TimerId }

/**
 * The helpers return their narrowed branch rather than the whole union, so a
 * caller can read `setTimer(...).delayMs` without re-narrowing something it
 * just built.
 */
export type SetTimerCommand = Extract<TimerCommand, { op: 'set' }>
export type ClearTimerCommand = Extract<TimerCommand, { op: 'clear' }>
export type PauseTimerCommand = Extract<TimerCommand, { op: 'pause' }>
export type ResumeTimerCommand = Extract<TimerCommand, { op: 'resume' }>

/**
 * Asks for a timer. `seatId` is required, and having to state it is the point.
 *
 * On a re-arm — a `set` for a `timerId` that already exists — this argument
 * **transfers ownership** of the timer to the seat named here, and `null`
 * **disowns** it, making the timer match-wide. Seat-scoped effects reach a timer
 * through its owner, so a disowned turn deadline is no longer frozen when its
 * player disconnects: they drop on mobile data and lose on a timeout they never
 * saw. A default would let `setTimer(MOVE_TIMER, 30_000)` read at the call site
 * as "re-arm the move deadline" while quietly stripping that protection, so
 * there is no default. Pass `null` only when the timer really is match-wide.
 */
export function setTimer(
  timerId: TimerId,
  delayMs: number,
  seatId: SeatId | null,
): SetTimerCommand {
  return { op: 'set', timerId, seatId, delayMs }
}

export function clearTimer(timerId: TimerId): ClearTimerCommand {
  return { op: 'clear', timerId }
}

export function pauseTimer(timerId: TimerId): PauseTimerCommand {
  return { op: 'pause', timerId }
}

export function resumeTimer(timerId: TimerId): ResumeTimerCommand {
  return { op: 'resume', timerId }
}
