/**
 * Who is being shown the game.
 *
 * Every byte of game state that reaches a client passes through
 * `getViewFor(state, viewer)` (turn-based) or `getSnapshotFor(world, viewer)`
 * (real-time). The platform never serialises raw state to a socket. A hidden
 * information leak is a correctness bug, not a polish item.
 */

import type { SeatId } from './ids.js'

export type Viewer =
  /** A player at the table. Sees their own hidden information and no one else's. */
  | { readonly kind: 'seat'; readonly seatId: SeatId }
  /**
   * A live spectator. Must be treated as an opponent of everyone: a spectator
   * stream is the easiest way to cheat, because a player can open it in a
   * second tab.
   */
  | { readonly kind: 'spectator' }
  /**
   * Full information. The platform may only construct this after
   * `getResult(state)` returns non-null — post-match review and replay export.
   * The conformance testkit asserts that no live code path builds one.
   */
  | { readonly kind: 'replay' }

export const SPECTATOR: Viewer = Object.freeze({ kind: 'spectator' })
export const REPLAY: Viewer = Object.freeze({ kind: 'replay' })

export function seatViewer(seatId: SeatId): Viewer {
  return { kind: 'seat', seatId }
}

/** The seat this viewer occupies, or null for a spectator or replay. */
export function viewerSeatId(viewer: Viewer): SeatId | null {
  return viewer.kind === 'seat' ? viewer.seatId : null
}
