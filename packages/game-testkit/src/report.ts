/**
 * The conformance report.
 *
 * A run produces data, not thrown assertions. CI renders it, the vitest
 * binding turns each check into a test case, and a game author can print it
 * locally without a test runner. Keeping the result a value is also what lets
 * the testkit test *itself*: `expect(report.checks).toContain(a failure)`.
 *
 * The report carries no timings and no timestamps on purpose — the thing that
 * proves games are deterministic must produce a deterministic artefact.
 */

/** Checks a turn-based game must pass before CI will merge it. */
export const TURN_BASED_CHECKS = [
  'manifest-valid',
  'determinism',
  'reducer-purity',
  'no-hidden-info-leak',
  'illegal-action-rejected',
  'legal-actions-agree',
  'serialization-round-trip',
  'reconnect-snapshot-matches-live',
  'random-playout-terminates',
] as const

export type TurnBasedCheck = (typeof TURN_BASED_CHECKS)[number]

/**
 * Real-time checks. Declared now so the contract is visible and M6 has a
 * fixed target; every one of them reports `skipped` until the netcode kit
 * exists. Starting M6 is board-gated.
 */
export const REALTIME_CHECKS = [
  'tick-budget',
  'snapshot-leak',
  'bot-swarm-soak',
  'reconnect-restores-role-and-position',
] as const

export type RealtimeCheck = (typeof REALTIME_CHECKS)[number]

export type ConformanceCheck = TurnBasedCheck | RealtimeCheck

export type CheckStatus = 'passed' | 'failed' | 'skipped'

export interface CheckFailure {
  /** One line, safe to put in a CI annotation. */
  readonly message: string
  /** Where the failure was found: seed, step, viewer, path. */
  readonly where?: string
  /** Rendered values. Can be long. */
  readonly detail?: string
}

export interface CheckResult {
  readonly id: ConformanceCheck
  readonly title: string
  readonly status: CheckStatus
  /** How many times the check actually asserted something. Zero is suspicious. */
  readonly assertions: number
  readonly failures: readonly CheckFailure[]
  readonly skipReason?: string
  /** Non-fatal observations, e.g. an optional hook the game does not implement. */
  readonly notes: readonly string[]
}

export interface ConformanceReport {
  readonly kind: 'turn-based' | 'realtime'
  /** `gameId@version`. */
  readonly subject: string
  readonly sdkVersion: string
  readonly sdkContractVersion: number
  readonly seeds: readonly string[]
  readonly checks: readonly CheckResult[]
  readonly passed: boolean
}

/** Accumulates one check's outcome. Checks never throw; they record. */
export class CheckRecorder {
  private readonly failures: CheckFailure[] = []
  private readonly notes: string[] = []
  private assertions = 0
  private skipReason: string | undefined

  constructor(
    readonly id: ConformanceCheck,
    readonly title: string,
  ) {}

  /** Records one assertion. Call it whether or not it passed. */
  assert(condition: boolean, failure: () => CheckFailure): void {
    this.assertions += 1
    if (!condition) this.failures.push(failure())
  }

  fail(failure: CheckFailure): void {
    this.assertions += 1
    this.failures.push(failure)
  }

  note(message: string): void {
    this.notes.push(message)
  }

  skip(reason: string): void {
    this.skipReason = reason
  }

  get failureCount(): number {
    return this.failures.length
  }

  finish(): CheckResult {
    const status: CheckStatus =
      this.skipReason !== undefined && this.failures.length === 0
        ? 'skipped'
        : this.failures.length === 0
          ? 'passed'
          : 'failed'
    return {
      id: this.id,
      title: this.title,
      status,
      assertions: this.assertions,
      // A truncated list keeps a badly broken game from producing a
      // thousand-line CI log; the count is still in the message.
      failures:
        this.failures.length <= 20
          ? this.failures
          : [
              ...this.failures.slice(0, 20),
              { message: `… and ${this.failures.length - 20} more failures of this kind` },
            ],
      ...(this.skipReason === undefined ? {} : { skipReason: this.skipReason }),
      notes: this.notes,
    }
  }
}

/** Human-readable summary, used by CI and by `pnpm conformance`. */
export function formatReport(report: ConformanceReport): string {
  const lines: string[] = [
    `${report.passed ? 'PASS' : 'FAIL'}  ${report.subject}  (${report.kind}, sdk ${report.sdkVersion})`,
  ]
  for (const check of report.checks) {
    const mark = check.status === 'passed' ? '✓' : check.status === 'skipped' ? '-' : '✗'
    const suffix =
      check.status === 'skipped'
        ? ` (skipped: ${check.skipReason ?? 'no reason given'})`
        : ` (${check.assertions} assertions)`
    lines.push(`  ${mark} ${check.id}${suffix}`)
    for (const note of check.notes) lines.push(`      note: ${note}`)
    for (const failure of check.failures) {
      lines.push(`      ✗ ${failure.message}`)
      if (failure.where !== undefined) lines.push(`        at ${failure.where}`)
      if (failure.detail !== undefined) lines.push(`        ${failure.detail}`)
    }
  }
  return lines.join('\n')
}

/** The check ids that did not pass. Empty means the game conforms. */
export function failedChecks(report: ConformanceReport): ConformanceCheck[] {
  return report.checks.filter((check) => check.status === 'failed').map((check) => check.id)
}
