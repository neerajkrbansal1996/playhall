/**
 * The service, driven by a manual clock and a manual scheduler so every test
 * is exact and instant. `service.poll()` stands in for the `setTimeout` the
 * real scheduler would have delivered.
 */
import {
  type TimerCommand,
  type TimerSpec,
  asMatchId,
  asSeatId,
  asTimerId,
  clearTimer,
  pauseTimer,
  resumeTimer,
  setTimer,
} from '@playhall/game-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type MutableClock, fixedClock } from '../src/runtime.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { type TimerExpiry, TimerService } from '../src/timers/service.js'

const MATCH = asMatchId('m1')
const WHITE = asSeatId('white')
const BLACK = asSeatId('black')
const TURN = asTimerId('turn')
const MATCH_TIMER = asTimerId('match')
const WHITE_CLOCK = asTimerId('clock:white')
const BLACK_CLOCK = asTimerId('clock:black')

const SPECS: readonly TimerSpec[] = [
  { id: 'turn', kind: 'turn', description: 'move deadline', pausesOnDisconnect: false },
  { id: 'match', kind: 'match', description: 'match ceiling', pausesOnDisconnect: false },
  { id: 'clock:white', kind: 'chess-clock', description: 'white', pausesOnDisconnect: true },
  { id: 'clock:black', kind: 'chess-clock', description: 'black', pausesOnDisconnect: true },
]

interface Harness {
  clock: MutableClock
  service: TimerService
  expiries: TimerExpiry[]
}

function harness(options: { specs?: readonly TimerSpec[]; startMs?: number } = {}): Harness {
  const clock = fixedClock(options.startMs ?? 1_000_000)
  const expiries: TimerExpiry[] = []
  const service = new TimerService({
    matchId: MATCH,
    clock,
    scheduler: createManualScheduler(),
    specs: options.specs,
    onExpire: (expiry) => expiries.push(expiry),
  })
  return { clock, service, expiries }
}

describe('one-shot timers', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('arms from the issuing instant, not from when the service got round to it', () => {
    // The action was stamped at T, but the service is called 400 ms later
    // (queueing, a slow fan-out). The player still gets their full 30 s.
    const issuedAtMs = h.clock.now()
    h.clock.advance(400)
    h.service.set(TURN, { delayMs: 30_000, issuedAtMs })

    expect(h.service.nextDeadlineMs()).toBe(issuedAtMs + 30_000)
    expect(h.service.remainingMs(TURN)).toBe(29_600)
  })

  it('fires once due, reports lateness, and does not fire again', () => {
    h.service.set(TURN, { delayMs: 30_000 })
    const dueAtMs = h.clock.now() + 30_000

    h.clock.advance(29_998)
    expect(h.service.poll()).toHaveLength(0)

    h.clock.advance(9) // event loop overshot by 7 ms
    const fired = h.service.poll()
    expect(fired).toHaveLength(1)
    expect(fired[0]?.timerId).toBe(TURN)
    expect(fired[0]?.dueAtMs).toBe(dueAtMs)
    expect(fired[0]?.latenessMs).toBe(7)

    h.clock.advance(60_000)
    expect(h.service.poll()).toHaveLength(0)
    expect(h.expiries).toHaveLength(1)
  })

  it('charges the budget against the due time, so lateness costs nobody time', () => {
    h.service.set(TURN, { delayMs: 30_000 })
    const dueAtMs = h.clock.now() + 30_000
    h.clock.advance(31_000) // 1 s late
    const [fired] = h.service.poll()
    expect(fired?.dueAtMs).toBe(dueAtMs)
    expect(fired?.firedAtMs).toBe(dueAtMs + 1_000)
  })

  it('fires immediately for a zero-length timer rather than waiting for the next event', () => {
    h.service.set(TURN, { delayMs: 0 })
    expect(h.expiries.map((expiry) => expiry.timerId)).toEqual([TURN])
  })

  it('delivers simultaneous expiries in deadline order', () => {
    h.service.set(MATCH_TIMER, { delayMs: 20_000, kind: 'match' })
    h.service.set(TURN, { delayMs: 10_000 })
    h.clock.advance(25_000)

    expect(h.service.poll().map((expiry) => expiry.timerId)).toEqual([TURN, MATCH_TIMER])
  })

  it('lets `clear` cancel a timer outright', () => {
    h.service.set(TURN, { delayMs: 10_000 })
    h.service.clear(TURN)
    h.clock.advance(60_000)
    expect(h.service.poll()).toHaveLength(0)
    expect(h.service.get(TURN)).toBeUndefined()
    expect(h.service.remainingMs(TURN)).toBe(0)
  })

  it('re-arms an existing timer on a second `set`', () => {
    h.service.set(TURN, { delayMs: 10_000 })
    h.clock.advance(9_000)
    h.service.set(TURN, { delayMs: 10_000 })
    expect(h.service.remainingMs(TURN)).toBe(10_000)
  })

  it('honours `replace: false` so a re-sent action cannot extend a live timer', () => {
    h.service.set(TURN, { delayMs: 10_000 })
    h.clock.advance(9_000)
    h.service.set(TURN, { delayMs: 10_000, replace: false })
    expect(h.service.remainingMs(TURN)).toBe(1_000)
  })

  it('lets `replace: false` re-arm a timer that already expired', () => {
    h.service.set(TURN, { delayMs: 1_000 })
    h.clock.advance(2_000)
    h.service.poll()
    h.service.set(TURN, { delayMs: 5_000, replace: false })
    expect(h.service.remainingMs(TURN)).toBe(5_000)
  })
})

describe('manifest enforcement', () => {
  it('rejects a timer the manifest never declared', () => {
    const { service } = harness({ specs: SPECS })
    expect(() => service.set(asTimerId('sneaky'), { delayMs: 1_000 })).toThrow(/not declared/)
  })

  it('takes the kind from the spec when the caller does not say', () => {
    const { service } = harness({ specs: SPECS })
    expect(service.set(MATCH_TIMER, { delayMs: 1_000 }).kind).toBe('match')
  })

  it('accepts anything when no manifest was supplied', () => {
    const { service } = harness()
    expect(service.set(asTimerId('anything'), { delayMs: 1 }).kind).toBe('custom')
  })
})

describe('SDK timer commands', () => {
  it('executes set / pause / resume / clear from a game reducer', () => {
    const h = harness()
    const issuedAtMs = h.clock.now()

    const commands: TimerCommand[] = [setTimer(TURN, 30_000), setTimer(MATCH_TIMER, 600_000)]
    h.service.apply(commands, issuedAtMs)
    expect(h.service.remainingMs(TURN)).toBe(30_000)

    h.clock.advance(5_000)
    h.service.apply([pauseTimer(TURN)], h.clock.now())
    h.clock.advance(100_000)
    expect(h.service.remainingMs(TURN)).toBe(25_000)

    h.service.apply([resumeTimer(TURN)], h.clock.now())
    h.clock.advance(5_000)
    expect(h.service.remainingMs(TURN)).toBe(20_000)

    h.service.apply([clearTimer(TURN)], h.clock.now())
    expect(h.service.get(TURN)).toBeUndefined()
  })

  it('applies commands against the reducer’s ctx.now, not the wall clock', () => {
    const h = harness()
    const ctxNow = h.clock.now()
    h.clock.advance(250) // persistence, fan-out, whatever happened in between
    h.service.apply([setTimer(TURN, 30_000)], ctxNow)
    expect(h.service.nextDeadlineMs()).toBe(ctxNow + 30_000)
  })

  it('ignores pause/resume/clear for a timer that does not exist', () => {
    const h = harness()
    expect(() =>
      h.service.apply([pauseTimer(TURN), resumeTimer(TURN), clearTimer(TURN)], h.clock.now()),
    ).not.toThrow()
  })
})

describe('per-player clocks', () => {
  function chessHarness() {
    const h = harness({ specs: SPECS })
    h.service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 300_000, incrementMs: 3_000 })
    h.service.declarePlayerClock(BLACK_CLOCK, BLACK, { initialMs: 300_000, incrementMs: 3_000 })
    return h
  }

  it('only runs the clock of the seat to move', () => {
    const h = chessHarness()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(10_000)

    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(290_000)
    expect(h.service.remainingMs(BLACK_CLOCK)).toBe(300_000)
    expect(h.service.isRunning(BLACK_CLOCK)).toBe(false)
  })

  it('credits the increment on the handover and starts the other side', () => {
    const h = chessHarness()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(10_000)
    h.service.switchTurnTo(BLACK)

    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(293_000)
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(false)
    expect(h.service.isRunning(BLACK_CLOCK)).toBe(true)

    h.clock.advance(4_000)
    expect(h.service.remainingMs(BLACK_CLOCK)).toBe(296_000)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(293_000)
  })

  it('stops everything when the move passes to nobody', () => {
    const h = chessHarness()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(10_000)
    h.service.switchTurnTo(null)

    h.clock.advance(1_000_000)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(293_000)
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(false)
  })

  it('switching to the seat already on move is a no-op, not a lost increment', () => {
    const h = chessHarness()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(10_000)
    h.service.switchTurnTo(WHITE)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(290_000)
  })

  it('fires flag-fall when the budget runs out', () => {
    const h = chessHarness()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(300_100)
    const fired = h.service.poll()

    expect(fired).toHaveLength(1)
    expect(fired[0]?.timerId).toBe(WHITE_CLOCK)
    expect(fired[0]?.seatId).toBe(WHITE)
    expect(fired[0]?.kind).toBe('chess-clock')
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(0)
  })

  it('will not restart a clock that already flagged', () => {
    const h = chessHarness()
    h.service.switchTurnTo(WHITE)
    h.clock.advance(300_001)
    h.service.poll()

    h.service.switchTurnTo(BLACK)
    h.service.switchTurnTo(WHITE)
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(false)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(0)
  })

  it('pushes the deadline out by the unspent delay under simple delay', () => {
    const h = harness({ specs: SPECS })
    h.service.declarePlayerClock(WHITE_CLOCK, WHITE, {
      initialMs: 60_000,
      delayMs: 5_000,
      delayMode: 'simple',
    })
    const startedAtMs = h.clock.now()
    h.service.switchTurnTo(WHITE)

    expect(h.service.nextDeadlineMs()).toBe(startedAtMs + 65_000)
    h.clock.advance(3_000)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(60_000)
    expect(h.service.delayRemainingMs(WHITE_CLOCK)).toBe(2_000)
  })

  it('reports zero delay remaining for a timer with no delay, and for an unknown one', () => {
    const h = chessHarness()
    h.service.switchTurnTo(WHITE)
    expect(h.service.delayRemainingMs(WHITE_CLOCK)).toBe(0)
    expect(h.service.delayRemainingMs(asTimerId('nope'))).toBe(0)
  })
})

describe('disconnect and pause', () => {
  it('freezes a disconnected seat’s clock and nobody else’s', () => {
    const h = harness({ specs: SPECS })
    h.service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 300_000 })
    h.service.declarePlayerClock(BLACK_CLOCK, BLACK, { initialMs: 300_000 })
    h.service.switchTurnTo(WHITE)

    h.clock.advance(5_000)
    h.service.pauseForSeat(WHITE)
    h.clock.advance(120_000) // a two-minute tunnel
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(295_000)

    h.service.resumeForSeat(WHITE)
    h.clock.advance(5_000)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(290_000)
  })

  it('leaves a timer alone when the manifest says it does not pause on disconnect', () => {
    const h = harness({ specs: SPECS })
    h.service.set(TURN, { seatId: WHITE, delayMs: 30_000 })
    h.service.pauseForSeat(WHITE)
    h.clock.advance(10_000)
    expect(h.service.remainingMs(TURN)).toBe(20_000)
  })

  it('pauses an undeclared seat timer, because the safe default is not to charge', () => {
    const h = harness()
    h.service.set(TURN, { seatId: WHITE, delayMs: 30_000 })
    h.service.pauseForSeat(WHITE)
    h.clock.advance(10_000)
    expect(h.service.remainingMs(TURN)).toBe(30_000)
  })

  it('pauses and resumes the whole room', () => {
    const h = harness()
    h.service.set(TURN, { delayMs: 30_000 })
    h.service.set(MATCH_TIMER, { delayMs: 600_000 })

    h.clock.advance(5_000)
    h.service.pauseAll()
    expect(h.service.nextDeadlineMs()).toBeNull()

    h.clock.advance(1_000_000)
    h.service.resumeAll()
    expect(h.service.remainingMs(TURN)).toBe(25_000)
    expect(h.service.remainingMs(MATCH_TIMER)).toBe(595_000)
  })
})

describe('re-entrancy', () => {
  it('lets an expiry handler arm the next timer without recursing', () => {
    const clock = fixedClock(0)
    let rounds = 0
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      onExpire: (expiry) => {
        rounds += 1
        if (rounds < 3) service.apply([setTimer(expiry.timerId, 10_000)], expiry.dueAtMs)
      },
    })

    service.set(TURN, { delayMs: 10_000 })
    clock.advance(10_000)
    service.poll()
    expect(rounds).toBe(1)

    clock.advance(10_000)
    service.poll()
    clock.advance(10_000)
    service.poll()
    expect(rounds).toBe(3)
  })

  it('drains a handler that re-arms a zero-length timer, without recursing', () => {
    const clock = fixedClock(0)
    const onExpire = vi.fn((expiry: TimerExpiry) => {
      if (onExpire.mock.calls.length < 5)
        service.set(expiry.timerId, { delayMs: 0, issuedAtMs: clock.now() })
    })
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      onExpire,
    })

    service.set(TURN, { delayMs: 0 })
    // Each re-arm happens inside a firing pass, so it is picked up by the next
    // pass of the drain rather than re-entering. The drain runs the chain out
    // before `set` returns, because a mutator must not leave a due timer
    // un-reported — there is no scheduler in replay to pick it up.
    expect(onExpire).toHaveBeenCalledTimes(5)
    expect(service.get(TURN)?.expired).toBe(true)
    service.poll()
    expect(onExpire).toHaveBeenCalledTimes(5)
  })

  it('force-expires and reports when a handler out-runs the drain cap', () => {
    const clock = fixedClock(0)
    const dropped: TimerExpiry[][] = []
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      // Pathological: re-arms an already-due timer on every single pass.
      onExpire: (expiry) => service.set(expiry.timerId, { delayMs: 0, issuedAtMs: clock.now() }),
      onDrainExhausted: (expiries) => dropped.push([...expiries]),
    })

    service.set(TURN, { delayMs: 0 })

    // The cap stops the loop, and the record is not left at zero un-expired.
    // Live the handler's re-arm means the scheduler would still pick it up, as a
    // `setTimeout(0)` spin; in replay there is no scheduler at all, so without
    // the force-expiry the game could never learn of it. Replay is the argument.
    expect(service.get(TURN)?.expired).toBe(true)
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.map((expiry) => expiry.timerId)).toEqual([TURN])
  })

  it('does not let the exhaustion handler re-enter the drain', () => {
    const clock = fixedClock(0)
    let exhausted = 0
    // Pathological twice over: re-arms on every expiry *and* reacts to the
    // exhaustion report by re-arming again. `onExpire` is guarded by `#firing`;
    // `onDrainExhausted` must be too, or it recurses until the stack goes. That
    // throw would be uncaught inside a mutator, so one buggy game would take
    // every other match sharing the instance with it.
    const service: TimerService = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      onExpire: () => service.set(TURN, { delayMs: 0, issuedAtMs: clock.now() }),
      onDrainExhausted: () => {
        exhausted += 1
        service.set(TURN, { delayMs: 0, issuedAtMs: clock.now() })
      },
    })

    expect(() => service.set(TURN, { delayMs: 0, issuedAtMs: 0 })).not.toThrow()
    expect(exhausted).toBe(1)
    // The guard suppresses the nested *drain*, not the mutation itself: the
    // handler's re-arm still landed.
    expect(service.get(TURN)?.expired).toBe(false)
  })

  it('delivers an expiry already due when clear() removes the record', () => {
    // Live the scheduler had fired this at +30s. In replay nothing polls, so
    // without the drain `clear` deletes the record and swallows the timeout —
    // the same live/replay divergence, through a door the first fix missed.
    const h = harness({ specs: SPECS })
    h.service.set(TURN, { delayMs: 30_000 })
    h.clock.advance(31_000)

    h.service.clear(TURN)
    expect(h.expiries.map((expiry) => expiry.timerId)).toEqual([TURN])
    expect(h.service.get(TURN)).toBeUndefined()
  })

  it('clears at the issuing instant rather than the wall clock', () => {
    // `latenessMs` is measured against the mutation's `ctx.now`, so a replayed
    // clear has to produce the same expiry the live one did. Note this asserts
    // `clear`'s own drain: routing the same command through `apply` would be
    // covered by `apply`'s drain regardless, which is why it is not the test.
    const h = harness({ specs: SPECS })
    h.service.set(TURN, { delayMs: 30_000, issuedAtMs: 1_000_000 })
    h.clock.advance(60_000)

    h.service.clear(TURN, 1_031_000)
    expect(h.expiries).toHaveLength(1)
    expect(h.expiries[0]?.dueAtMs).toBe(1_030_000)
    expect(h.expiries[0]?.firedAtMs).toBe(1_031_000)
    expect(h.expiries[0]?.latenessMs).toBe(1_000)
  })

  it('threads the issuing instant through a clear command in apply', () => {
    const h = harness({ specs: SPECS })
    h.service.set(TURN, { delayMs: 30_000, issuedAtMs: 1_000_000 })
    h.clock.advance(60_000)

    h.service.apply([clearTimer(TURN)], 1_031_000)
    expect(h.expiries[0]?.firedAtMs).toBe(1_031_000)
    expect(h.service.get(TURN)).toBeUndefined()
  })

  it('delivers an expiry already due when declarePlayerClock is called', () => {
    const h = harness({ specs: SPECS })
    h.service.set(TURN, { delayMs: 30_000 })
    h.clock.advance(31_000)

    h.service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 300_000 })
    expect(h.expiries.map((expiry) => expiry.timerId)).toEqual([TURN])
  })

  it('declares a clock at the issuing instant rather than the wall clock', () => {
    const h = harness({ specs: SPECS })
    h.service.switchTurnTo(WHITE, 1_000_000)
    h.clock.advance(60_000)

    // Declared for the seat already on move, so it starts — anchored at the
    // instant passed, not at whenever the service got round to it.
    h.service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 300_000 }, 1_050_000)
    expect(h.service.isRunning(WHITE_CLOCK)).toBe(true)
    expect(h.service.remainingMs(WHITE_CLOCK)).toBe(290_000)
  })
})

describe('views and disposal', () => {
  it('renders the SDK’s TimerView shape', () => {
    const h = harness({ specs: SPECS })
    h.service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 300_000 })
    h.service.switchTurnTo(WHITE)
    h.clock.advance(1_500)

    expect(h.service.views()).toEqual([
      {
        timerId: 'clock:white',
        seatId: WHITE,
        kind: 'chess-clock',
        remainingMs: 298_500,
        isRunning: true,
      },
    ])
  })

  it('stops firing once disposed', () => {
    const h = harness()
    h.service.set(TURN, { delayMs: 1_000 })
    h.service.dispose()
    h.clock.advance(10_000)
    expect(h.service.poll()).toHaveLength(0)
    expect(h.service.list()).toHaveLength(0)
  })

  it('exposes the clock it was built with', () => {
    const h = harness({ startMs: 12_345 })
    expect(h.service.now).toBe(12_345)
  })
})
