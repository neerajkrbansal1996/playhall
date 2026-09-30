/**
 * `@playhall/game-testkit` — the conformance suite every game must pass before
 * CI will merge it.
 *
 * Why a suite and not a code review: every one of these properties is
 * invisible to inspection and expensive in production. A hidden-information
 * leak reads as a normal field. A non-deterministic reducer works until the
 * server restarts. A game that can reach a dead position works until the
 * hundredth match. All of them are found in seconds by driving the game
 * through its own contract a few thousand times.
 *
 * Usage, in full:
 *
 * ```ts
 * import { describeTurnBasedConformance } from '@playhall/game-testkit/vitest'
 * import { manifest, server } from '../src/index.js'
 *
 * describeTurnBasedConformance({ manifest, server })
 * ```
 *
 * A game with hidden information additionally declares what is secret; see
 * `SecretDescriptor` and the worked example in
 * `@playhall/game-testkit/reference`.
 */

import { SDK_VERSION } from '@playhall/game-sdk'

export {
  type CheckFailure,
  type CheckResult,
  type CheckStatus,
  type ConformanceCheck,
  type ConformanceReport,
  type RealtimeCheck,
  type TurnBasedCheck,
  CheckRecorder,
  REALTIME_CHECKS,
  TURN_BASED_CHECKS,
  failedChecks,
  formatReport,
} from './report.js'

export {
  type AbortScenario,
  type ActionCandidate,
  type SecretDescriptor,
  type SecretHolding,
  type SettingsVariant,
  type TurnBasedConformanceOptions,
  type TurnBasedConformanceSubject,
  perSeatSecret,
  serverOnlySecret,
} from './subject.js'

export { runTurnBasedConformance } from './turn-based.js'

export {
  type RealtimeCheckSpec,
  REALTIME_CHECK_SPECS,
  REALTIME_SKIP_REASON,
  runRealtimeConformance,
} from './realtime.js'

export { STANDARD_MALFORMED_ACTIONS } from './checks/actions.js'
export { checkSettingsFormContract } from './checks/settings-form.js'
export { describeProblem } from './checks/result-standings.js'

/**
 * Harness pieces games rarely need but `@playhall/platform-core` does: the
 * room runner's own tests drive a game the same way conformance does.
 */
export {
  type ActionChooser,
  type ContextOptions,
  type Playout,
  type PlayoutStep,
  buildDefaultRoster,
  contextAt,
  defaultChooseAction,
  playout,
  replay,
  statesOf,
} from './internal/driver.js'

export { AmbientAccessError, withoutAmbientSources } from './internal/ambient.js'
export {
  type JsonSafetyProblem,
  deepEqual,
  findJsonSafetyProblems,
  findScalar,
  jsonRoundTrip,
  stableStringify,
} from './internal/value.js'

/**
 * The check ids, kept for the M0 contract stub that named them. Prefer
 * `TURN_BASED_CHECKS`, which is the authoritative list.
 */
export const CONFORMANCE_CHECKS = [
  'determinism',
  'no-hidden-info-leak',
  'illegal-action-rejected',
  'serialization-round-trip',
  'reconnect-snapshot-matches-live',
  'random-playout-terminates',
  'result-standings-well-formed',
] as const

/** The SDK version this testkit build conforms to. Recorded on every run. */
export const TESTKIT_SDK_VERSION = SDK_VERSION
