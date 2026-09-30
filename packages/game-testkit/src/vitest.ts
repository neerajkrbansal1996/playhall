/**
 * Vitest binding.
 *
 * A game's whole conformance test file should be three lines:
 *
 * ```ts
 * import { describeTurnBasedConformance } from '@playhall/game-testkit/vitest'
 * import { manifest, server } from '../src/index.js'
 *
 * describeTurnBasedConformance({ manifest, server })
 * ```
 *
 * One `it` per check, so a failure names the property that broke rather than
 * dumping the whole report, and a skipped check shows up as skipped in the
 * CI output instead of silently passing.
 */

import { describe, expect, it } from 'vitest'
import type { GameEvent } from '@playhall/game-sdk'
import { runRealtimeConformance } from './realtime.js'
import { runTurnBasedConformance } from './turn-based.js'
import type { CheckResult, ConformanceReport } from './report.js'
import type { TurnBasedConformanceOptions, TurnBasedConformanceSubject } from './subject.js'

function renderFailures(check: CheckResult): string {
  return check.failures
    .map((failure) => {
      const parts = [failure.message]
      if (failure.where !== undefined) parts.push(`  at ${failure.where}`)
      if (failure.detail !== undefined) parts.push(`  ${failure.detail}`)
      return parts.join('\n')
    })
    .join('\n\n')
}

function declare(report: ConformanceReport): void {
  for (const check of report.checks) {
    if (check.status === 'skipped') {
      it.skip(`${check.id}: ${check.skipReason ?? 'skipped'}`, () => {
        /* reported by the runner */
      })
      continue
    }
    it(`${check.id} — ${check.title}`, () => {
      if (check.failures.length > 0) {
        throw new Error(
          `${check.failures.length} conformance failure(s) in '${check.id}':\n\n${renderFailures(check)}`,
        )
      }
      // A check that asserted nothing is not a passing check — it means the
      // suite never reached the code it was supposed to exercise.
      expect(check.assertions).toBeGreaterThan(0)
    })
  }
}

/**
 * Declares the full turn-based conformance suite for a game.
 *
 * The run happens once, eagerly, at collection time: the checks share
 * playouts, and re-running them per test case would multiply CI time by nine
 * for no extra coverage.
 */
export function describeTurnBasedConformance<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent = GameEvent,
  TErrorCode extends string = string,
>(
  subject: TurnBasedConformanceSubject<TState, TAction, TView, TSettings, TEvent, TErrorCode>,
  options: TurnBasedConformanceOptions = {},
): void {
  const report = runTurnBasedConformance(subject, options)
  describe(`conformance (turn-based): ${report.subject}`, () => {
    declare(report)
  })
}

/**
 * Declares the real-time conformance suite. Every check is skipped until M6
 * lands the netcode kit; wiring it in now means the gate turns on by itself.
 */
export function describeRealtimeConformance(subject: {
  readonly manifest: {
    readonly id: string
    readonly version: string
    readonly sdkContractVersion: number
  }
}): void {
  const report = runRealtimeConformance(subject)
  describe(`conformance (real-time): ${report.subject}`, () => {
    declare(report)
  })
}
