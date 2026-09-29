/**
 * @atrium/game-testkit — the conformance suite every game must pass before CI
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
 */
import { GAME_SDK_VERSION } from '@atrium/game-sdk'

export const CONFORMANCE_CHECKS = [
  'determinism',
  'no-hidden-info-leak',
  'illegal-action-rejected',
  'serialization-round-trip',
  'reconnect-snapshot-matches-live',
  'random-playout-terminates',
] as const

export type ConformanceCheck = (typeof CONFORMANCE_CHECKS)[number]

export const TESTKIT_SDK_VERSION = GAME_SDK_VERSION
