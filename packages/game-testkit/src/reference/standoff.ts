/**
 * Standoff — the testkit's reference game for a *timer-driven* ending.
 *
 * Hidden Hand covers secrets; `race` (in `test/fixtures/`) covers an abort a
 * player performs. Neither can exercise ADR-0010, because in both of them the
 * unrecorded ending is reached by someone sending an action.
 *
 * Standoff is the smallest game whose **only** unrecorded ending is a first-move
 * timeout: two seats take turns firing, first to `target` hits wins, and if
 * nobody has fired by the `first-move` deadline the match is `aborted` and
 * records nothing. There is no resign, no lobby abort, no draw — so the empty
 * standings of ADR-0006 are reachable through exactly one path, and that path
 * is the platform calling `onTimer` because a deadline the game itself armed
 * has passed.
 *
 * This game was written **before** the harness that drives it, which is what
 * ADR-0010 asks for: the `TimerAbortScenario` surface is shaped by a consumer
 * rather than by the document. The declaration it produced is three lines and
 * lives in `standoff-subject.ts`:
 *
 * ```ts
 * abortScenarios: [
 *   { label: 'nobody fires', trigger: 'timer', timerId: asTimerId('first-move') },
 * ]
 * ```
 *
 * Two details are advice for real games:
 *
 *   - the timer is armed from `createInitialState`, not from the lobby. A
 *     deadline the game does not ask for is a deadline the conformance driver
 *     cannot see, and ADR-0010 §1 fails a scenario for a timer that was never
 *     armed rather than passing it.
 *   - the first action **clears** it. A game that leaves a stale `first-move`
 *     armed would have the platform fire it mid-match; the queue in the testkit
 *     honours `clear` precisely so that this is testable here rather than in
 *     production.
 */

import {
  DEFAULT_DISCONNECT_POLICY,
  PUBLIC,
  type GameContext,
  type GameEvent,
  type GameManifest,
  type MatchResult,
  type SeatId,
  type SeatRoster,
  type Standing,
  type TurnBasedGameServer,
  asTimerId,
  clearTimer,
  invalid,
  setTimer,
} from '@playhall/game-sdk'
import { z } from 'zod'

export const settingsSchema = z.object({
  /** Hits needed to win. */
  target: z.number().int().min(1).max(5),
  /** How long the seat to move has to fire the opening shot. */
  firstMoveSeconds: z.number().int().min(5).max(120),
})

export type StandoffSettings = z.infer<typeof settingsSchema>

export interface StandoffState {
  /** Seating order. Everything else keys off this. */
  readonly order: readonly SeatId[]
  /** Parallel to `order`. */
  readonly hits: readonly number[]
  /** Index into `order` of the seat to move. */
  readonly turn: number
  readonly target: number
  /** Shots fired so far, by anyone. Zero means the opening deadline still bites. */
  readonly shots: number
  /** Set by `onTimer` when the opening deadline passed with `shots === 0`. */
  readonly abandonedAtOpening: boolean
}

/**
 * `.strict()`, so an unrecognised field is rejected rather than stripped. The
 * suite's `illegal-action-rejected` check treats a silently-stripped extra key
 * as a malformed payload the game accepted, and it is right to: a client
 * sending `{type:'fire', target:'b2'}` against a schema that drops `target`
 * gets a shot it did not ask for.
 */
export const actionSchema = z.object({ type: z.literal('fire') }).strict()

export type StandoffAction = z.infer<typeof actionSchema>

export interface StandoffView {
  readonly hits: readonly number[]
  readonly toMove: SeatId | null
  readonly target: number
  readonly shots: number
}

export type StandoffEvent =
  | GameEvent<'shot_fired', { readonly seatId: SeatId; readonly hits: number }>
  | GameEvent<'nobody_fired', Record<string, never>>

/** The one timer this game arms. Declared in the manifest, as the SDK requires. */
export const FIRST_MOVE_TIMER = asTimerId('first-move')

export const manifest: GameManifest<StandoffSettings> = {
  id: 'standoff',
  slug: 'standoff',
  name: 'Standoff',
  shortDescription: 'Two seats trade shots. Nobody fires, nobody counts.',
  thumbnail: 'assets/thumbnail.png',
  category: 'board',
  minPlayers: 2,
  maxPlayers: 2,
  teams: 'none',
  turnModel: 'sequential',
  hasHiddenInformation: false,
  usesRandomness: false,
  supportsSpectators: true,
  supportsBots: false,
  settingsSchema,
  defaultSettings: { target: 2, firstMoveSeconds: 30 },
  presets: [
    {
      id: 'standard',
      label: 'Standard',
      settings: { target: 2, firstMoveSeconds: 30 },
      isDefault: true,
    },
    { id: 'blitz', label: 'Blitz', settings: { target: 1, firstMoveSeconds: 10 } },
  ],
  settingsForm: {
    version: 1,
    fields: [
      { kind: 'number', key: 'target', label: 'Hits to win', min: 1, max: 5, step: 1 },
      {
        kind: 'number',
        key: 'firstMoveSeconds',
        label: 'Seconds for the opening shot',
        unit: 's',
        min: 5,
        max: 120,
        step: 5,
      },
    ],
  },
  timers: [
    {
      id: 'first-move',
      kind: 'turn',
      description: 'Deadline for the opening shot. Expiry abandons the match.',
      pausesOnDisconnect: false,
    },
  ],
  status: 'beta',
  version: '1.0.0',
  sdkContractVersion: 1,
}

function toMoveOf(state: StandoffState): SeatId | null {
  if (state.abandonedAtOpening) return null
  if (state.hits.some((count) => count >= state.target)) return null
  return state.order[state.turn] ?? null
}

export const server: TurnBasedGameServer<
  StandoffState,
  StandoffAction,
  StandoffView,
  StandoffSettings,
  StandoffEvent
> = {
  actionSchema,
  disconnectPolicy: DEFAULT_DISCONNECT_POLICY,

  createInitialState(_ctx: GameContext, settings: StandoffSettings, seats: SeatRoster) {
    const order = seats.map((seat) => seat.seatId)
    return {
      state: {
        order,
        hits: order.map(() => 0),
        turn: 0,
        target: settings.target,
        shots: 0,
        abandonedAtOpening: false,
      },
      events: [],
      // Armed here, not by the lobby. A conformance run only ever fires the
      // timers the game itself asked for.
      timers: [setTimer(FIRST_MOVE_TIMER, settings.firstMoveSeconds * 1000, order[0] ?? null)],
    }
  },

  validateAction(_ctx, state, seatId, _action) {
    if (!state.order.includes(seatId)) return invalid('not_seated')
    if (server.getResult(state) !== null) return invalid('match_over')
    if (toMoveOf(state) !== seatId) return invalid('not_your_turn')
    return { ok: true }
  },

  applyAction(_ctx, state, seatId, _action) {
    const index = state.order.indexOf(seatId)
    const hits = state.hits.map((count, at) => (at === index ? count + 1 : count))
    const next: StandoffState = {
      ...state,
      hits,
      turn: (state.turn + 1) % state.order.length,
      shots: state.shots + 1,
    }
    return {
      state: next,
      events: [
        {
          type: 'shot_fired',
          payload: { seatId, hits: hits[index] ?? 0 },
          audience: PUBLIC,
        },
      ],
      // The opening deadline is dead the moment anyone fires. Leaving it armed
      // would have the platform abandon a match that is already under way.
      timers: state.shots === 0 ? [clearTimer(FIRST_MOVE_TIMER)] : [],
    }
  },

  getViewFor(state) {
    return {
      hits: state.hits,
      toMove: toMoveOf(state),
      target: state.target,
      shots: state.shots,
    }
  },

  getLegalActions(state, seatId) {
    return toMoveOf(state) === seatId ? [{ type: 'fire' as const }] : []
  },

  onTimer(_ctx, state, timerId, _seatId) {
    // The only unrecorded ending in the game. It is guarded on `shots` rather
    // than trusted from the timer id alone, because a `clear` the platform
    // raced past must not abandon a live match.
    if (timerId !== FIRST_MOVE_TIMER || state.shots > 0) {
      return { state, events: [], timers: [] }
    }
    return {
      state: { ...state, abandonedAtOpening: true },
      events: [{ type: 'nobody_fired', payload: {}, audience: PUBLIC }],
      timers: [],
    }
  },

  getResult(state): MatchResult | null {
    // ADR-0006: an unrecorded reason carries exactly zero standings.
    if (state.abandonedAtOpening) return { reason: 'aborted', standings: [] }

    const winner = state.hits.findIndex((count) => count >= state.target)
    if (winner < 0) return null
    const standings: Standing[] = state.order.map((seatId, index) => ({
      seatId,
      rank: index === winner ? 1 : 2,
      outcome: index === winner ? 'win' : 'loss',
      score: state.hits[index] ?? 0,
    }))
    return { reason: 'completed', standings }
  },
}
