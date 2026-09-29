/**
 * @playhall/game-testkit — the conformance suite every game must pass before CI
 * will merge it.
 *
 * The checks (declared here so the contract is visible from M0; implemented in
 * M1 once the SDK contracts land):
 *   1. determinism — same seed + same action log => same state
 *   2. no hidden-info leaks under fuzzed `getViewFor`
 *   3. rejection of illegal, out-of-turn and malformed actions
 *   4. serialization round-trip
 *   5. reconnect snapshot equals live state
 *   6. random playouts terminate with a valid result
 *   7. every result is well-formed: one standing per seat, or empty for a
 *      reason that did not count (ADR-0006)
 */
import { SDK_VERSION } from '@playhall/game-sdk'

export const CONFORMANCE_CHECKS = [
  'determinism',
  'no-hidden-info-leak',
  'illegal-action-rejected',
  'serialization-round-trip',
  'reconnect-snapshot-matches-live',
  'random-playout-terminates',
  'result-standings-well-formed',
] as const

export type ConformanceCheck = (typeof CONFORMANCE_CHECKS)[number]

/** The SDK version this testkit build conforms to. Recorded on every run. */
export const TESTKIT_SDK_VERSION = SDK_VERSION
