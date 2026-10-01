/**
 * Rematch: turning a finished room back into a lobby with the same people in it.
 *
 * This is why a room outlives a match. The room keeps the code, the link, the
 * chat and the roster; the match is the thing that ended. "New game, same
 * people" is therefore not a special feature — it is a rematch whose rotation
 * is `none`.
 *
 * What a rematch is *not*: a new room. The code does not change, so the link in
 * the group chat still works, and nobody has to re-share anything.
 *
 * Pure. `seats/service.ts` owns the writes and the vote bookkeeping.
 */

import { type Room, type RoomRevision, occupiedSeats, seatIndexOf } from '../rooms/types.js'
import type { SeatingPolicy } from './policy.js'
import { readyAll } from './seating.js'
import { assignTeams, rotateOccupants } from './teams.js'

export const REMATCH_REJECTIONS = [
  /** The room has not finished. There is nothing to rematch. */
  'match_not_finished',
  /** The voter holds no seat. Spectators watch a rematch, they do not call one. */
  'not_seated',
  /** Fewer than `minPlayers` players remain seated. */
  'below_min_players',
  /** Only the host may force a rematch past a missing vote. */
  'not_host',
] as const
export type RematchRejection = (typeof REMATCH_REJECTIONS)[number]

export interface RematchTally {
  /** Seated players who are still connected — the electorate. */
  readonly eligible: readonly string[]
  /** Of those, the ones who have voted. */
  readonly voted: readonly string[]
  readonly unanimous: boolean
}

/**
 * Who gets a say, and whether they have all said yes.
 *
 * The electorate is seated **and present**. Counting an absent player would
 * hand a veto to somebody whose phone died: three friends waiting on a fourth
 * who has gone home would sit in a finished room until the 15-minute window
 * closed. They leave the electorate by being absent, and if they reconnect
 * before the rematch starts they are simply in the next game.
 *
 * A room with nobody present is not unanimous, however empty the vote list is:
 * `unanimous` on an empty electorate would start a match with no players in it.
 */
export function tallyRematch(room: Room): RematchTally {
  const eligible = occupiedSeats(room)
    .map((seat) => seat.occupantPlayerId as string)
    .filter((playerId) => room.presentPlayerIds.includes(playerId))
  const voted = eligible.filter((playerId) => room.rematchVotes.includes(playerId))
  return { eligible, voted, unanimous: eligible.length > 0 && voted.length === eligible.length }
}

export type RematchResolution =
  /** Start the rematch now. */
  | { readonly ok: true; readonly tally: RematchTally }
  /** The vote is recorded but the room is still waiting on someone. */
  | { readonly ok: false; readonly code: 'awaiting_votes'; readonly tally: RematchTally }
  | { readonly ok: false; readonly code: RematchRejection }

/**
 * Whether `actorPlayerId`'s vote (or the host's override) triggers the rematch.
 *
 * Call it with the room *after* the vote has been recorded, so the tally
 * includes the caller. `awaiting_votes` is a success from the caller's point of
 * view — the vote landed — and is distinguished from a rejection because the
 * client should show "1/3 want a rematch", not an error.
 */
export function resolveRematch(
  room: Room,
  policy: SeatingPolicy,
  actorPlayerId: string,
  options: { readonly force?: boolean } = {},
): RematchResolution {
  if (room.status !== 'finished') return { ok: false, code: 'match_not_finished' }
  if (seatIndexOf(room, actorPlayerId) === null) return { ok: false, code: 'not_seated' }

  const tally = tallyRematch(room)
  if (tally.eligible.length < policy.minPlayers) return { ok: false, code: 'below_min_players' }

  if (options.force === true) {
    if (room.hostPlayerId !== actorPlayerId) return { ok: false, code: 'not_host' }
    return { ok: true, tally }
  }

  return tally.unanimous ? { ok: true, tally } : { ok: false, code: 'awaiting_votes', tally }
}

/**
 * The revision that turns a finished room back into a fresh lobby.
 *
 * What changes, and why each one has to:
 *
 * - **Rotation.** The offset is a constant one seat, because it is applied to
 *   the seats as they are *now* — already carrying every previous rematch's
 *   shift. Each match therefore advances the arrangement by exactly one, which
 *   is what cycles a room through every seating in turn: two players alternate
 *   who goes first, and three players see all three orders before repeating.
 *   Passing `matchesPlayed` here would compound instead of advance, shifting by
 *   1, then 3, then 6 seats cumulatively, so a three-player room would land
 *   back on its original seating twice in a row.
 * - **Absent players lose their seats.** They are not in the electorate, so
 *   keeping their seats would leave a room that voted unanimously for a rematch
 *   unable to reach `minPlayers`, or starting a match with a seat nobody is
 *   behind. Their seat becomes free and the link still works, so a reconnect
 *   inside the window takes a seat again.
 * - **Ready flags are set, not cleared.** Everyone in the room has just voted
 *   for this match; asking them to confirm twice is the tap the countdown
 *   exists to avoid. A fixed-size room that is still full therefore re-arms its
 *   countdown immediately, which is the behaviour a rematch button implies.
 * - **`finishedAt` is cleared and `status` returns to `lobby`.** That moves the
 *   room out of the 15-minute rematch window and back under the no-opponent and
 *   empty timers, which is correct: it is a live lobby again.
 * - **`currentMatchId` is cleared.** The match record it names lives in
 *   Postgres and outlives every room; the *room* must stop claiming a match is
 *   in it, or a reconnecting client would be handed the finished one.
 *
 * `version` and `updatedAt` are not set here — `reviseRoom` owns those.
 */
export function rematchRevision(room: Room, policy: SeatingPolicy, now: number): RoomRevision {
  const present = new Set(room.presentPlayerIds)

  const crewed = room.seats.map((seat) =>
    seat.occupantPlayerId !== null && !present.has(seat.occupantPlayerId)
      ? { ...seat, occupantPlayerId: null, isReady: false }
      : seat,
  )

  const rotated = policy.rematchRotation === 'seats' ? rotateOccupants(crewed, 1) : crewed

  // Teams are re-derived either way, because seats may have emptied. `teams`
  // rotation additionally drops the current draw so `assignTeams` re-forms the
  // sides from scratch instead of preserving them for stability.
  const unteamed =
    policy.rematchRotation === 'teams'
      ? rotated.map((seat) => (seat.teamId === null ? seat : { ...seat, teamId: null }))
      : rotated

  const seats = readyAll(assignTeams(unteamed, policy))

  return {
    status: 'lobby',
    seats,
    finishedAt: null,
    currentMatchId: null,
    rematchVotes: [],
    matchesPlayed: room.matchesPlayed + 1,
    // A fresh lobby has no countdown; `evaluateAutoStart` arms one on the next
    // tick if the room qualifies. Arming it here would duplicate that rule in a
    // second place and let the two disagree.
    startCountdownEndsAt: null,
    // The room is demonstrably not abandoned — a match was just played in it —
    // so the no-opponent timer must not find a null here and expire a lobby
    // full of people who are mid-conversation about their next game.
    secondPlayerJoinedAt: room.secondPlayerJoinedAt ?? now,
    emptySince: null,
  }
}

/**
 * Records a rematch vote. Idempotent: voting twice is one vote.
 *
 * A vote is *also* an un-ready reset guard — it is stored on the room rather
 * than as a seat flag because a rematch may rotate seats, and a flag attached
 * to seat 2 would be inherited by whoever rotates into it.
 */
export function withRematchVote(room: Room, playerId: string): RoomRevision {
  if (room.rematchVotes.includes(playerId)) return {}
  return { rematchVotes: [...room.rematchVotes, playerId] }
}

/** Withdraws a rematch vote. */
export function withoutRematchVote(room: Room, playerId: string): RoomRevision {
  if (!room.rematchVotes.includes(playerId)) return {}
  return { rematchVotes: room.rematchVotes.filter((id) => id !== playerId) }
}

/**
 * The revision for "new game, same people" — a rematch with no rotation, whoever
 * the policy would otherwise have shuffled.
 *
 * A separate entry point because it is a separate product promise: the button
 * says the seats stay as they are, and honouring that must not depend on what
 * the game declared.
 */
export function sameSeatsRematchRevision(
  room: Room,
  policy: SeatingPolicy,
  now: number,
): RoomRevision {
  return rematchRevision(room, { ...policy, rematchRotation: 'none' }, now)
}
