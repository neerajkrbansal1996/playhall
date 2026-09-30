/**
 * The three-line integration a game package actually writes.
 *
 * This file is also the documentation: if it ever needs more than the two
 * calls below, the binding has grown a sharp edge.
 */

import { describe, expect, it } from 'vitest'
import { describeRealtimeConformance, describeTurnBasedConformance } from '../src/vitest.js'
import { REALTIME_CHECK_SPECS, runRealtimeConformance } from '../src/index.js'
import { ticTacToeSubject } from './subjects.js'

describeTurnBasedConformance(ticTacToeSubject, { playoutsPerVariant: 4 })

describeRealtimeConformance({
  manifest: { id: 'tic-tac-toe', version: '1.0.0', sdkContractVersion: 1 },
})

describe('real-time conformance stubs', () => {
  const report = runRealtimeConformance({
    manifest: { id: 'prop-hunt', version: '0.0.0', sdkContractVersion: 1 },
  })

  it('declares every M6 check with an acceptance condition', () => {
    expect(report.checks).toHaveLength(REALTIME_CHECK_SPECS.length)
    for (const check of report.checks) {
      expect(check.status).toBe('skipped')
      expect(check.skipReason).toContain('M6')
      expect(check.notes.join(' ')).toContain('acceptance:')
    }
  })

  it('does not report a false pass while the checks are stubs', () => {
    // `passed` is true because nothing failed, but every check says skipped —
    // which is the honest signal, and it flips the moment M6 implements one.
    expect(report.passed).toBe(true)
    expect(report.checks.every((check) => check.status === 'skipped')).toBe(true)
  })

  it('pins the numbers M6 has to hit', () => {
    const specs = Object.fromEntries(REALTIME_CHECK_SPECS.map((spec) => [spec.id, spec.acceptance]))
    expect(specs['tick-budget']).toContain('30 Hz')
    expect(specs['tick-budget']).toContain('5 ms p99')
    expect(specs['tick-budget']).toContain('30 KB/s')
    expect(specs['bot-swarm-soak']).toContain('150 ms RTT')
    expect(specs['bot-swarm-soak']).toContain('30 ms jitter')
    expect(specs['bot-swarm-soak']).toContain('2% packet loss')
    expect(specs['bot-swarm-soak']).toContain('10 minutes')
    expect(specs['snapshot-leak']).toContain('getSnapshotFor')
    expect(specs['reconnect-restores-role-and-position']).toContain('position')
  })
})
