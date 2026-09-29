/**
 * Game events.
 *
 * Events are the second thing that leaves the server, after views. `getViewFor`
 * is not enough on its own: a game that redacts an opponent's hand from the
 * view and then emits `{ type: 'card_drawn', payload: { card } }` to everyone
 * has leaked it anyway.
 *
 * So `audience` is **required**. There is no default. An author has to decide,
 * for every event, who may see it — and the conformance testkit fails any game
 * whose event payloads reach a seat its audience excludes.
 * (Redaction completeness.)
 */

import type { SeatId } from './ids.js'
import type { JsonValue } from './json.js'

export type EventAudience =
  /** Every seat, every spectator, and the replay. */
  | { readonly kind: 'public' }
  /** Only the listed seats. Spectators do not receive it. */
  | { readonly kind: 'seats'; readonly seatIds: readonly SeatId[] }
  /** Spectators only — e.g. commentary that would leak to a player. */
  | { readonly kind: 'spectators' }
  /**
   * Never leaves the server. Recorded in the match log and available to
   * `exportRecord` and to the post-match replay, but not streamed live.
   */
  | { readonly kind: 'server' }

export interface GameEvent<TType extends string = string, TPayload = JsonValue> {
  readonly type: TType
  readonly payload: TPayload
  readonly audience: EventAudience
}

export const PUBLIC: EventAudience = Object.freeze({ kind: 'public' })
export const SPECTATORS_ONLY: EventAudience = Object.freeze({ kind: 'spectators' })
export const SERVER_ONLY: EventAudience = Object.freeze({ kind: 'server' })

export function toSeats(...ids: readonly SeatId[]): EventAudience {
  return { kind: 'seats', seatIds: ids }
}

/** Whether a seat may receive an event with this audience. */
export function audienceIncludesSeat(audience: EventAudience, seatId: SeatId): boolean {
  switch (audience.kind) {
    case 'public':
      return true
    case 'seats':
      return audience.seatIds.includes(seatId)
    case 'spectators':
    case 'server':
      return false
  }
}

/** Whether a spectator may receive an event with this audience. */
export function audienceIncludesSpectators(audience: EventAudience): boolean {
  return audience.kind === 'public' || audience.kind === 'spectators'
}
