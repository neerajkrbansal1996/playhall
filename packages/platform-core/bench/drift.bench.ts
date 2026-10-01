/**
 * The five-minute drift measurement. This is the acceptance evidence for
 * PER-14, not a unit test, and it is kept out of the default `vitest run`
 * because it costs five minutes of wall time.
 *
 *     pnpm --filter @playhall/platform-core bench:drift
 *
 * ## What is actually being measured
 *
 * The number the issue asks for is **client-visible** drift: after a client
 * synchronises and then runs for five minutes on its own hardware clock, how
 * far has its rendered remaining time wandered from the server's authoritative
 * remaining time?
 *
 * Client-visible error has exactly two terms:
 *
 *     error = offsetEstimationError + elapsedSinceSync x clientClockRate
 *           = (UPLINK - DOWNLINK) / 2 + t_ms x ppm / 1e6
 *
 * The first is the path asymmetry a midpoint estimator cannot cancel. It is
 * **constant**, so a run of any length reports it unchanged. The second is the
 * one that needs five minutes to show up, and it is the one an earlier version
 * of this bench could not produce: it built the client as
 * `skewedClock(realSystemClock(), 37_000)` against a server
 * `realSystemClock()`, and one process has one oscillator — two readings of the
 * same `performance.now()` have a rate ratio of identically 1.0, and a constant
 * skew does not grow. So `max == p95 == |final| == 14.00 ms` every run, five
 * minutes measured exactly what five seconds measured, and the assertion could
 * not fail for the reason AC3 exists. QA caught that in
 * [PER-258](/PER/issues/PER-258); `ratedClock` is the fix.
 *
 * ## The arms
 *
 * Five clients against one `TimerService`, so all five share one five-minute
 * window rather than costing twenty-five minutes:
 *
 * - **free-run at 0 ppm** — the control, and the tie back to the old number.
 *   Whatever this reports is asymmetry and sampling noise, nothing else.
 * - **free-run at 50 / 100 / 200 ppm** — a typical phone crystal, a cheap or
 *   hot one, and about the worst a working handset shows. Sync once, then never
 *   again: the worst case the design has to survive.
 * - **keepalive at 200 ppm** — the same worst-case hardware with the 4 s
 *   re-sync `sync.ts` describes, which is what a wired client will actually do.
 *   This is the arm that shows the re-sync is load-bearing rather than cosmetic.
 *
 * Also reported, unchanged:
 *
 * - **timer fire error** — a timer armed for exactly five minutes; how late the
 *   event loop actually delivered it. Jitter, not clock error: the budget is
 *   charged against the due time, not the delivery time. Reported because a
 *   room runner that fans out on this event needs to know.
 * - **server anchor drift** — the monotonic-anchored server clock against the
 *   host's wall clock, for information. Non-zero here is the host's NTP
 *   discipline, and is exactly what the anchoring keeps out of players' clocks.
 *
 * ## What this harness is not
 *
 * In-process. No browser, no socket, no device, and the clock rate is
 * *simulated* — both sides still share one oscillator and `ratedClock` makes
 * one of them report as though they did not. The exact, zero-wall-time version
 * of the same model, extended to a 30-minute match, is
 * `test/free-run-budget.test.ts`; this bench is where the real event loop, real
 * `setTimeout` and real `await`s get a say.
 */

import { asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { expect, it } from 'vitest'
import type { Clock } from '../src/runtime.js'
import { ratedClock, realSystemClock } from '../test/fixtures/real-clock.js'
import { TimerService } from '../src/timers/service.js'
import { TimerSyncTracker } from '../src/timers/sync.js'

const RUN_MS = 5 * 60 * 1_000
const SAMPLE_INTERVAL_MS = 1_000
const DRIFT_BUDGET_MS = 100

/** Deliberately asymmetric: 4G uplink is slower than downlink. */
const UPLINK_MS = 45
const DOWNLINK_MS = 15
/** `(45 - 15) / 2`: the irreducible term. Every arm pays this. */
const ASYMMETRY_ERROR_MS = (UPLINK_MS - DOWNLINK_MS) / 2
/** The client's hardware clock is 37 s fast. Nothing may depend on it. */
const CLIENT_SKEW_MS = 37_000
/** `sync.ts` sizes its sample window for a keepalive at this interval. */
const KEEPALIVE_INTERVAL_MS = 4_000
/** The window is 8 deep, so the anchor can be seven intervals old. */
const KEEPALIVE_STALENESS_MS = 7 * KEEPALIVE_INTERVAL_MS

const MATCH = asMatchId('bench-match')
const SEAT = asSeatId('seat-a')
const PLAYER_CLOCK = asTimerId('clock:seat-a')
const MATCH_TIMER = asTimerId('match')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] as number
}

/**
 * Jitter for the keepalive arm's path, so its round trips are not all identical
 * and the minimum-RTT filter has something to filter. Seeded, because a bench
 * whose numbers move between runs for reasons unrelated to the code under test
 * is not evidence.
 *
 * **Additive only.** Queueing delay cannot make a packet beat the path's floor,
 * and that is precisely the premise `sync.ts` relies on when it keeps the
 * shortest round trip. A signed jitter breaks it — there is then no floor for
 * the filter to find, the best sample's asymmetry is whatever the draw happened
 * to be rather than the true `(UPLINK - DOWNLINK) / 2`, and the keepalive arm
 * measures 40 ms against a 20.6 ms model for a reason that is in the harness and
 * not in the code under test. Measured, with `(state % 60) - 10`, before this
 * comment existed.
 */
function seededJitter(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff
    return state % 40
  }
}

interface Arm {
  readonly label: string
  readonly ppmFast: number
  /** Re-sync every `KEEPALIVE_INTERVAL_MS`, instead of syncing once. */
  readonly keepalive: boolean
  readonly clock: Clock
  readonly tracker: TimerSyncTracker
  readonly errors: number[]
  lastSyncAtMs: number
  syncCount: number
}

interface ArmResult {
  readonly label: string
  readonly ppmFast: number
  readonly keepalive: boolean
  readonly offsetErrorMs: number
  readonly firstMs: number
  readonly finalMs: number
  readonly meanMs: number
  readonly p95Ms: number
  readonly maxAbsMs: number
  readonly predictedMs: number
  readonly syncCount: number
}

it(
  `client-visible clock drift stays under ${DRIFT_BUDGET_MS} ms over 5 minutes`,
  async () => {
    const serverClock = realSystemClock()

    let fired: { dueAtMs: number; firedAtMs: number; latenessMs: number } | null = null
    const service = new TimerService({
      matchId: MATCH,
      clock: serverClock,
      onExpire: (expiry) => {
        if (expiry.timerId === MATCH_TIMER) fired = expiry
      },
    })

    const startedAtMs = serverClock.now()
    const wallStartMs = new Date().getTime()

    // A 30-minute player clock, running for the whole measurement, and a match
    // timer armed for exactly the length of the run.
    service.declarePlayerClock(PLAYER_CLOCK, SEAT, { initialMs: 30 * 60_000, incrementMs: 0 })
    service.switchTurnTo(SEAT, startedAtMs)
    service.set(MATCH_TIMER, { delayMs: RUN_MS, kind: 'match', issuedAtMs: startedAtMs })

    const arms: Arm[] = [
      { label: 'free-run     0 ppm (control)', ppmFast: 0, keepalive: false },
      { label: 'free-run    50 ppm (typical)', ppmFast: 50, keepalive: false },
      { label: 'free-run   100 ppm (cheap)', ppmFast: 100, keepalive: false },
      { label: 'free-run   200 ppm (worst)', ppmFast: 200, keepalive: false },
      { label: 'keepalive  200 ppm + jitter', ppmFast: 200, keepalive: true },
    ].map((spec) => {
      // Each arm is a different handset: its own anchor, its own crystal, and
      // the same 37 s of wall-clock nonsense on top.
      const clock = ratedClock(realSystemClock(), {
        ppmFast: spec.ppmFast,
        skewMs: CLIENT_SKEW_MS,
      })
      return {
        ...spec,
        clock,
        tracker: new TimerSyncTracker({ clock }),
        errors: [] as number[],
        lastSyncAtMs: 0,
        syncCount: 0,
      }
    })

    const jitter = seededJitter(0x5eed)

    /** One real, asymmetric round trip for one arm. */
    async function exchange(arm: Arm, jittered: boolean): Promise<void> {
      const upMs = jittered ? UPLINK_MS + jitter() : UPLINK_MS
      const downMs = jittered ? DOWNLINK_MS + jitter() : DOWNLINK_MS
      const requestedAtMs = arm.clock.now()
      await sleep(upMs)
      const frame = service.sync()
      await sleep(downMs)
      arm.tracker.applySync(frame, { requestedAtMs, receivedAtMs: arm.clock.now() })
      arm.lastSyncAtMs = serverClock.now()
      arm.syncCount += 1
    }

    // --- every arm syncs five times up front -------------------------------
    for (const arm of arms) {
      for (let i = 0; i < 5; i += 1) await exchange(arm, false)
    }

    const offsetErrors = new Map(
      arms.map((arm) => [arm.label, arm.tracker.serverTimeSync.estimate.offsetMs + CLIENT_SKEW_MS]),
    )
    const syncedAtMs = serverClock.now()

    // --- run ---------------------------------------------------------------
    // Free-run arms never sync again. The keepalive arm re-syncs every 4 s,
    // which is the only difference between it and the 200 ppm free-run arm.
    let sample = 0
    while (serverClock.now() - syncedAtMs < RUN_MS - SAMPLE_INTERVAL_MS) {
      sample += 1
      await sleep(SAMPLE_INTERVAL_MS)

      for (const arm of arms) {
        if (arm.keepalive && serverClock.now() - arm.lastSyncAtMs >= KEEPALIVE_INTERVAL_MS) {
          await exchange(arm, true)
        }
      }

      // Read every client before the server, so any gap counts *against* the
      // clients. One server reading for all five arms keeps them comparable.
      const clientRemaining = arms.map(
        (arm) =>
          arm.tracker.views().find((view) => view.timerId === PLAYER_CLOCK)?.remainingMs ?? 0,
      )
      const serverRemaining = service.remainingMs(PLAYER_CLOCK)
      arms.forEach((arm, index) => {
        arm.errors.push((clientRemaining[index] as number) - serverRemaining)
      })
    }

    const elapsedMs = serverClock.now() - syncedAtMs
    const results: ArmResult[] = arms.map((arm) => {
      const absolute = arm.errors.map(Math.abs).sort((a, b) => a - b)
      // A keepalive arm is never stale for longer than its sample window, so its
      // prediction is the window's span, not the whole run.
      //
      // For a free-run arm this prediction is the whole error and lands within
      // a millisecond. For the keepalive arm it is a **floor**: it assumes the
      // winning sample sat on the unjittered path, and under jitter the best
      // sample in a given window is often only the least-queued one rather than
      // an unqueued one. Its asymmetry is then worse than `(45 - 15) / 2`, which
      // is why the measured max runs ~10 ms above the model. Minimum RTT does
      // not minimise asymmetry; it only correlates with it.
      const staleMs = arm.keepalive ? KEEPALIVE_STALENESS_MS : elapsedMs
      return {
        label: arm.label,
        ppmFast: arm.ppmFast,
        keepalive: arm.keepalive,
        offsetErrorMs: offsetErrors.get(arm.label) ?? 0,
        firstMs: arm.errors[0] ?? 0,
        finalMs: arm.errors[arm.errors.length - 1] ?? 0,
        meanMs: arm.errors.reduce((sum, value) => sum + value, 0) / Math.max(1, arm.errors.length),
        p95Ms: percentile(absolute, 95),
        maxAbsMs: absolute[absolute.length - 1] ?? 0,
        predictedMs: ASYMMETRY_ERROR_MS + (staleMs * arm.ppmFast) / 1_000_000,
        syncCount: arm.syncCount,
      }
    })

    const control = results[0] as ArmResult
    const freeRun200 = results[3] as ArmResult
    const keepalive200 = results[4] as ArmResult

    // The match timer should have fired by now; give the event loop a beat.
    await sleep(2_000)
    const fireError = fired as { dueAtMs: number; firedAtMs: number; latenessMs: number } | null

    const serverElapsed = serverClock.now() - startedAtMs
    const wallElapsed = new Date().getTime() - wallStartMs
    const anchorDriftMs = serverElapsed - wallElapsed

    const pad = (value: number, width: number): string => value.toFixed(1).padStart(width)
    console.log(
      [
        '',
        '=== PER-14 timer drift, 5 minutes ==================================',
        `samples                     ${sample} @ ${SAMPLE_INTERVAL_MS} ms over ${(elapsedMs / 1000).toFixed(1)} s`,
        `path                        ${UPLINK_MS} ms up / ${DOWNLINK_MS} ms down (asymmetric)`,
        `client clock skew           ${CLIENT_SKEW_MS} ms, constant, on every arm`,
        `budget                      ${DRIFT_BUDGET_MS} ms`,
        '--------------------------------------------------------------------',
        'arm                           syncs  off.err  first  final    p95  max|e|  predicted',
        '                              (predicted is exact for free-run, a floor for keepalive)',
        ...results.map((arm) =>
          [
            arm.label.padEnd(30),
            String(arm.syncCount).padStart(4),
            pad(arm.offsetErrorMs, 9),
            pad(arm.firstMs, 7),
            pad(arm.finalMs, 7),
            pad(arm.p95Ms, 6),
            pad(arm.maxAbsMs, 7),
            pad(arm.predictedMs, 10),
          ].join(''),
        ),
        '--------------------------------------------------------------------',
        `rate error is visible       ${pad(Math.abs(freeRun200.finalMs) - Math.abs(control.finalMs), 6)} ms of the 200 ppm arm's error that the control does not have`,
        `keepalive buys              ${pad(freeRun200.maxAbsMs - keepalive200.maxAbsMs, 6)} ms at the same 200 ppm`,
        '--------------------------------------------------------------------',
        'free-run budget exhausted at (error = 15 + ppm x t):',
        ...[50, 100, 200].map(
          (ppm) =>
            `  ${String(ppm).padStart(3)} ppm                      ${(((DRIFT_BUDGET_MS - ASYMMETRY_ERROR_MS) * 1_000_000) / ppm / 60_000).toFixed(0).padStart(2)} min`,
        ),
        '  a classical chess game is longer than all three: see the keepalive arm',
        '--------------------------------------------------------------------',
        `5 min timer fired late by   ${fireError === null ? 'DID NOT FIRE' : `${fireError.latenessMs.toFixed(2)} ms`}`,
        `server anchor vs wall clock ${anchorDriftMs.toFixed(2)} ms over ${(wallElapsed / 1000).toFixed(1)} s`,
        '====================================================================',
        '',
      ].join('\n'),
    )

    service.dispose()

    expect(sample).toBeGreaterThan(250)

    // AC3, at every rate including the worst realistic hardware with no
    // re-sync. This is the acceptance number.
    for (const arm of results) {
      expect(arm.maxAbsMs, `${arm.label} max|e|`).toBeLessThan(DRIFT_BUDGET_MS)
    }

    // The control measures asymmetry and nothing else, which is what ties this
    // harness to `test/free-run-budget.test.ts` and to the pre-PER-258 number.
    expect(Math.abs(control.finalMs)).toBeLessThan(ASYMMETRY_ERROR_MS + 10)

    // The bench can now see a clock rate. On the old harness this difference
    // was structurally zero, which is the whole of what PER-258 reported:
    // 200 ppm over five minutes is 60 ms the control does not pay.
    expect(Math.abs(freeRun200.finalMs) - Math.abs(control.finalMs)).toBeGreaterThan(40)

    // Each free-run arm tracks `ppm x elapsed`. Loose enough for a busy CI box,
    // tight enough that a rate which is not actually applied fails.
    for (const arm of results) {
      if (arm.keepalive || arm.ppmFast === 0) continue
      expect(Math.abs(arm.finalMs), `${arm.label} vs model`).toBeGreaterThan(arm.predictedMs - 15)
      expect(Math.abs(arm.finalMs), `${arm.label} vs model`).toBeLessThan(arm.predictedMs + 15)
    }

    // The keepalive is load-bearing, not cosmetic: same hardware, same path,
    // bounded by the sample window instead of by match length.
    expect(keepalive200.syncCount).toBeGreaterThan(50)
    expect(keepalive200.maxAbsMs).toBeLessThan(freeRun200.maxAbsMs - 20)

    expect(fireError).not.toBeNull()
  },
  RUN_MS + 180_000,
)
