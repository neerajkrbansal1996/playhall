/**
 * The seat service: the one place host and seat actions are sequenced.
 *
 * Everything it composes is pure and tested on its own — the team maths, the
 * host succession, the start rules, the rematch tally. What lives here is the
 * *order*, and the order is where the security properties are:
 *
 * 1. Every actor guard runs **inside** the compare-and-set loop, against state
 *    read in the same attempt. A host who lost the crown between the client's
 *    read and the server's write is not a host.
 * 2. Teams are re-derived after **every** seat change, so a room cannot be
 *    seated one way and teamed another.
 * 3. A seat change invalidates the start agreement. Nobody is held to a "ready"
 *    they gave for a different roster.
 * 4. Nothing here reads a game id. Rules arrive as a `SeatingPolicy` projected
 *    from the manifest, and a missing game is a refusal rather than a default.
 */

import type { GameRegistry } from '../registry/registry.js'
import { type RoomMutationFailure, type RoomWriter, createRoomWriter } from '../rooms/mutate.js'
import type { RoomStore } from '../rooms/store.js'
import type { Clock } from '../runtime.js'
import { type Room, type RoomRevision, type RoomSeatSlot, seatIndexOf } from '../rooms/types.js'
import { type BotSeatProvider, type BotSlotOutcome, resolveBotProvider } from './bots.js'
import { type HostActionRejection, canCloseLobby, canKick, canTransferHost } from './host.js'
import { type SeatingPolicy, seatingPolicyFor } from './policy.js'
import {
  type RematchRejection,
  rematchRevision,
  resolveRematch,
  sameSeatsRematchRevision,
  withRematchVote,
  withoutRematchVote,
} from './rematch.js'
import {
  assignSeat,
  clearReady,
  reserveSeatForBot,
  seatAt,
  setPlayerReady,
  swapSeats,
  vacatePlayer,
} from './seating.js'
import {
  type StartBlockReason,
  evaluateAutoStart,
  resolveHostStart,
  startBlockers,
} from './start.js'
import { assignTeams, moveToTeam } from './teams.js'
import { type RoomView, roomViewFor } from './view.js'

export type SeatRefusal =
  | { readonly code: 'refused'; readonly reason: HostActionRejection }
  /**
   * The room's game is not in the registry, so there is no policy to judge the
   * request against. A refusal rather than a default: guessing seat rules for a
   * game core cannot resolve is how a two-player game gets started with five.
   */
  | { readonly code: 'game_unavailable' }
  | { readonly code: 'not_startable'; readonly reasons: readonly StartBlockReason[] }
  | { readonly code: 'rematch_refused'; readonly reason: RematchRejection }
  | { readonly code: 'bot_unavailable'; readonly reason: 'bots_not_supported' | 'no_provider' }
  /**
   * The room is already in the state the call would have produced, so nothing
   * was written.
   *
   * A distinct outcome rather than a successful no-op write, because
   * `reviseRoom` bumps the version on every write and a version bump is a delta
   * every client in the room has to fetch. `tickAutoStart` runs on every sweep
   * tick against every live room; if a quiet room cost a version each time, the
   * sweep would generate more traffic than the players do.
   */
  | { readonly code: 'no_change' }

/**
 * What a successful write actually did.
 *
 * Present because "the write succeeded" is not always the answer: recording a
 * rematch vote and starting the rematch are both successful writes to the same
 * room, and a caller forced to compare statuses to tell them apart would be
 * re-deriving a decision the service already made.
 */
export type SeatMutationOutcome =
  | 'applied'
  | 'rematch_vote_recorded'
  | 'rematch_started'
  | 'countdown_armed'
  | 'countdown_cancelled'
  | 'match_started'

export type SeatMutationResult =
  | {
      readonly ok: true
      readonly room: Room
      readonly outcome?: SeatMutationOutcome
    }
  | { readonly ok: false; readonly error: RoomMutationFailure }
  | { readonly ok: false; readonly refused: SeatRefusal }

export interface SeatServiceOptions {
  readonly store: RoomStore
  readonly registry: GameRegistry
  readonly clock: Clock
  /** v1 registers none. Injectable so a provider can be tested without a global. */
  readonly botProviders?: readonly BotSeatProvider[]
  /** Shared with the room service in production, so both write through one loop. */
  readonly writer?: RoomWriter
}

export interface SeatService {
  /** A player marks themselves ready, or un-readies to hold an armed countdown. */
  setReady(roomId: string, playerId: string, isReady: boolean): Promise<SeatMutationResult>
  /**
   * A seated player moves to `seatIndex`, swapping with whoever is there.
   * Self-service: choosing your own seat is not a host privilege.
   */
  moveSeat(roomId: string, playerId: string, seatIndex: number): Promise<SeatMutationResult>
  /** The host seats a member at a specific index. */
  assignSeat(
    roomId: string,
    actorPlayerId: string,
    targetPlayerId: string,
    seatIndex: number,
  ): Promise<SeatMutationResult>
  /** A player picks a team. Only for `auto-balanced` games; re-balances after. */
  chooseTeam(roomId: string, playerId: string, teamId: string): Promise<SeatMutationResult>
  transferHost(
    roomId: string,
    actorPlayerId: string,
    targetPlayerId: string,
  ): Promise<SeatMutationResult>
  kick(roomId: string, actorPlayerId: string, targetPlayerId: string): Promise<SeatMutationResult>
  closeLobby(roomId: string, actorPlayerId: string): Promise<SeatMutationResult>
  /** The host presses Start. `force` overrides an outstanding ready check. */
  start(
    roomId: string,
    actorPlayerId: string,
    options?: { readonly force?: boolean },
  ): Promise<SeatMutationResult>
  /**
   * Arms, cancels or fires the auto-start countdown. Idempotent and total in
   * `(room, now)`, so it is safe on every sweep tick and after a restart.
   */
  tickAutoStart(roomId: string): Promise<SeatMutationResult>
  /** A seated player asks for a rematch. Starts it once everyone present agrees. */
  voteRematch(
    roomId: string,
    playerId: string,
    options?: { readonly force?: boolean; readonly sameSeats?: boolean },
  ): Promise<SeatMutationResult>
  withdrawRematchVote(roomId: string, playerId: string): Promise<SeatMutationResult>
  /** The host holds a seat open for a bot, or releases it. */
  reserveBotSeat(
    roomId: string,
    actorPlayerId: string,
    seatIndex: number,
    reserved: boolean,
  ): Promise<SeatMutationResult>
  /** The redacted room envelope for one viewer. Null when the room is gone. */
  view(roomId: string, viewerPlayerId: string | null): Promise<RoomView | null>
  /** The policy a room is judged under. Null when the registry cannot resolve its game. */
  policyFor(room: Room): SeatingPolicy | null
}

export function createSeatService(options: SeatServiceOptions): SeatService {
  const { store, registry, clock } = options
  const writer = options.writer ?? createRoomWriter({ store, clock })
  const botProviders = options.botProviders

  function policyFor(room: Room): SeatingPolicy | null {
    const entry = registry.entryById(room.gameId)
    return entry === null ? null : seatingPolicyFor(entry)
  }

  /** Wraps a guarded write whose decision needs the room's policy. */
  async function withPolicy(
    roomId: string,
    change: (
      room: Room,
      policy: SeatingPolicy,
      now: number,
    ) =>
      | { readonly revision: RoomRevision; readonly outcome?: SeatMutationOutcome }
      | { readonly refused: SeatRefusal },
  ): Promise<SeatMutationResult> {
    return writer.guarded<SeatRefusal, SeatMutationOutcome>(roomId, (room, now) => {
      const policy = policyFor(room)
      if (policy === null) return { refused: { code: 'game_unavailable' } }
      return change(room, policy, now)
    })
  }

  const refuse = (reason: HostActionRejection) =>
    ({ refused: { code: 'refused' as const, reason } }) as const

  /**
   * The revision for a roster that has just changed shape.
   *
   * Re-derives teams and drops the start agreement in one place, so no seat
   * mutation can forget either half. A caller that changed seats and skipped
   * this would leave an auto-balanced room lopsided, or a countdown armed
   * against a roster that no longer exists.
   */
  function rosterChanged(policy: SeatingPolicy, seats: readonly RoomSeatSlot[]): RoomRevision {
    return {
      seats: clearReady(assignTeams(seats, policy)),
      startCountdownEndsAt: null,
    }
  }

  async function setReady(
    roomId: string,
    playerId: string,
    isReady: boolean,
  ): Promise<SeatMutationResult> {
    // Still routed through `withPolicy` rather than the raw writer: a room whose
    // game the registry cannot resolve has no seating rules, and answering a
    // readiness call for it would be the one place that quietly worked.
    return withPolicy(roomId, (room) => {
      if (seatIndexOf(room, playerId) === null) return refuse('not_a_member')
      const seats = setPlayerReady(room.seats, playerId, isReady)
      // Un-readying disarms an armed countdown; that is the entire point of the
      // flag. Re-readying does *not* re-arm here — `tickAutoStart` owns arming,
      // so the 3-second rule lives in exactly one place.
      return {
        revision: {
          seats,
          startCountdownEndsAt: isReady ? room.startCountdownEndsAt : null,
        },
      }
    })
  }

  async function moveSeat(
    roomId: string,
    playerId: string,
    seatIndex: number,
  ): Promise<SeatMutationResult> {
    return withPolicy(roomId, (room, policy) => {
      if (room.status === 'in_progress') return refuse('match_in_progress')
      if (room.status === 'closed') return refuse('room_not_open')
      const from = seatIndexOf(room, playerId)
      if (from === null) return refuse('not_a_member')
      const target = seatAt(room.seats, seatIndex)
      if (target === undefined) return refuse('no_such_seat')
      // A bot-reserved seat is not available to a player; the host set it aside.
      if (target.reservedFor !== null) return refuse('seat_occupied')
      return {
        revision: rosterChanged(policy, swapSeats(room.seats, from, seatIndex)),
        outcome: 'applied',
      }
    })
  }

  async function assignSeatTo(
    roomId: string,
    actorPlayerId: string,
    targetPlayerId: string,
    seatIndex: number,
  ): Promise<SeatMutationResult> {
    return withPolicy(roomId, (room, policy) => {
      if (room.hostPlayerId !== actorPlayerId) return refuse('not_host')
      if (room.status === 'in_progress') return refuse('match_in_progress')
      if (room.status === 'closed') return refuse('room_not_open')
      const seated = seatIndexOf(room, targetPlayerId) !== null
      if (!seated && !room.spectatorPlayerIds.includes(targetPlayerId)) {
        return refuse('not_a_member')
      }
      const target = seatAt(room.seats, seatIndex)
      if (target === undefined) return refuse('no_such_seat')
      if (target.occupantPlayerId !== null && target.occupantPlayerId !== targetPlayerId) {
        return refuse('seat_occupied')
      }
      if (target.reservedFor !== null) return refuse('seat_occupied')

      const seats = assignSeat(room.seats, seatIndex, targetPlayerId)
      return {
        revision: {
          ...rosterChanged(policy, seats),
          // Seating a spectator promotes them out of the spectator list, or the
          // same person would be counted twice — once in a seat and once in the
          // spectator count every player is shown.
          spectatorPlayerIds: room.spectatorPlayerIds.filter((id) => id !== targetPlayerId),
          secondPlayerJoinedAt:
            room.secondPlayerJoinedAt ??
            (targetPlayerId === room.hostPlayerId ? null : clock.now()),
        },
      }
    })
  }

  async function chooseTeam(
    roomId: string,
    playerId: string,
    teamId: string,
  ): Promise<SeatMutationResult> {
    return withPolicy(roomId, (room, policy) => {
      if (policy.teams === 'none') return refuse('teams_not_enabled')
      if (room.status === 'in_progress') return refuse('match_in_progress')
      const seatIndex = seatIndexOf(room, playerId)
      if (seatIndex === null) return refuse('not_a_member')
      const seats = moveToTeam(room.seats, policy, seatIndex, teamId)
      // Null covers both "fixed teams, nothing to move" and "no such team". The
      // first is the more useful message, so it is checked first.
      if (seats === null) {
        return policy.teams === 'fixed' ? refuse('teams_not_enabled') : refuse('no_such_team')
      }
      // A team change is not a seat change: nobody's turn order moved, so the
      // ready flags stand. Teams are already balanced by `moveToTeam`.
      return { revision: { seats } }
    })
  }

  async function transferHost(
    roomId: string,
    actorPlayerId: string,
    targetPlayerId: string,
  ): Promise<SeatMutationResult> {
    return withPolicy(roomId, (room) => {
      const rejection = canTransferHost(room, actorPlayerId, targetPlayerId)
      return rejection === null ? { revision: { hostPlayerId: targetPlayerId } } : refuse(rejection)
    })
  }

  async function kick(
    roomId: string,
    actorPlayerId: string,
    targetPlayerId: string,
  ): Promise<SeatMutationResult> {
    return withPolicy(roomId, (room, policy) => {
      const rejection = canKick(room, actorPlayerId, targetPlayerId)
      if (rejection !== null) return refuse(rejection)

      const seats = vacatePlayer(room.seats, targetPlayerId)
      return {
        revision: {
          ...rosterChanged(policy, seats),
          spectatorPlayerIds: room.spectatorPlayerIds.filter((id) => id !== targetPlayerId),
          // A kicked player is gone from presence too, or the room would still
          // be counted as occupied by someone who cannot come back and the
          // empty timer would never arm.
          presentPlayerIds: room.presentPlayerIds.filter((id) => id !== targetPlayerId),
          // Their vote leaves with them. Otherwise a kick could *complete* a
          // rematch vote using the ballot of somebody who has been removed.
          rematchVotes: room.rematchVotes.filter((id) => id !== targetPlayerId),
        },
      }
    })
  }

  async function closeLobby(roomId: string, actorPlayerId: string): Promise<SeatMutationResult> {
    return withPolicy(roomId, (room, _policy, now) => {
      const rejection = canCloseLobby(room, actorPlayerId)
      if (rejection !== null) return refuse(rejection)
      return {
        revision: {
          status: 'closed',
          closedAt: now,
          closeReason: 'host_closed',
          presentPlayerIds: [],
          startCountdownEndsAt: null,
        },
      }
    })
  }

  async function start(
    roomId: string,
    actorPlayerId: string,
    startOptions: { readonly force?: boolean } = {},
  ): Promise<SeatMutationResult> {
    return withPolicy(roomId, (room, policy) => {
      const resolution = resolveHostStart(room, policy, actorPlayerId, startOptions)
      if (!resolution.ok) {
        if ('notHost' in resolution) return refuse('not_host')
        return { refused: { code: 'not_startable', reasons: resolution.reasons } }
      }
      return {
        revision: { status: 'in_progress', startCountdownEndsAt: null },
        outcome: 'match_started',
      }
    })
  }

  async function tickAutoStart(roomId: string): Promise<SeatMutationResult> {
    return withPolicy(roomId, (room, policy, now) => {
      const decision = evaluateAutoStart(room, policy, now)
      switch (decision.action) {
        case 'arm':
          return {
            revision: { startCountdownEndsAt: decision.endsAt },
            outcome: 'countdown_armed',
          }
        case 'cancel':
          return { revision: { startCountdownEndsAt: null }, outcome: 'countdown_cancelled' }
        case 'start': {
          // The countdown has fired. Re-checking the roster here would let a
          // player who un-readied in the same millisecond win a race against a
          // match every other client has already been told is starting — see
          // `evaluateAutoStart`. The one thing still worth refusing is a roster
          // the *game* cannot run, which `startBlockers` reports minus the
          // readiness it no longer gets a say in.
          const fatal = startBlockers(room, policy, true)
          if (fatal.length > 0) {
            return { revision: { startCountdownEndsAt: null }, outcome: 'countdown_cancelled' }
          }
          return {
            revision: { status: 'in_progress', startCountdownEndsAt: null },
            outcome: 'match_started',
          }
        }
        case 'none':
          // No write at all, rather than a no-op revision — see `no_change`.
          return { refused: { code: 'no_change' } }
      }
    })
  }

  async function voteRematch(
    roomId: string,
    playerId: string,
    rematchOptions: { readonly force?: boolean; readonly sameSeats?: boolean } = {},
  ): Promise<SeatMutationResult> {
    return withPolicy(roomId, (room, policy, now) => {
      if (room.status !== 'finished') {
        return { refused: { code: 'rematch_refused', reason: 'match_not_finished' } }
      }
      if (seatIndexOf(room, playerId) === null) {
        return { refused: { code: 'rematch_refused', reason: 'not_seated' } }
      }

      // Record the vote first, then resolve against the room including it. The
      // other order needs the tally to special-case the caller, which is the
      // kind of off-by-one that shows up as "the last player's click does
      // nothing".
      const withVote: Room = { ...room, ...withRematchVote(room, playerId) }
      const resolution = resolveRematch(withVote, policy, playerId, rematchOptions)

      if (!resolution.ok) {
        if (resolution.code === 'awaiting_votes') {
          // The vote still persists — it is the whole point of the call — and
          // the refusal reports the tally so the client can render "1/3".
          // The vote persists — it is the whole point of the call — and the
          // outcome says so, while the tally travels on the returned room for
          // the client to render "1/3".
          return {
            revision: withRematchVote(room, playerId),
            outcome: 'rematch_vote_recorded',
          }
        }
        return { refused: { code: 'rematch_refused', reason: resolution.code } }
      }

      const revision =
        rematchOptions.sameSeats === true
          ? sameSeatsRematchRevision(withVote, policy, now)
          : rematchRevision(withVote, policy, now)
      return { revision, outcome: 'rematch_started' }
    })
  }

  async function withdrawRematchVote(
    roomId: string,
    playerId: string,
  ): Promise<SeatMutationResult> {
    return withPolicy(roomId, (room) => ({ revision: withoutRematchVote(room, playerId) }))
  }

  async function reserveBotSeat(
    roomId: string,
    actorPlayerId: string,
    seatIndex: number,
    reserved: boolean,
  ): Promise<SeatMutationResult> {
    return withPolicy(roomId, (room, policy) => {
      if (room.hostPlayerId !== actorPlayerId) return refuse('not_host')
      if (room.status !== 'lobby') return refuse('match_in_progress')
      const seat = seatAt(room.seats, seatIndex)
      if (seat === undefined) return refuse('no_such_seat')
      if (reserved && seat.occupantPlayerId !== null) return refuse('seat_occupied')

      if (reserved) {
        const outcome: BotSlotOutcome = resolveBotProvider(room, policy, botProviders)
        // v1 always lands here. Refusing at reservation time rather than at
        // start time is the honest answer: the host learns immediately that
        // there is no bot to sit there, instead of discovering it when the
        // match will not begin.
        if (!outcome.ok) return { refused: { code: 'bot_unavailable', reason: outcome.code } }
      }

      return {
        revision: rosterChanged(policy, reserveSeatForBot(room.seats, seatIndex, reserved)),
      }
    })
  }

  async function view(roomId: string, viewerPlayerId: string | null): Promise<RoomView | null> {
    const room = await writer.read(roomId)
    if (room === null) return null
    const policy = policyFor(room)
    if (policy === null) return null
    return roomViewFor(room, policy, viewerPlayerId)
  }

  return {
    setReady,
    moveSeat,
    assignSeat: assignSeatTo,
    chooseTeam,
    transferHost,
    kick,
    closeLobby,
    start,
    tickAutoStart,
    voteRematch,
    withdrawRematchVote,
    reserveBotSeat,
    view,
    policyFor,
  }
}
