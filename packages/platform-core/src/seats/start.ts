/**
 * When a match may start, and the countdown that gets it there.
 *
 * Two start paths, one set of rules. A fixed-size game (`minPlayers ===
 * maxPlayers`) arms a 3-second countdown the moment it fills; a variable-size
 * game waits for the host, who may press Start once `minPlayers` is seated.
 * Both paths funnel through `startBlockers`, so there is exactly one answer to
 * "is this roster startable?" and the host path cannot accidentally be laxer
 * than the automatic one.
 *
 * The countdown is a **deadline on the room**, not a timer in a process. A
 * room that survives a restart can be asked "should this have started by now?"
 * with nothing but the record and a clock, which is the same reason the
 * lifecycle rules are shaped as pure `(room, now)` functions.
 *
 * Pure throughout. `seats/service.ts` owns the writes.
 */

import { type Room, occupiedSeats } from '../rooms/types.js'
import { AUTO_START_COUNTDOWN_MS, type SeatingPolicy } from './policy.js'
import { isBalanced } from './teams.js'

export const START_BLOCK_REASONS = [
  /** The room is mid-match, finished or closed. A finished room rematches instead. */
  'not_in_lobby',
  /** Fewer than `minPlayers` seats are occupied. */
  'below_min_players',
  /** A fixed-size game with a free seat. Only that mode requires a full room. */
  'not_full',
  /** Somebody has explicitly un-readied. The host may override this one. */
  'awaiting_ready',
  /**
   * A seat is held for a bot and no provider can fill it. v1 ships no
   * providers, so this is what a bot seat does today: it is declared, it is
   * visible, and it stops the match rather than starting one a seat short.
   */
  'bot_seat_unfilled',
  /** Teams are on and the sides differ by more than one player. */
  'teams_unbalanced',
] as const
export type StartBlockReason = (typeof START_BLOCK_REASONS)[number]

/**
 * Reasons the host is allowed to override.
 *
 * Exactly one: readiness. A host who can see the lobby is a better judge of
 * "are we waiting for a real person or for someone who wandered off" than a
 * flag is. Everything else is a rule about the roster itself — too few players,
 * an unfillable bot seat, lopsided teams — and a host override there would
 * start a match the game cannot run.
 */
const HOST_OVERRIDABLE: readonly StartBlockReason[] = ['awaiting_ready']

export interface SeatingSnapshot {
  readonly seated: number
  readonly ready: number
  readonly full: boolean
  readonly minMet: boolean
  readonly unfilledBotSeats: number
  readonly balanced: boolean
  /** Empty when the roster is startable. In the declared order of `START_BLOCK_REASONS`. */
  readonly blockers: readonly StartBlockReason[]
}

/**
 * Everything both start paths need to know about a roster, in one read.
 *
 * Also what the lobby renders: "3/4 ready", "waiting for one more". Returning a
 * snapshot rather than a boolean is what lets the UI explain the wait instead of
 * greying a button out for reasons the player cannot see.
 */
export function seatingSnapshot(room: Room, policy: SeatingPolicy): SeatingSnapshot {
  const occupied = occupiedSeats(room)
  const seated = occupied.length
  const ready = occupied.filter((seat) => seat.isReady).length
  const unfilledBotSeats = room.seats.filter(
    (seat) => seat.reservedFor === 'bot' && seat.occupantPlayerId === null,
  ).length

  // A bot seat counts towards "full" — the room has no free seats for a person
  // — but it does not count towards the headcount, which is what
  // `below_min_players` and `bot_seat_unfilled` then report separately.
  const full = room.seats.every(
    (seat) => seat.occupantPlayerId !== null || seat.reservedFor !== null,
  )
  const minMet = seated >= policy.minPlayers
  const balanced = isBalanced(room.seats, policy)

  const blockers: StartBlockReason[] = []
  // `finished` is excluded on purpose: a finished room restarts through
  // `applyRematch`, which re-crews it and hands back a lobby. Letting `start`
  // act on a finished room would begin a second match without ever clearing the
  // first one's result or rotating anybody.
  if (room.status !== 'lobby') blockers.push('not_in_lobby')
  if (!minMet) blockers.push('below_min_players')
  if (policy.startMode === 'auto_when_full' && !full) blockers.push('not_full')
  if (ready < seated) blockers.push('awaiting_ready')
  if (unfilledBotSeats > 0) blockers.push('bot_seat_unfilled')
  if (!balanced) blockers.push('teams_unbalanced')

  return { seated, ready, full, minMet, unfilledBotSeats, balanced, blockers }
}

/** The blockers that remain for a given actor. Pass `force` for a host override. */
export function startBlockers(
  room: Room,
  policy: SeatingPolicy,
  force = false,
): readonly StartBlockReason[] {
  const { blockers } = seatingSnapshot(room, policy)
  return force ? blockers.filter((reason) => !HOST_OVERRIDABLE.includes(reason)) : blockers
}

export type AutoStartDecision =
  /** Arm the countdown; the match starts at `endsAt`. */
  | { readonly action: 'arm'; readonly endsAt: number }
  /** A countdown is armed but the roster no longer qualifies. Disarm it. */
  | { readonly action: 'cancel' }
  /** The countdown has run out. Start the match. */
  | { readonly action: 'start' }
  /** Nothing to do. */
  | { readonly action: 'none' }

/**
 * The countdown decision for an auto-start room.
 *
 * Call it after **every** roster change and on every sweep tick. Total in
 * `(room, now)`, so calling it twice for the same state is harmless and calling
 * it after a restart recovers the right answer with no extra state.
 *
 * Order matters in one place: an armed countdown that has expired starts the
 * match even if the roster has since stopped qualifying. That sounds wrong and
 * is not — reaching the deadline is the commitment, and re-checking afterwards
 * would let a player who un-readies in the same millisecond as the fire time
 * win a race against a match that has already been announced to everyone else.
 * The window to change your mind is the three seconds, and it closes.
 */
export function evaluateAutoStart(
  room: Room,
  policy: SeatingPolicy,
  now: number,
): AutoStartDecision {
  const armed = room.startCountdownEndsAt !== null

  if (armed && now >= (room.startCountdownEndsAt as number)) return { action: 'start' }

  if (policy.startMode !== 'auto_when_full') {
    // A room whose game somehow changed mode must not keep a stale countdown
    // armed, or it would start a host-driven game behind the host's back.
    return armed ? { action: 'cancel' } : { action: 'none' }
  }

  const qualifies = seatingSnapshot(room, policy).blockers.length === 0
  if (qualifies)
    return armed ? { action: 'none' } : { action: 'arm', endsAt: now + AUTO_START_COUNTDOWN_MS }
  return armed ? { action: 'cancel' } : { action: 'none' }
}

export type HostStartResolution =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly StartBlockReason[] }
  /** The actor is not the host. Separated so the caller can 403 rather than explain. */
  | { readonly ok: false; readonly reasons: readonly StartBlockReason[]; readonly notHost: true }

/**
 * Whether `actorPlayerId` may start the match now.
 *
 * Host-only even for an `auto_when_full` game, where pressing Start skips the
 * remainder of the countdown. That is a real affordance — two players who are
 * plainly ready should not have to watch three seconds elapse — and it is the
 * host's to use.
 */
export function resolveHostStart(
  room: Room,
  policy: SeatingPolicy,
  actorPlayerId: string,
  options: { readonly force?: boolean } = {},
): HostStartResolution {
  if (room.hostPlayerId !== actorPlayerId) {
    return { ok: false, reasons: [], notHost: true }
  }
  const reasons = startBlockers(room, policy, options.force ?? false)
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}
