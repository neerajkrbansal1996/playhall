/**
 * How long a client may free-run before its rendered clock leaves the 100 ms
 * budget, and why the keepalive re-sync is a correctness requirement rather
 * than a nicety.
 *
 * ## Why this file exists at all
 *
 * `bench/drift.bench.ts` is the acceptance artefact for the five-minute number,
 * and `drift-guard.test.ts` is its five-second sibling. Neither can answer the
 * question a reviewer actually has — *what happens over a thirty-minute chess
 * match?* — because both pay their duration in wall time, and nobody runs a
 * thirty-minute test.
 *
 * The term that makes a long run different from a short one is the client
 * clock's **rate** error, and rate error is perfectly linear. So it can be
 * measured exactly against a `fixedClock` the test advances by hand, at any
 * match length, in microseconds. The numbers below are not approximations of
 * the bench's: they are the same quantity computed without the sampling noise,
 * and the bench's 0 ppm control is what ties the two harnesses together.
 *
 * Filed from [PER-258](/PER/issues/PER-258). QA's finding was that a bench
 * built from two `realSystemClock()`s cannot vary this term at all — one
 * process has one oscillator — so five minutes measured exactly what five
 * seconds measured. See `fixtures/real-clock.ts`.
 *
 * ## The error model, which every assertion here pins
 *
 *     free-run error = offsetEstimationError + elapsedSinceSync x rate
 *                    = (UPLINK - DOWNLINK) / 2 + t_ms x ppm / 1e6
 *
 * The first term is the path asymmetry the midpoint estimator cannot cancel; it
 * is constant, and it is the *whole* of what the old bench measured. The second
 * is unbounded in `t` — which is the entire point.
 */

import { asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { fixedClock } from '../src/runtime.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { TimerService } from '../src/timers/service.js'
import { TimerSyncTracker } from '../src/timers/sync.js'
import { ratedClock } from './fixtures/real-clock.js'

const MATCH = asMatchId('free-run')
const SEAT = asSeatId('a')
const CLOCK = asTimerId('clock:a')

const T0 = 1_700_000_000_000
const DRIFT_BUDGET_MS = 100

/** The same asymmetric 4G path the bench uses, so the numbers are comparable. */
const UPLINK_MS = 45
const DOWNLINK_MS = 15
/** `(45 - 15) / 2`: what a midpoint estimator cannot recover from asymmetry. */
const ASYMMETRY_ERROR_MS = (UPLINK_MS - DOWNLINK_MS) / 2
/** The client's hardware clock is 37 s out. Nothing may depend on it. */
const CLIENT_SKEW_MS = 37_000

/**
 * A budget large enough that nothing expires inside the longest run here, so
 * every number is clock error and never a clamp at zero.
 */
const PLAYER_BUDGET_MS = 4 * 60 * 60_000

const FIVE_MINUTES_MS = 5 * 60_000
/** A classical chess game at 30+0 — the case that motivated PER-258 §3. */
const CHESS_MATCH_MS = 30 * 60_000

/** `sync.ts`: `SAMPLE_WINDOW`. Not exported; pinned by assertion below. */
const SAMPLE_WINDOW = 8
const KEEPALIVE_INTERVAL_MS = 4_000

interface Harness {
  /** Error in the client's rendered remaining time, signed. Negative = short. */
  elapseAndMeasure(ms: number): number
  readonly offsetErrorMs: number
  dispose(): void
}

/**
 * One server, one client whose crystal runs `ppmFast` fast, and an asymmetric
 * path. `keepalive` re-syncs every 4 s while time passes; without it the client
 * syncs once and never again.
 */
function harness(options: { ppmFast: number; keepalive?: boolean }): Harness {
  const serverClock = fixedClock(T0)
  // The client's host oscillator. `ratedClock` reports a *different rate* off
  // it, which is the one thing a single-process harness cannot get for free.
  const clientBase = fixedClock(T0)
  const clientClock = ratedClock(clientBase, {
    ppmFast: options.ppmFast,
    skewMs: CLIENT_SKEW_MS,
  })

  const service = new TimerService({
    matchId: MATCH,
    clock: serverClock,
    scheduler: createManualScheduler(),
  })
  const tracker = new TimerSyncTracker({ clock: clientClock })

  service.declarePlayerClock(CLOCK, SEAT, { initialMs: PLAYER_BUDGET_MS })
  service.switchTurnTo(SEAT)

  /** One real round trip over the asymmetric path. Both sides advance. */
  function exchange(): void {
    const requestedAtMs = clientClock.now()
    serverClock.advance(UPLINK_MS)
    clientBase.advance(UPLINK_MS)
    const frame = service.sync()
    serverClock.advance(DOWNLINK_MS)
    clientBase.advance(DOWNLINK_MS)
    tracker.applySync(frame, { requestedAtMs, receivedAtMs: clientClock.now() })
  }

  exchange()
  const offsetErrorMs = tracker.serverTimeSync.estimate.offsetMs + CLIENT_SKEW_MS

  function advance(ms: number): void {
    serverClock.advance(ms)
    clientBase.advance(ms)
  }

  return {
    offsetErrorMs,
    elapseAndMeasure(ms: number): number {
      if (options.keepalive === true) {
        // Each exchange costs a round trip of wall time, so charge it against
        // the interval rather than on top of it.
        const step = KEEPALIVE_INTERVAL_MS - UPLINK_MS - DOWNLINK_MS
        for (let spent = 0; spent + KEEPALIVE_INTERVAL_MS <= ms; spent += KEEPALIVE_INTERVAL_MS) {
          advance(step)
          exchange()
        }
        advance(ms % KEEPALIVE_INTERVAL_MS)
      } else {
        advance(ms)
      }
      const client = tracker.views().find((view) => view.timerId === CLOCK)?.remainingMs ?? 0
      return client - service.remainingMs(CLOCK)
    },
    dispose: () => service.dispose(),
  }
}

/** The model this file is pinning. Positive ms of client-visible error. */
function predicted(ppmFast: number, elapsedMs: number): number {
  return ASYMMETRY_ERROR_MS + (elapsedMs * ppmFast) / 1_000_000
}

/**
 * The model is exact; the only slack is the `Math.round` in `views()`. One
 * millisecond, stated rather than hidden behind a `toBeCloseTo` precision.
 */
function expectWithinMs(actualMs: number, expectedMs: number, toleranceMs = 1): void {
  expect(Math.abs(actualMs - expectedMs)).toBeLessThanOrEqual(toleranceMs)
}

describe('the harness can see a clock rate at all', () => {
  it('a constant skew contributes nothing that grows with time', () => {
    // The defect PER-258 found, pinned so it cannot come back: this is what
    // `skewedClock(realSystemClock(), k)` amounts to, and its divergence from
    // the server is the same at t = 1 s and at t = 5 min.
    const base = fixedClock(T0)
    const skewed = { now: () => base.now() + CLIENT_SKEW_MS }

    const atStart = skewed.now() - base.now()
    base.advance(FIVE_MINUTES_MS)
    const atEnd = skewed.now() - base.now()

    expect(atEnd - atStart).toBe(0)
  })

  it('a rated clock diverges by exactly ppm x elapsed', () => {
    const base = fixedClock(T0)
    const rated = ratedClock(base, { ppmFast: 200, skewMs: CLIENT_SKEW_MS })

    const atStart = rated.now() - base.now()
    base.advance(FIVE_MINUTES_MS)
    const atEnd = rated.now() - base.now()

    // 200 ppm over 300 s is 60 ms, and nothing about the constant skew moved.
    expect(atStart).toBe(CLIENT_SKEW_MS)
    expect(atEnd - atStart).toBe(60)
  })
})

describe('free-run error, measured exactly', () => {
  it('is the path asymmetry alone when the rates match', () => {
    const run = harness({ ppmFast: 0 })
    // The control. This is the figure the five-minute bench reports, and the
    // figure a zero-rate harness is *capable* of reporting — nothing else.
    expect(run.offsetErrorMs).toBe(ASYMMETRY_ERROR_MS)
    expect(run.elapseAndMeasure(FIVE_MINUTES_MS)).toBe(-ASYMMETRY_ERROR_MS)
    run.dispose()
  })

  it.each([
    { ppmFast: 50, label: 'typical' },
    { ppmFast: 100, label: 'cheap or hot' },
    { ppmFast: 200, label: 'worst realistic' },
  ])('tracks ppm x elapsed at $ppmFast ppm ($label)', ({ ppmFast }) => {
    const run = harness({ ppmFast })
    const errorMs = run.elapseAndMeasure(FIVE_MINUTES_MS)

    expectWithinMs(Math.abs(errorMs), predicted(ppmFast, FIVE_MINUTES_MS))
    // The client renders *less* time than the server has: its clock believes
    // more has elapsed than really has.
    expect(errorMs).toBeLessThan(0)
    // AC3 holds at every rate — five minutes is comfortably inside budget.
    expect(Math.abs(errorMs)).toBeLessThan(DRIFT_BUDGET_MS)
    run.dispose()
  })
})

describe('a chess match is longer than its free-run budget', () => {
  it('leaves the 100 ms budget before a 30-minute game ends, on typical hardware', () => {
    // The actionable number from PER-258 §3. This is a *characterisation*, not
    // a failing requirement: it is the reason the keepalive below is required.
    // 50 ppm is a typical phone, not a worst case, and the budget is spent at
    // ~28 min.
    const run = harness({ ppmFast: 50 })
    const errorMs = run.elapseAndMeasure(CHESS_MATCH_MS)

    expect(Math.abs(errorMs)).toBeGreaterThan(DRIFT_BUDGET_MS)
    expectWithinMs(Math.abs(errorMs), predicted(50, CHESS_MATCH_MS))
    run.dispose()
  })

  it('stays inside it for the whole match once the keepalive re-syncs', () => {
    // The requirement. If someone drops the 4 s re-sync from the client wiring,
    // this is the test that says why they cannot.
    const run = harness({ ppmFast: 200, keepalive: true })
    const errorMs = run.elapseAndMeasure(CHESS_MATCH_MS)

    expect(Math.abs(errorMs)).toBeLessThan(DRIFT_BUDGET_MS)
    // And by a wide margin: bounded by the window, not by the match.
    expect(Math.abs(errorMs)).toBeLessThan(DRIFT_BUDGET_MS / 2)
    run.dispose()
  })

  it('bounds the keepalive error by the sample window, not by match length', () => {
    // The property that makes the previous test hold for *any* match length:
    // doubling the match does not move the number, because the offset is only
    // ever as stale as the window is deep.
    const short = harness({ ppmFast: 200, keepalive: true })
    const long = harness({ ppmFast: 200, keepalive: true })

    const shortMs = short.elapseAndMeasure(CHESS_MATCH_MS)
    const longMs = long.elapseAndMeasure(2 * CHESS_MATCH_MS)
    expect(longMs).toBe(shortMs)

    // Where that bound comes from: `ServerTimeSync` keeps the minimum-RTT
    // sample over an 8-deep window and breaks ties on the *oldest*, so under a
    // constant path the anchor is always the far end of the window — up to
    // seven intervals, ~28 s, old. Rate error accrues uncorrected across that
    // staleness and no further.
    const stalenessMs = (SAMPLE_WINDOW - 1) * KEEPALIVE_INTERVAL_MS
    expectWithinMs(Math.abs(shortMs), predicted(200, stalenessMs))

    short.dispose()
    long.dispose()
  })
})
