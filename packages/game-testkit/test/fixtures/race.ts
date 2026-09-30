/**
 * `race` — a mutant-able fixture game for `result-standings-well-formed`.
 *
 * Deliberately the most boring game that can exist: seats take turns scoring
 * a point, first to `target` wins, and a lobby-level `abort` ends the match
 * without recording anything. It is boring on purpose — the thing under test
 * is the conformance check, so the game must contribute nothing but a
 * `MatchResult` we control exactly.
 *
 * `makeRace(breakage)` returns the same game with one contract violation
 * spliced in. A gate that has never been shown failing is not a gate, so
 * every `MatchResultProblem` code has a mutant here that produces it.
 *
 * Note that `abort` is deliberately **not** in `getLegalActions`: it is a
 * lobby action, so random playouts cannot reach it. That is the whole reason
 * `abortScenarios` exists, and this fixture would not test the abort path if
 * the fuzzer could stumble into it by itself.
 */

import {
  DEFAULT_DISCONNECT_POLICY,
  VALID,
  asSeatId,
  invalid,
  type GameContext,
  type GameEvent,
  type GameManifest,
  type MatchResult,
  type ResultReason,
  type SeatId,
  type SeatRoster,
  type Standing,
  type TurnBasedGameServer,
} from '@playhall/game-sdk'
import { z } from 'zod'
import type { TurnBasedConformanceSubject } from '../../src/subject.js'

export const settingsSchema = z.object({
  /** Points needed to win. */
  target: z.number().int().min(1).max(10),
})

export type RaceSettings = z.infer<typeof settingsSchema>

export interface RaceState {
  readonly seatIds: readonly SeatId[]
  /** Parallel to `seatIds`. */
  readonly scores: readonly number[]
  readonly turn: number
  readonly target: number
  readonly aborted: boolean
}

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('score') }),
  z.object({ type: z.literal('abort') }),
])

export type RaceAction = z.infer<typeof actionSchema>

export interface RaceView {
  readonly scores: readonly number[]
  readonly turn: number
  readonly target: number
}

/** One contract violation to splice in. Every field maps to a problem code. */
export interface RaceBreakage {
  /** `standings_arity`: an unrecorded reason that carries standings anyway. */
  readonly abortHasStandings?: boolean
  /** `standings_arity` + `missing_seat`: a completed result short one seat. */
  readonly dropLastSeat?: boolean
  /** `duplicate_seat`: the last standing repeats the first seat. */
  readonly duplicateSeat?: boolean
  /** `unknown_seat`: a standing for a seat that is not in the match. */
  readonly unknownSeat?: boolean
  /** `bad_rank`: a rank of 0. */
  readonly zeroRank?: boolean
  /** `rank_not_competition_ordered`: 1, 1, 2 instead of 1, 1, 3. Needs 3 seats. */
  readonly tieThenTwo?: boolean
  /** The abort reports a *recorded* reason, contradicting its own claim. */
  readonly abortReason?: ResultReason
  /** Declare an abort scenario the game cannot actually reach. */
  readonly abortUnreachable?: boolean
  /** Declare no abort scenarios at all. */
  readonly omitAbortScenarios?: boolean
  /** The abort action is a no-op, so `getResult` stays null. */
  readonly abortDoesNothing?: boolean
  /** The game throws while the abort is applied. */
  readonly abortThrows?: boolean
  /** The game's own `validateAction` rejects the abort it declared a scenario for. */
  readonly abortNotAllowed?: boolean
  /** `validateAction` throws on the abort instead of returning a rejection. */
  readonly abortValidateThrows?: boolean
  /** The game throws on the second move, so `prepare` records a crashed run. */
  readonly crashOnMove?: boolean
  /** Override the abort scenario's `afterSteps`; `'omit'` leaves it unset. */
  readonly abortAfterSteps?: number | 'omit'
  /**
   * Drop `getLegalActions`, which is optional on `TurnBasedGameServer`. The
   * abort driver then has no moves to play, so `afterSteps` cannot be reached.
   */
  readonly omitGetLegalActions?: boolean
  /** A `chooseAction` that declines every move, the other way to reach no moves. */
  readonly declineMoves?: boolean
  /**
   * `RESULT_REASONS` membership: a JavaScript game returns a reason that is not
   * in the enum at all. Unreachable through the types, which is the point.
   */
  readonly bogusReason?: string
}

const GHOST = asSeatId('seat-from-another-match')

function rank(state: RaceState, breakage: RaceBreakage): Standing[] {
  const winner = state.scores.findIndex((score) => score >= state.target)
  const standings = state.seatIds.map((seatId, index): Standing => ({
    seatId,
    rank: index === winner ? 1 : 2,
    outcome: index === winner ? 'win' : 'loss',
    score: state.scores[index] ?? 0,
  }))

  if (breakage.tieThenTwo) {
    // Everyone ties for first except the last seat, which claims rank 2. With
    // three seats that is 1, 1, 2 — the rank the third seat may not have.
    return standings.map((standing, index) => ({
      ...standing,
      rank: index === standings.length - 1 ? 2 : 1,
      outcome: index === standings.length - 1 ? ('loss' as const) : ('draw' as const),
    }))
  }

  const last = standings.length - 1
  if (breakage.zeroRank) standings[last] = { ...(standings[last] as Standing), rank: 0 }
  if (breakage.unknownSeat) standings[last] = { ...(standings[last] as Standing), seatId: GHOST }
  if (breakage.duplicateSeat) {
    const first = standings[0] as Standing
    standings[last] = { ...(standings[last] as Standing), seatId: first.seatId }
  }
  if (breakage.dropLastSeat) standings.pop()
  return standings
}

export function makeRace(
  breakage: RaceBreakage = {},
): TurnBasedConformanceSubject<RaceState, RaceAction, RaceView, RaceSettings, GameEvent, string> {
  const manifest: GameManifest<RaceSettings> = {
    id: 'race',
    slug: 'race',
    name: 'Race',
    shortDescription: 'Take turns scoring a point. First to the target wins.',
    thumbnail: 'assets/thumbnail.png',
    category: 'board',
    minPlayers: 2,
    maxPlayers: 3,
    teams: 'none',
    turnModel: 'sequential',
    hasHiddenInformation: false,
    usesRandomness: false,
    supportsSpectators: true,
    supportsBots: false,
    settingsSchema,
    defaultSettings: { target: 3 },
    presets: [{ id: 'standard', label: 'Standard', settings: { target: 3 }, isDefault: true }],
    /** ADR-0007: mandatory, and one control per setting — the fixture has one. */
    settingsForm: {
      version: 1,
      fields: [
        {
          kind: 'number',
          key: 'target',
          label: 'Points to win',
          min: 1,
          max: 10,
          step: 1,
        },
      ],
    },
    timers: [],
    status: 'beta',
    version: '1.0.0',
    sdkContractVersion: 1,
  }

  const server: TurnBasedGameServer<
    RaceState,
    RaceAction,
    RaceView,
    RaceSettings,
    GameEvent,
    string
  > = {
    actionSchema,
    disconnectPolicy: DEFAULT_DISCONNECT_POLICY,

    createInitialState(_ctx: GameContext, settings: RaceSettings, seats: SeatRoster) {
      return {
        state: {
          seatIds: seats.map((seat) => seat.seatId),
          scores: seats.map(() => 0),
          turn: 0,
          target: settings.target,
          aborted: false,
        },
        events: [],
      }
    },

    validateAction(_ctx, state, seatId, action) {
      if (!state.seatIds.includes(seatId)) return invalid('not_seated')
      if (server.getResult(state) !== null) return invalid('match_over')
      if (action.type === 'abort') {
        if (breakage.abortValidateThrows === true) {
          throw new Error('race: validateAction blew up on the abort')
        }
        return breakage.abortNotAllowed === true ? invalid('not_allowed') : VALID
      }
      if (state.seatIds[state.turn] !== seatId) return invalid('not_your_turn')
      return VALID
    },

    applyAction(_ctx, state, seatId, action) {
      if (action.type === 'abort') {
        if (breakage.abortThrows === true) throw new Error('race: abort blew up')
        if (breakage.abortDoesNothing === true) return { state, events: [] }
        return { state: { ...state, aborted: true }, events: [] }
      }
      if (breakage.crashOnMove === true && state.scores.some((score) => score > 0)) {
        throw new Error('race: applyAction blew up on the second move')
      }
      const index = state.seatIds.indexOf(seatId)
      return {
        state: {
          ...state,
          scores: state.scores.map((score, at) => (at === index ? score + 1 : score)),
          turn: (state.turn + 1) % state.seatIds.length,
        },
        events: [],
      }
    },

    getViewFor(state) {
      return { scores: state.scores, turn: state.turn, target: state.target }
    },

    ...(breakage.omitGetLegalActions === true
      ? {}
      : {
          getLegalActions(state: RaceState, seatId: SeatId): readonly RaceAction[] {
            if (server.getResult(state) !== null) return []
            return state.seatIds[state.turn] === seatId ? [{ type: 'score' }] : []
          },
        }),

    getResult(state): MatchResult | null {
      if (state.aborted) {
        return {
          reason: breakage.abortReason ?? 'aborted',
          standings: breakage.abortHasStandings ? rank(state, breakage) : [],
        }
      }
      if (!state.scores.some((score) => score >= state.target)) return null
      return {
        // `as` because the whole point of this mutant is a value the type bans.
        reason: (breakage.bogusReason ?? 'completed') as ResultReason,
        standings: rank(state, breakage),
      }
    },
  }

  return {
    manifest,
    server,
    ...(breakage.declineMoves === true ? { chooseAction: () => null } : {}),
    ...(breakage.omitAbortScenarios === true
      ? {}
      : {
          abortScenarios: [
            {
              label: 'lobby aborts after one move',
              ...(breakage.abortAfterSteps === 'omit'
                ? {}
                : { afterSteps: breakage.abortAfterSteps ?? 1 }),
              abortAction: (_state: RaceState, roster: SeatRoster) => {
                if (breakage.abortUnreachable === true) return null
                const host = roster[0]
                return host === undefined
                  ? null
                  : { seatId: host.seatId, action: { type: 'abort' as const } }
              },
            },
          ],
        }),
  }
}
