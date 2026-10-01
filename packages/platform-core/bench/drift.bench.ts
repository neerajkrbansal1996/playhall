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
 * synchronises once and then free-runs for five minutes on its own hardware
 * clock, how far has its rendered remaining time wandered from the server's
 * authoritative remaining time?
 *
 * Three things are reported:
 *
 * - **client sync drift** — the headline number. A real round trip (with a
 *   deliberately asymmetric path, because mobile data is asymmetric) is used
 *   to estimate the offset, then the client never syncs again for five
 *   minutes. Sampled every second.
 * - **timer fire error** — a timer armed for exactly five minutes; how late
 *   did the event loop actually deliver it. This is jitter, not clock error:
 *   the budget is charged against the due time, not the delivery time.
 *   Reported because a room runner that fans out on this event needs to know.
 * - **server anchor drift** — the monotonic-anchored server clock against the
 *   host's wall clock, for information. Non-zero here is the host's NTP
 *   discipline, and is exactly what the anchoring is there to keep out of the
 *   players' clocks.
 *
 * The client is given a clock that is skewed by a constant 37 s from the
 * server's, so the offset estimator has genuine work to do rather than
 * measuring zero against zero.
 */

import { asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { expect, it } from 'vitest'
import type { Clock } from '../src/runtime.js'
import { realSystemClock } from '../test/fixtures/real-clock.js'
import { TimerService } from '../src/timers/service.js'
import { TimerSyncTracker } from '../src/timers/sync.js'

const RUN_MS = 5 * 60 * 1_000
const SAMPLE_INTERVAL_MS = 1_000
const DRIFT_BUDGET_MS = 100

/** Deliberately asymmetric: 4G uplink is slower than downlink. */
const UPLINK_MS = 45
const DOWNLINK_MS = 15
/** The client's hardware clock is 37 s fast. Nothing may depend on it. */
const CLIENT_SKEW_MS = 37_000

const MATCH = asMatchId('bench-match')
const SEAT = asSeatId('seat-a')
const PLAYER_CLOCK = asTimerId('clock:seat-a')
const MATCH_TIMER = asTimerId('match')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function skewedClock(base: Clock, skewMs: number): Clock {
  return { now: () => base.now() + skewMs }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] as number
}

it(
  `client-visible clock drift stays under ${DRIFT_BUDGET_MS} ms over 5 minutes`,
  async () => {
    const serverClock = realSystemClock()
    // A separate anchor, plus a constant skew: this is a different machine.
    const clientClock = skewedClock(realSystemClock(), CLIENT_SKEW_MS)

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

    // --- one real, asymmetric round trip, five times, then never again ------
    const tracker = new TimerSyncTracker({ clock: clientClock })
    for (let i = 0; i < 5; i += 1) {
      const requestedAtMs = clientClock.now()
      await sleep(UPLINK_MS)
      const frame = service.sync()
      await sleep(DOWNLINK_MS)
      tracker.applySync(frame, { requestedAtMs, receivedAtMs: clientClock.now() })
    }

    const estimate = tracker.serverTimeSync.estimate
    const syncedAtMs = serverClock.now()

    // --- free-run ----------------------------------------------------------
    const errors: number[] = []
    let sample = 0
    while (serverClock.now() - syncedAtMs < RUN_MS - SAMPLE_INTERVAL_MS) {
      sample += 1
      await sleep(SAMPLE_INTERVAL_MS)
      // Read both sides as close together as the runtime allows. The client
      // reads first so any gap counts *against* it.
      const clientRemaining =
        tracker.views().find((view) => view.timerId === PLAYER_CLOCK)?.remainingMs ?? 0
      const serverRemaining = service.remainingMs(PLAYER_CLOCK)
      errors.push(clientRemaining - serverRemaining)
    }

    const absolute = errors.map(Math.abs).sort((a, b) => a - b)
    const maxAbsMs = absolute[absolute.length - 1] ?? 0
    const p95Ms = percentile(absolute, 95)
    const finalMs = errors[errors.length - 1] ?? 0
    const meanMs = errors.reduce((sum, value) => sum + value, 0) / Math.max(1, errors.length)

    // The match timer should have fired by now; give the event loop a beat.
    await sleep(2_000)
    const fireError = fired as { dueAtMs: number; firedAtMs: number; latenessMs: number } | null

    const serverElapsed = serverClock.now() - startedAtMs
    const wallElapsed = new Date().getTime() - wallStartMs
    const anchorDriftMs = serverElapsed - wallElapsed

    console.log(
      [
        '',
        '=== PER-14 timer drift, 5 minutes ==================================',
        `samples                     ${sample} @ ${SAMPLE_INTERVAL_MS} ms`,
        `path                        ${UPLINK_MS} ms up / ${DOWNLINK_MS} ms down (asymmetric)`,
        `client clock skew           ${CLIENT_SKEW_MS} ms`,
        `estimated offset            ${estimate.offsetMs.toFixed(2)} ms (best rtt ${estimate.rttMs.toFixed(2)} ms)`,
        `offset estimation error     ${(estimate.offsetMs + CLIENT_SKEW_MS).toFixed(2)} ms`,
        '--------------------------------------------------------------------',
        `client sync drift  max|e|   ${maxAbsMs.toFixed(2)} ms   (budget ${DRIFT_BUDGET_MS} ms)`,
        `client sync drift  p95      ${p95Ms.toFixed(2)} ms`,
        `client sync drift  mean     ${meanMs.toFixed(2)} ms`,
        `client sync drift  final    ${finalMs.toFixed(2)} ms`,
        '--------------------------------------------------------------------',
        `5 min timer fired late by   ${fireError === null ? 'DID NOT FIRE' : `${fireError.latenessMs.toFixed(2)} ms`}`,
        `server anchor vs wall clock ${anchorDriftMs.toFixed(2)} ms over ${(wallElapsed / 1000).toFixed(1)} s`,
        '====================================================================',
        '',
      ].join('\n'),
    )

    service.dispose()

    expect(sample).toBeGreaterThan(250)
    expect(maxAbsMs).toBeLessThan(DRIFT_BUDGET_MS)
    expect(fireError).not.toBeNull()
  },
  RUN_MS + 120_000,
)
