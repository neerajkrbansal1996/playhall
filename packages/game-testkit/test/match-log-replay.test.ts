/**
 * The regression for PER-176 / ADR-0013: a match log must be able to express a
 * timer firing and a logged lifecycle hook, and `replay()` must apply them.
 *
 * Every assertion here is about crash recovery, not about the conformance
 * harness. `replay()` is the code path `apps/realtime`'s room runner will use to
 * rebuild a live match from Postgres after a restart, and the failure these
 * tests pin is silent: a match restored from an action-only log comes back with
 * every timer-driven transition missing — a flagged clock un-flagged — and
 * nothing throws. The player sees a plausible, wrong board.
 *
 * The subject is deliberately a game whose `onTimer` mutates state, because no
 * game on `main` has one, so nothing else in the suite can reach this path.
 */

import { describe, expect, it } from 'vitest'
import {
  type ApplyResult,
  type GameEvent,
  type MatchLog,
  type SeatId,
  asSeatId,
  asTimerId,
} from '@playhall/game-sdk'
import { buildDefaultRoster, contextAt, replay } from '../src/index.js'
import type { ContextOptions, DriverServer } from '../src/index.js'

/**
 * A two-seat game with a chess-clock flag. `onTimer` is the only way to reach
 * `flagged`, and `flagged` is the only way to reach a result — so a replay that
 * drops timer entries produces a match that is still live when the real one is
 * over.
 */
interface ClockState {
  readonly moves: number
  readonly flagged: SeatId | null
  /** Every `ctx.now` the game was handed, in order. Pins the clock, not just the state. */
  readonly nowsSeen: readonly number[]
  readonly dropped: readonly string[]
}

type ClockAction = { readonly type: 'move' }

const TURN_TIMER = asTimerId('turn')
const SEAT_1 = asSeatId('seat-1')
const SEAT_2 = asSeatId('seat-2')

const ok = (state: ClockState): ApplyResult<ClockState, GameEvent> => ({ state, events: [] })

const clockGame: DriverServer<ClockState, ClockAction, Record<string, never>, GameEvent> = {
  createInitialState: (ctx) => ok({ moves: 0, flagged: null, nowsSeen: [ctx.now], dropped: [] }),
  validateAction: () => ({ ok: true }),
  applyAction: (ctx, state) =>
    ok({ ...state, moves: state.moves + 1, nowsSeen: [...state.nowsSeen, ctx.now] }),
  onTimer: (ctx, state, _timerId, seatId) =>
    ok({ ...state, flagged: seatId, nowsSeen: [...state.nowsSeen, ctx.now] }),
  onDisconnect: (ctx, state, seatId, reason) =>
    ok({
      ...state,
      dropped: [...state.dropped, `${String(seatId)}:${reason}`],
      nowsSeen: [...state.nowsSeen, ctx.now],
    }),
  onReconnect: (ctx, state, seatId) =>
    ok({
      ...state,
      dropped: state.dropped.filter((d) => !d.startsWith(`${String(seatId)}:`)),
      nowsSeen: [...state.nowsSeen, ctx.now],
    }),
  getResult: (state) =>
    state.flagged === null
      ? null
      : {
          reason: 'timeout',
          standings: [
            { seatId: state.flagged, outcome: 'loss', rank: 2 },
            { seatId: state.flagged === SEAT_1 ? SEAT_2 : SEAT_1, outcome: 'win', rank: 1 },
          ],
        },
}

const CONTEXT: ContextOptions = {
  gameId: 'clock-flag',
  gameVersion: '1.0.0',
  sdkContractVersion: 1,
  startNow: 1_700_000_000_000,
  nowStepMs: 1_000,
  seed: 'per-176-seed' as never,
}

const ROSTER = buildDefaultRoster(2, false)
const NO_SETTINGS: Record<string, never> = {}

/**
 * The deadline the live match fired at. Deliberately *not*
 * `startNow + 2 * nowStepMs` (= …002_000): a real turn timer's deadline is set
 * by `delayMs` from an earlier `ctx.now` and the runner may fire it late, so it
 * has no relation to the sequence number it lands on. Any replay that recomputes
 * `ctx.now` from `sequence` lands on …002_000 and reads a different clock than
 * the live match did.
 */
const FIRED_AT = 1_700_000_031_500

/**
 * The live match, driven by hand the way the room runner will: an action, then
 * a timer expiry, then another action. `playout()` cannot produce this — it has
 * no clock that can reach a deadline (ADR-0010) — which is exactly why the
 * determinism check never caught the hole.
 */
function liveMatch(): {
  readonly states: readonly ClockState[]
  readonly log: MatchLog<ClockAction>
} {
  const log: MatchLog<ClockAction> = [
    {
      kind: 'action',
      sequence: 1,
      nowMs: contextAt(CONTEXT, 1).now,
      seatId: SEAT_1,
      action: { type: 'move' },
    },
    { kind: 'timer', sequence: 2, nowMs: FIRED_AT, timerId: TURN_TIMER, seatId: SEAT_2 },
    {
      kind: 'action',
      sequence: 3,
      nowMs: contextAt(CONTEXT, 3).now,
      seatId: SEAT_1,
      action: { type: 'move' },
    },
  ]

  const states: ClockState[] = []
  let state = clockGame.createInitialState(contextAt(CONTEXT, 0), NO_SETTINGS, ROSTER).state
  states.push(state)
  for (const entry of log) {
    const ctx = contextAt(CONTEXT, entry.sequence)
    const now = entry.nowMs
    const withNow = { ...ctx, now }
    state =
      entry.kind === 'action'
        ? clockGame.applyAction(withNow, state, entry.seatId, entry.action).state
        : clockGame.onTimer!(withNow, state, TURN_TIMER, SEAT_2).state
    states.push(state)
  }
  return { states, log }
}

describe('replay() over a match log containing a timer fire', () => {
  it('reproduces the live match exactly', () => {
    const live = liveMatch()
    const replayed = replay(clockGame, NO_SETTINGS, ROSTER, CONTEXT, live.log, true)
    expect(replayed.states).toEqual(live.states)
  })

  it('restores the flag, so the recovered match is over rather than still live', () => {
    const live = liveMatch()
    const replayed = replay(clockGame, NO_SETTINGS, ROSTER, CONTEXT, live.log, true)
    const final = replayed.states.at(-1)

    expect(final?.flagged).toBe(SEAT_2)
    expect(clockGame.getResult(final!)).not.toBeNull()
    expect(clockGame.getResult(final!)).toEqual(clockGame.getResult(live.states.at(-1)!))
  })

  it('replays the recorded deadline as ctx.now rather than recomputing it from the sequence', () => {
    const live = liveMatch()
    const replayed = replay(clockGame, NO_SETTINGS, ROSTER, CONTEXT, live.log, true)

    expect(replayed.states.at(-1)?.nowsSeen).toContain(FIRED_AT)
    // The value a `contextAt(_, 2)`-derived clock would have produced.
    expect(replayed.states.at(-1)?.nowsSeen).not.toContain(contextAt(CONTEXT, 2).now)
  })

  /**
   * The defect itself, stated as an assertion. This is what a runner built on
   * the pre-ADR-0013 shape would have persisted, and it is why the shape had to
   * change rather than the replayer being taught to guess.
   */
  it('an action-only log — the pre-ADR-0013 shape — silently diverges', () => {
    const live = liveMatch()
    const actionsOnly = live.log.filter((entry) => entry.kind === 'action')
    const replayed = replay(clockGame, NO_SETTINGS, ROSTER, CONTEXT, actionsOnly, true)
    const final = replayed.states.at(-1)

    // No throw, no error: the recovered match just quietly has no flag.
    expect(final?.flagged).toBeNull()
    expect(clockGame.getResult(final!)).toBeNull()
    expect(final).not.toEqual(live.states.at(-1))
  })

  it('resumes from mid-log across a timer entry', () => {
    const live = liveMatch()
    const resumed = replay(clockGame, NO_SETTINGS, ROSTER, CONTEXT, live.log, true, {
      state: live.states[1]!,
      fromSequence: 2,
    })
    expect(resumed.states).toEqual(live.states.slice(1))
    expect(resumed.states.at(-1)?.flagged).toBe(SEAT_2)
  })
})

describe('replay() over disconnect and reconnect entries', () => {
  const log: MatchLog<ClockAction> = [
    {
      kind: 'disconnect',
      sequence: 1,
      nowMs: 1_700_000_005_000,
      seatId: SEAT_2,
      reason: 'transport_closed',
    },
    { kind: 'reconnect', sequence: 2, nowMs: 1_700_000_009_000, seatId: SEAT_2 },
  ]

  it('applies a logged onDisconnect', () => {
    const replayed = replay(clockGame, NO_SETTINGS, ROSTER, CONTEXT, log.slice(0, 1), true)
    expect(replayed.states.at(-1)?.dropped).toEqual(['seat-2:transport_closed'])
    expect(replayed.states.at(-1)?.nowsSeen).toContain(1_700_000_005_000)
  })

  it('applies a logged onReconnect, so the pair round-trips', () => {
    const replayed = replay(clockGame, NO_SETTINGS, ROSTER, CONTEXT, log, true)
    const final = replayed.states.at(-1)

    expect(final?.dropped).toEqual([])
    // `dropped` returning to `[]` is also what a *skipped* pair produces, so
    // assert the hook actually ran: only `onReconnect` can append its own
    // `ctx.now`, and there must be one state per entry.
    expect(final?.nowsSeen).toContain(1_700_000_009_000)
    expect(replayed.states).toHaveLength(log.length + 1)
  })
})

describe('replay() when the log and the module disagree', () => {
  const noHooks: DriverServer<ClockState, ClockAction, Record<string, never>, GameEvent> = {
    createInitialState: clockGame.createInitialState,
    validateAction: clockGame.validateAction,
    applyAction: clockGame.applyAction,
    getResult: clockGame.getResult,
  }

  it('throws on a timer entry the game cannot handle rather than replaying a no-op', () => {
    const log: MatchLog<ClockAction> = [
      { kind: 'timer', sequence: 1, nowMs: FIRED_AT, timerId: TURN_TIMER, seatId: SEAT_2 },
    ]
    expect(() => replay(noHooks, NO_SETTINGS, ROSTER, CONTEXT, log, true)).toThrow(
      /timer entry at sequence 1 but the game does not implement onTimer/,
    )
  })

  it('throws on a disconnect entry the game cannot handle', () => {
    const log: MatchLog<ClockAction> = [
      { kind: 'disconnect', sequence: 1, nowMs: FIRED_AT, seatId: SEAT_2, reason: 'timeout' },
    ]
    expect(() => replay(noHooks, NO_SETTINGS, ROSTER, CONTEXT, log, true)).toThrow(
      /does not implement onDisconnect/,
    )
  })

  it('throws on a reconnect entry the game cannot handle', () => {
    const log: MatchLog<ClockAction> = [
      { kind: 'reconnect', sequence: 1, nowMs: FIRED_AT, seatId: SEAT_2 },
    ]
    expect(() => replay(noHooks, NO_SETTINGS, ROSTER, CONTEXT, log, true)).toThrow(
      /does not implement onReconnect/,
    )
  })
})
