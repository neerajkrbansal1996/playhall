/**
 * The suite run against two games that should pass it.
 *
 * Tic-tac-toe is the perfect-information case and the game PER-18 ships.
 * Hidden Hand is the hidden-information case, and it is the only one of the
 * two that can exercise the leak fuzzer at all.
 */

import { describe, expect, it } from 'vitest'
import { formatReport, runTurnBasedConformance } from '../src/index.js'
import { hiddenHandSubject } from '../src/reference/index.js'
import { ticTacToeSubject } from './subjects.js'

describe('turn-based conformance: tic-tac-toe', () => {
  const report = runTurnBasedConformance(ticTacToeSubject)

  it('passes every check', () => {
    expect(formatReport(report)).toContain('PASS')
    expect(report.passed).toBe(true)
  })

  it('runs every declared check, with none vacuous', () => {
    for (const check of report.checks) {
      expect.soft(check.status, `${check.id}: ${JSON.stringify(check.failures)}`).toBe('passed')
      expect.soft(check.assertions, `${check.id} asserted nothing`).toBeGreaterThan(0)
    }
    expect(report.checks).toHaveLength(9)
  })

  it('records the seeds it used, so a failure is reproducible', () => {
    expect(report.seeds.length).toBeGreaterThan(0)
    expect(new Set(report.seeds).size).toBe(report.seeds.length)
  })

  it('produces an identical report on a second run', () => {
    const again = runTurnBasedConformance(ticTacToeSubject)
    expect(formatReport(again)).toBe(formatReport(report))
  })

  it('actually plays games out rather than conceding immediately', () => {
    const terminates = report.checks.find((check) => check.id === 'random-playout-terminates')
    // 9 cells; the longest playout should reach a full or nearly full board.
    expect(terminates?.notes.join(' ')).toMatch(/longest playout: [89] steps/)
  })
})

describe('turn-based conformance: hidden-hand (the reference game with secrets)', () => {
  const report = runTurnBasedConformance(hiddenHandSubject, { playoutsPerVariant: 8 })

  it('passes every check', () => {
    for (const check of report.checks) {
      expect
        .soft(check.status, `${check.id}: ${JSON.stringify(check.failures, null, 2)}`)
        .toBe('passed')
    }
    expect(report.passed).toBe(true)
  })

  it('exercises the leak fuzzer with real secrets', () => {
    const leak = report.checks.find((check) => check.id === 'no-hidden-info-leak')
    expect(leak?.assertions).toBeGreaterThan(100)
    expect(leak?.notes).not.toContain(
      'the game declares no hidden information, so only the structural view checks run; `manifest-valid` enforces that this matches the manifest',
    )
  })
})
