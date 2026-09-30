/**
 * The turn-based conformance run.
 *
 * `runTurnBasedConformance` expands the scenarios, generates the playouts
 * once, and hands them to every check. It returns a report rather than
 * throwing, so the same function serves a vitest suite, a CI reporter and a
 * game author poking at their game in a REPL.
 */

import { SDK_VERSION, type GameEvent } from '@playhall/game-sdk'
import { prepare } from './internal/prepare.js'
import { checkManifest } from './checks/manifest.js'
import { checkSettingsFormContract } from './checks/settings-form.js'
import { checkDeterminism, checkReducerPurity } from './checks/determinism.js'
import { checkNoHiddenInfoLeak } from './checks/redaction.js'
import { checkIllegalActionRejected, checkLegalActionsAgree } from './checks/actions.js'
import { checkReconnectSnapshot, checkSerializationRoundTrip } from './checks/persistence.js'
import { checkRandomPlayoutTerminates } from './checks/playouts.js'
import {
  type CheckResult,
  type ConformanceReport,
  type TurnBasedCheck,
  CheckRecorder,
} from './report.js'
import type { TurnBasedConformanceOptions, TurnBasedConformanceSubject } from './subject.js'

export function runTurnBasedConformance<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent = GameEvent,
  TErrorCode extends string = string,
>(
  subject: TurnBasedConformanceSubject<TState, TAction, TView, TSettings, TEvent, TErrorCode>,
  options: TurnBasedConformanceOptions = {},
): ConformanceReport {
  const prep = prepare(subject, options)
  const only = options.only === undefined ? null : new Set(options.only)

  // Keyed by check id rather than paired positionally with TURN_BASED_CHECKS:
  // inserting a check in the middle of one list and not the other used to
  // silently rename every check after it.
  const runners: readonly (readonly [TurnBasedCheck, () => CheckRecorder])[] = [
    ['manifest-valid', () => checkManifest(prep)],
    ['settings-form-contract', () => checkSettingsFormContract(prep)],
    ['determinism', () => checkDeterminism(prep)],
    ['reducer-purity', () => checkReducerPurity(prep)],
    ['no-hidden-info-leak', () => checkNoHiddenInfoLeak(prep)],
    ['illegal-action-rejected', () => checkIllegalActionRejected(prep)],
    ['legal-actions-agree', () => checkLegalActionsAgree(prep)],
    ['serialization-round-trip', () => checkSerializationRoundTrip(prep)],
    ['reconnect-snapshot-matches-live', () => checkReconnectSnapshot(prep)],
    ['random-playout-terminates', () => checkRandomPlayoutTerminates(prep)],
  ]

  const checks: CheckResult[] = []
  for (const [id, runner] of runners) {
    if (only !== null && !only.has(id)) continue
    try {
      checks.push(runner().finish())
    } catch (error) {
      // A check that throws is a bug in the testkit, or a game that broke an
      // invariant so badly the check could not finish. Either way, report it
      // as a failure of that check instead of taking the whole run down.
      const recorder = new CheckRecorder(id, id)
      recorder.fail({
        message: `the check itself threw: ${error instanceof Error ? error.message : String(error)}`,
        detail: error instanceof Error ? error.stack : undefined,
      })
      checks.push(recorder.finish())
    }
  }

  return {
    kind: 'turn-based',
    subject: `${subject.manifest.id}@${subject.manifest.version}`,
    sdkVersion: SDK_VERSION,
    sdkContractVersion: subject.manifest.sdkContractVersion,
    seeds: prep.seeds,
    checks,
    passed: checks.every((check) => check.status !== 'failed'),
  }
}
