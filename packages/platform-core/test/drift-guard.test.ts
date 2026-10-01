/**
 * A scaled-down version of the five-minute drift measurement, short enough to
 * run on every PR.
 *
 * The full run lives in `bench/drift.bench.ts` and takes five minutes; this one
 * takes five seconds. It is worth having both, because the two catch different
 * things: the long run measures the actual acceptance number, and this one
 * catches the regression that would make the long run fail — someone
 * reintroducing a countdown, or a second unsynchronised clock — before it
 * reaches a reviewer.
 *
 * Everything here is real: real system clocks on both sides, the real
 * `setTimeout` scheduler, real `await`s. That is the point.
 *
 * What five seconds cannot catch is clock *rate* error. The client below runs
 * 200 ppm fast, which over five seconds is 1 ms — below the noise, and
 * deliberately so: this file is not where that term is measured. It is measured
 * over five minutes in `bench/drift.bench.ts`, and exactly, at any match length,
 * in `free-run-budget.test.ts`. The rate is here only so that no clock in this
 * package's harnesses is a constant skew pretending to be a second machine;
 * see [PER-258](/PER/issues/PER-258) and `fixtures/real-clock.ts`.
 */
import { asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { ratedClock, realSystemClock } from './fixtures/real-clock.js'
import { TimerService } from '../src/timers/service.js'
import { TimerSyncTracker } from '../src/timers/sync.js'

const MATCH = asMatchId('guard')
const SEAT = asSeatId('a')
const CLOCK = asTimerId('clock:a')
const DRIFT_BUDGET_MS = 100

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('drift over a real, if short, run', () => {
  it('a client that synced once stays with the server for five seconds', async () => {
    const serverClock = realSystemClock()
    // A different machine: a day out on the wall clock and a 200 ppm crystal.
    const clientClock = ratedClock(realSystemClock(), { ppmFast: 200, skewMs: 86_400_000 })

    const service = new TimerService({ matchId: MATCH, clock: serverClock })
    service.declarePlayerClock(CLOCK, SEAT, { initialMs: 600_000 })
    service.switchTurnTo(SEAT)

    const tracker = new TimerSyncTracker({ clock: clientClock })
    for (let i = 0; i < 3; i += 1) {
      const requestedAtMs = clientClock.now()
      await sleep(5)
      const frame = service.sync()
      await sleep(5)
      tracker.applySync(frame, { requestedAtMs, receivedAtMs: clientClock.now() })
    }

    const errors: number[] = []
    for (let second = 0; second < 5; second += 1) {
      await sleep(1_000)
      const client = tracker.views().find((view) => view.timerId === CLOCK)?.remainingMs ?? 0
      errors.push(client - service.remainingMs(CLOCK))
    }
    service.dispose()

    const maxAbsMs = Math.max(...errors.map(Math.abs))
    expect(maxAbsMs).toBeLessThan(DRIFT_BUDGET_MS)

    // The property the long run depends on: error does not grow with the number
    // of samples taken. A local countdown would.
    //
    // This used to read `expect(abs(last)).toBeLessThanOrEqual(maxAbsMs)`, which
    // cannot fail — `last` is one of the values `maxAbsMs` is the maximum of. It
    // has to compare the last sample against the *first*. Over five seconds the
    // only legitimate growth is the client's 200 ppm crystal, which is 1 ms, so
    // the allowance here is sampling noise and nothing more.
    const growthMs = Math.abs(errors[errors.length - 1] as number) - Math.abs(errors[0] as number)
    expect(growthMs).toBeLessThan(10)
  }, 30_000)

  it('a two-second timer fires within a few ms of its deadline', async () => {
    const clock = realSystemClock()
    let fired: { dueAtMs: number; latenessMs: number } | null = null
    const service = new TimerService({
      matchId: MATCH,
      clock,
      onExpire: (expiry) => {
        fired = { dueAtMs: expiry.dueAtMs, latenessMs: expiry.latenessMs }
      },
    })

    const issuedAtMs = clock.now()
    service.set(asTimerId('turn'), { delayMs: 2_000, issuedAtMs })
    await sleep(2_300)
    service.dispose()

    const result = fired as { dueAtMs: number; latenessMs: number } | null
    expect(result).not.toBeNull()
    expect(result?.dueAtMs).toBe(issuedAtMs + 2_000)
    // Generous, because CI machines are busy. The number that matters is that
    // it is bounded, not that it is small: the budget was charged against
    // `dueAtMs` regardless.
    expect(Math.abs(result?.latenessMs ?? Infinity)).toBeLessThan(250)
  }, 30_000)
})
