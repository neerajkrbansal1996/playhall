/**
 * Real-time conformance — declared now, implemented in M6.
 *
 * The real-time netcode kit is M6 and board-gated, so none of these checks
 * can run yet. They are declared here anyway, with their acceptance numbers
 * written down, for two reasons:
 *
 *   1. the numbers are a design constraint on work happening *now*. A state
 *      shape or a protocol that cannot meet `tick-budget` at 30 Hz has to be
 *      changed in M1, not discovered in M6.
 *   2. a stub that reports `skipped` with a reason is honest. A missing check
 *      silently reads as "real-time is fine".
 *
 * Each returns `skipped` until M6 fills it in. `runRealtimeConformance` never
 * reports `passed: false` for a skip, so it is safe to wire into CI today and
 * it will start biting the moment the kit lands.
 */

import { SDK_VERSION } from '@playhall/game-sdk'
import {
  type CheckResult,
  type ConformanceReport,
  type RealtimeCheck,
  CheckRecorder,
} from './report.js'

export interface RealtimeCheckSpec {
  readonly id: RealtimeCheck
  readonly title: string
  /** The acceptance condition M6 has to implement, in one sentence. */
  readonly acceptance: string
}

export const REALTIME_CHECK_SPECS: readonly RealtimeCheckSpec[] = Object.freeze([
  {
    id: 'tick-budget',
    title: 'Server tick stays inside its budget',
    acceptance:
      'a full room at maxPlayers ticks at 30 Hz with tick time < 5 ms p99, measured over 10 minutes, and sends < 30 KB/s down per client.',
  },
  {
    id: 'snapshot-leak',
    title: 'getSnapshotFor leaks no hidden information',
    acceptance:
      'the turn-based leak fuzzer, re-pointed at getSnapshotFor and the binary codec: no declared secret reaches a viewer that is not entitled to it, decoded from the wire bytes rather than from the object.',
  },
  {
    id: 'bot-swarm-soak',
    title: 'Headless bot swarm survives a hostile network',
    acceptance:
      'maxPlayers headless bots play for 10 minutes under 150 ms RTT, 30 ms jitter and 2% packet loss with no desync, no unbounded queue growth and no room left alive at the end.',
  },
  {
    id: 'reconnect-restores-role-and-position',
    title: 'Reconnect restores role and position',
    acceptance:
      'a client dropped mid-match and reconnected is restored to the same seat, role and world position, and its first snapshot equals the authoritative world state at that tick.',
  },
])

export const REALTIME_SKIP_REASON =
  'real-time conformance lands with the netcode kit in M6, which is board-gated. See REALTIME_CHECK_SPECS for the acceptance numbers.'

/**
 * Runs the real-time suite. Every check reports `skipped` until M6.
 *
 * `subject` is deliberately untyped for now: the real-time server contract
 * exists in the SDK, but pinning the harness shape before the kit is built
 * would be guessing.
 */
export function runRealtimeConformance(subject: {
  readonly manifest: {
    readonly id: string
    readonly version: string
    readonly sdkContractVersion: number
  }
}): ConformanceReport {
  const checks: CheckResult[] = REALTIME_CHECK_SPECS.map((spec) => {
    const recorder = new CheckRecorder(spec.id, spec.title)
    recorder.note(`acceptance: ${spec.acceptance}`)
    recorder.skip(REALTIME_SKIP_REASON)
    return recorder.finish()
  })

  return {
    kind: 'realtime',
    subject: `${subject.manifest.id}@${subject.manifest.version}`,
    sdkVersion: SDK_VERSION,
    sdkContractVersion: subject.manifest.sdkContractVersion,
    seeds: [],
    checks,
    passed: true,
  }
}
