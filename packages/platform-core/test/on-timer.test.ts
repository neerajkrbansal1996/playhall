/**
 * The seam the room runner will sit on: a timer fires, `onTimer` runs on the
 * game module, and the commands it returns come back into the service.
 *
 * The game below is a deliberately minimal turn-based module written against
 * `@playhall/game-sdk` only — no platform internals — so this test doubles as a
 * check that the service is usable from the plugin side of the boundary. The
 * runner itself is PER-15; what is being proved here is that the timer half of
 * it already works.
 */
import {
  type ApplyResult,
  type GameContext,
  type GameEvent,
  type SeatId,
  type TimerCommand,
  type TimerId,
  type TimerSpec,
  PUBLIC,
  asGameId,
  asMatchId,
  asMatchSeed,
  asSeatId,
  asTimerId,
  createGameContext,
  setTimer,
} from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { fixedClock } from '../src/runtime.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { type TimerExpiry, TimerService } from '../src/timers/service.js'

const MATCH = asMatchId('m1')
const WHITE = asSeatId('white')
const BLACK = asSeatId('black')
const WHITE_CLOCK = asTimerId('clock:white')
const BLACK_CLOCK = asTimerId('clock:black')
const TURN = asTimerId('turn')

const SPECS: readonly TimerSpec[] = [
  { id: 'clock:white', kind: 'chess-clock', description: 'white', pausesOnDisconnect: true },
  { id: 'clock:black', kind: 'chess-clock', description: 'black', pausesOnDisconnect: true },
  { id: 'turn', kind: 'turn', description: 'move deadline', pausesOnDisconnect: false },
]

interface ToyState {
  readonly toMove: SeatId
  readonly outcome: string | null
  readonly passes: number
}

type ToyEvent = GameEvent<'flag_fall' | 'turn_timeout', { readonly seatId: string }>

/**
 * Two behaviours worth testing: a flag-fall ends the match, and a turn timeout
 * passes the move on and re-arms itself. Pure — no clock, no randomness.
 */
const toyGame = {
  onTimer(
    _ctx: GameContext,
    state: ToyState,
    timerId: TimerId,
    seatId: SeatId | null,
  ): ApplyResult<ToyState, ToyEvent> {
    if (timerId === WHITE_CLOCK || timerId === BLACK_CLOCK) {
      const loser = seatId ?? state.toMove
      return {
        state: { ...state, outcome: `${loser} flagged` },
        events: [{ type: 'flag_fall', payload: { seatId: loser }, audience: PUBLIC }],
        timers: [] as readonly TimerCommand[],
      }
    }
    const next = state.toMove === WHITE ? BLACK : WHITE
    return {
      state: { ...state, toMove: next, passes: state.passes + 1 },
      events: [{ type: 'turn_timeout', payload: { seatId: state.toMove }, audience: PUBLIC }],
      timers: [setTimer(TURN, 30_000)],
    }
  },
}

/**
 * A stand-in for the part of the room runner that owns `onTimer`. It is about
 * fifteen lines, which is the point: the service does the clock work and the
 * runner only has to stamp a context and feed the commands back.
 */
function runner(options: { initialMs: number; turnTimerMs?: number }) {
  const clock = fixedClock(1_700_000_000_000)
  let state: ToyState = { toMove: WHITE, outcome: null, passes: 0 }
  let sequence = 0
  const events: ToyEvent[] = []
  const contexts: GameContext[] = []

  const service = new TimerService({
    matchId: MATCH,
    clock,
    scheduler: createManualScheduler(),
    specs: SPECS,
    onExpire: (expiry: TimerExpiry) => {
      sequence += 1
      // `ctx.now` is the *due* time, not the firing time. Replaying the match
      // log must reproduce this call exactly, and the firing time depends on
      // how busy the event loop happened to be.
      const ctx = createGameContext({
        matchId: MATCH,
        gameId: asGameId('toy'),
        gameVersion: '1.0.0',
        sdkContractVersion: 1,
        now: expiry.dueAtMs,
        seed: asMatchSeed('seed'),
        sequence,
      })
      contexts.push(ctx)
      const result = toyGame.onTimer(ctx, state, expiry.timerId, expiry.seatId)
      state = result.state
      events.push(...result.events)
      service.apply(result.timers ?? [], ctx.now)
      if (result.state.outcome === null && expiry.kind === 'turn') {
        service.switchTurnTo(result.state.toMove, ctx.now)
      }
    },
  })

  service.declarePlayerClock(WHITE_CLOCK, WHITE, {
    initialMs: options.initialMs,
    incrementMs: 2_000,
  })
  service.declarePlayerClock(BLACK_CLOCK, BLACK, {
    initialMs: options.initialMs,
    incrementMs: 2_000,
  })
  service.switchTurnTo(WHITE)
  if (options.turnTimerMs !== undefined) {
    service.set(TURN, { delayMs: options.turnTimerMs })
  }

  return {
    clock,
    service,
    events,
    contexts,
    get state() {
      return state
    },
  }
}

describe('flag fall', () => {
  it('reaches onTimer with the seat that ran out', () => {
    const r = runner({ initialMs: 60_000 })
    r.clock.advance(60_050)
    r.service.poll()

    expect(r.state.outcome).toBe('white flagged')
    expect(r.events).toEqual([{ type: 'flag_fall', payload: { seatId: WHITE }, audience: PUBLIC }])
  })

  it('stamps ctx.now with the deadline, not with when the event loop woke up', () => {
    const r = runner({ initialMs: 60_000 })
    const dueAtMs = r.clock.now() + 60_000
    r.clock.advance(60_400) // 400 ms of event-loop lag
    r.service.poll()

    expect(r.contexts[0]?.now).toBe(dueAtMs)
  })

  it('does not fire for the seat that is not on move', () => {
    const r = runner({ initialMs: 60_000 })
    r.clock.advance(30_000)
    r.service.switchTurnTo(BLACK)
    r.clock.advance(60_050)
    r.service.poll()

    expect(r.state.outcome).toBe('black flagged')
  })
})

describe('turn timeout', () => {
  it('passes the move on and re-arms itself from the same deadline', () => {
    const r = runner({ initialMs: 600_000, turnTimerMs: 30_000 })
    const firstDueMs = r.clock.now() + 30_000

    r.clock.advance(30_120)
    r.service.poll()
    expect(r.state.toMove).toBe(BLACK)
    expect(r.state.passes).toBe(1)
    // Re-armed against ctx.now (the deadline), so the lag does not compound.
    expect(r.service.nextDeadlineMs()).toBe(firstDueMs + 30_000)

    r.clock.advance(30_500)
    r.service.poll()
    expect(r.state.toMove).toBe(WHITE)
    expect(r.state.passes).toBe(2)
    expect(r.service.nextDeadlineMs()).toBe(firstDueMs + 60_000)
  })

  it('moves the player clock over at the same time', () => {
    const r = runner({ initialMs: 600_000, turnTimerMs: 30_000 })
    r.clock.advance(30_000)
    r.service.poll()

    expect(r.service.isRunning(BLACK_CLOCK)).toBe(true)
    expect(r.service.isRunning(WHITE_CLOCK)).toBe(false)
    expect(r.service.remainingMs(WHITE_CLOCK)).toBe(572_000) // 570 + 2 increment
  })

  it('does not drift over twenty consecutive timeouts, however late each one is', () => {
    const r = runner({ initialMs: 3_600_000, turnTimerMs: 30_000 })
    const startedAtMs = r.clock.now()

    for (let i = 1; i <= 20; i += 1) {
      // Wildly variable event-loop lag, up to 900 ms per firing.
      r.clock.set(startedAtMs + i * 30_000 + ((i * 137) % 900))
      r.service.poll()
    }

    expect(r.state.passes).toBe(20)
    // Twenty turns of exactly 30 s each, with no accumulated lag whatsoever.
    expect(r.service.nextDeadlineMs()).toBe(startedAtMs + 21 * 30_000)
  })
})

describe('the game only ever sees timers it declared', () => {
  it('refuses a set for an undeclared id', () => {
    const r = runner({ initialMs: 60_000 })
    expect(() =>
      r.service.apply([setTimer(asTimerId('undeclared'), 1_000)], r.clock.now()),
    ).toThrow(/not declared/)
  })
})
