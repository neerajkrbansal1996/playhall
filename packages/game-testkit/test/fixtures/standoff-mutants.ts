/**
 * Mutants of the `standoff` reference game, for the timer arm of
 * `result-standings-well-formed` (ADR-0010).
 *
 * The reference game is in `src/reference/standoff.ts` because it is also an
 * example a game author reads. The breakages belong here, next to `race.ts`:
 * they exist to prove the *gate* fails, and a gate that has only ever been
 * seen passing is not a gate.
 *
 * `neverArms` is the important one. A harness that reached the ending by
 * calling `onTimer` itself would go green on it, certifying a first-move
 * timeout for a game that never arms a first-move timer — the ending the
 * platform can then never produce. That is the bug ADR-0010 §1 rejects, so it
 * has a mutant.
 */

import {
  asTimerId,
  type ApplyResult,
  type GameContext,
  type GameManifest,
  type MatchResult,
  type SeatId,
  type TimerCommand,
  type TurnBasedGameServer,
} from '@playhall/game-sdk'
import {
  FIRST_MOVE_TIMER,
  manifest as referenceManifest,
  server as referenceServer,
  type StandoffAction,
  type StandoffEvent,
  type StandoffSettings,
  type StandoffState,
  type StandoffView,
} from '../../src/reference/standoff.js'
import type { AbortScenario, TurnBasedConformanceSubject } from '../../src/subject.js'

/** A second declared timer, for the tie-break and cascade cases. */
export const GRACE_TIMER = asTimerId('grace')
/** Deliberately absent from every manifest below. */
export const GHOST_TIMER = asTimerId('ghost')

export interface StandoffBreakage {
  /**
   * `createInitialState` returns no `setTimer` at all, while the subject still
   * declares `trigger: 'timer'` for `first-move`.
   */
  readonly neverArms?: boolean
  /** `createInitialState` arms an id `manifest.timers` does not declare. */
  readonly undeclaredSet?: boolean
  /** The server has no `onTimer` arm, so the declared ending cannot run. */
  readonly noOnTimer?: boolean
  /** The opening `set` is cleared on the next tick, so it never comes due. */
  readonly clearsBeforeFiring?: boolean
  /** The timer is paused and never resumed, so it is armed but not due. */
  readonly pausesForever?: boolean
  /** `onTimer` returns the state untouched, so `getResult` stays null. */
  readonly expiryDoesNotEnd?: boolean
  /** The abort records standings, violating ADR-0006's unrecorded clause. */
  readonly abortHasStandings?: boolean
  /**
   * Arms `grace` at the *same deadline* as `first-move`, in reverse id order,
   * and ends the match only on whichever fires. Pins the tie-break.
   */
  readonly tiedGrace?: boolean
  /**
   * Arms `grace` to fire *before* `first-move` and end the match with a
   * recorded forfeit — the "something else got there first" case the named
   * `timerId` exists to report clearly.
   */
  readonly earlyGraceEnds?: boolean
}

type StandoffServer = TurnBasedGameServer<
  StandoffState,
  StandoffAction,
  StandoffView,
  StandoffSettings,
  StandoffEvent
>

/** Which seat `grace` is charged to, when the mutant arms one. */
function firstSeat(state: StandoffState): SeatId | null {
  return state.order[0] ?? null
}

function manifestFor(breakage: StandoffBreakage): GameManifest<StandoffSettings> {
  if (breakage.tiedGrace !== true && breakage.earlyGraceEnds !== true) return referenceManifest
  return {
    ...referenceManifest,
    timers: [
      ...referenceManifest.timers,
      {
        id: 'grace',
        kind: 'turn',
        description: 'A second deadline, for exercising fire order.',
        pausesOnDisconnect: false,
      },
    ],
  }
}

export function makeStandoffServer(breakage: StandoffBreakage): StandoffServer {
  const openingTimers = (ctx: GameContext, settings: StandoffSettings, state: StandoffState) => {
    const delayMs = settings.firstMoveSeconds * 1000
    if (breakage.neverArms === true) return []
    if (breakage.undeclaredSet === true) {
      return [{ op: 'set' as const, timerId: GHOST_TIMER, seatId: null, delayMs }]
    }

    const first: TimerCommand[] = [
      { op: 'set', timerId: FIRST_MOVE_TIMER, seatId: firstSeat(state), delayMs },
    ]
    if (breakage.pausesForever === true) {
      first.push({ op: 'pause', timerId: FIRST_MOVE_TIMER })
    }
    if (breakage.tiedGrace === true) {
      // Armed *after* `first-move` and with an id that sorts later, so
      // insertion order and id order disagree with each other. A queue that
      // fired in insertion order would still pass a same-id-order assertion.
      first.unshift({ op: 'set', timerId: GRACE_TIMER, seatId: firstSeat(state), delayMs })
    }
    if (breakage.earlyGraceEnds === true) {
      first.push({
        op: 'set',
        timerId: GRACE_TIMER,
        seatId: firstSeat(state),
        delayMs: Math.max(1, delayMs - 1000),
      })
    }
    void ctx
    return first
  }

  const server: StandoffServer = {
    ...referenceServer,

    createInitialState(ctx, settings, seats) {
      const built = referenceServer.createInitialState(ctx, settings, seats)
      return { ...built, timers: openingTimers(ctx, settings, built.state) }
    },

    applyAction(ctx, state, seatId, action) {
      const applied = referenceServer.applyAction(ctx, state, seatId, action)
      if (breakage.clearsBeforeFiring !== true) return applied
      return { ...applied, timers: [{ op: 'clear', timerId: FIRST_MOVE_TIMER }] }
    },

    onTimer(ctx, state, timerId, seatId): ApplyResult<StandoffState, StandoffEvent> {
      if (breakage.expiryDoesNotEnd === true) return { state, events: [], timers: [] }

      if (timerId === GRACE_TIMER) {
        // A *recorded* ending from the other timer. The point of a required
        // `timerId` is that this produces "the match ended on 'grace'" rather
        // than a silent pass.
        return {
          state: { ...state, hits: state.hits.map((_, at) => (at === 0 ? state.target : 0)) },
          events: [],
          timers: [],
        }
      }

      return (
        referenceServer.onTimer?.(ctx, state, timerId, seatId) ?? { state, events: [], timers: [] }
      )
    },

    getResult(state): MatchResult | null {
      const result = referenceServer.getResult(state)
      if (result === null) return null
      if (breakage.abortHasStandings !== true || result.reason !== 'aborted') return result
      // ADR-0006: an unrecorded reason must carry exactly zero standings.
      return {
        reason: 'aborted',
        standings: state.order.map((seatId, index) => ({
          seatId,
          rank: index + 1,
          outcome: index === 0 ? 'win' : 'loss',
        })),
      }
    },
  }

  if (breakage.noOnTimer === true) {
    const { onTimer: _dropped, ...withoutOnTimer } = server
    return withoutOnTimer as StandoffServer
  }
  return server
}

export type StandoffSubject = TurnBasedConformanceSubject<
  StandoffState,
  StandoffAction,
  StandoffView,
  StandoffSettings,
  StandoffEvent
>

/**
 * The mutant as a conformance subject. `scenario` lets a test override the
 * declaration itself — a scenario naming a timer the manifest does not declare
 * is as much a mis-declaration as a game that never arms one.
 */
export function makeStandoff(
  breakage: StandoffBreakage = {},
  scenario?: AbortScenario<StandoffState, StandoffAction>,
): StandoffSubject {
  return {
    manifest: manifestFor(breakage),
    server: makeStandoffServer(breakage),
    abortScenarios: [
      scenario ?? {
        label: 'nobody fires before the opening deadline',
        trigger: 'timer',
        timerId: FIRST_MOVE_TIMER,
      },
    ],
    probeActions: [{ type: 'fire' }],
    malformedActions: [{ type: 'duck' }, { type: 'fire', extra: 1 }, 'fire'],
  }
}
