/**
 * Disconnect policy.
 *
 * Most players arrive by tapping a link on a phone over mobile data. Sockets
 * drop constantly, and "the connection blipped" must not read as "you lost".
 * So the policy is declarative: the game states what should happen, and the
 * platform owns the grace window, the countdown UI and the reconnect token.
 *
 * A game only needs `onDisconnect` / `onReconnect` if a disconnect changes
 * *rules* state (auto-passing a bid, revealing a hidden role). Chess does not:
 * `{ graceMs: 30_000, onGraceExpired: 'forfeit' }` plus the platform clock is
 * the whole behaviour.
 */

export type DisconnectAction =
  /** Freeze all timers and wait for `abandonMatchAfterMs`. */
  | 'pause_match'
  /** Treat the seat as having passed/played a null move and continue. */
  | 'pass_turn'
  /** The seat loses; `getResult` reports `disconnect_forfeit`. */
  | 'forfeit'
  /** Hand the seat to a bot. Only valid if the manifest sets `supportsBots`. */
  | 'substitute_bot'
  /** Carry on as if nothing happened — the seat's clock keeps running. */
  | 'nothing'

export interface DisconnectPolicy {
  /** How long the platform waits before applying `onGraceExpired`. */
  readonly graceMs: number
  readonly onGraceExpired: DisconnectAction
  /** Whether the seat's game timers freeze during the grace window. */
  readonly pauseTimersDuringGrace: boolean
  /**
   * Hard ceiling for a match with a missing seat. After this the platform
   * ends the match as `abandoned` regardless of `onGraceExpired`, so rooms
   * cannot leak. Defaults to 10 minutes when omitted.
   */
  readonly abandonMatchAfterMs?: number
  /** Whether a player may rejoin their seat at any point before the match ends. */
  readonly allowReconnectUntilMatchEnd: boolean
}

/**
 * Sensible default for a turn-based game: 30 s of grace with the clock frozen,
 * then the seat starts losing time, and the match is abandoned after 10 min.
 */
export const DEFAULT_DISCONNECT_POLICY: DisconnectPolicy = Object.freeze({
  graceMs: 30_000,
  onGraceExpired: 'nothing',
  pauseTimersDuringGrace: true,
  abandonMatchAfterMs: 600_000,
  allowReconnectUntilMatchEnd: true,
})

export type DisconnectReason = 'transport_closed' | 'timeout' | 'left' | 'kicked' | 'replaced'
