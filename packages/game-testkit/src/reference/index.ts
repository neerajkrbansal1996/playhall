/**
 * Reference games.
 *
 * These ship with the testkit rather than living in a test folder because two
 * other packages need them:
 *
 *   - the testkit's own tests, which have to prove that a *broken* game fails
 *     conformance and not only that a correct one passes;
 *   - `@playhall/platform-core`, whose room-runner tests need a real game
 *     module without importing a real game package (the platform never
 *     imports a game — principle 1).
 *
 * `hidden-hand` is the one with secrets in it. Tic-tac-toe is
 * perfect-information, so it cannot exercise the leak fuzzer at all.
 * `standoff` is the one whose only unrecorded ending is a first-move timeout,
 * which is the consumer ADR-0010's `TimerAbortScenario` was shaped by.
 */

export {
  type Card,
  type HiddenHandAction,
  type HiddenHandEvent,
  type HiddenHandSettings,
  type HiddenHandState,
  type HiddenHandView,
  actionSchema as hiddenHandActionSchema,
  manifest as hiddenHandManifest,
  server as hiddenHandServer,
  settingsSchema as hiddenHandSettingsSchema,
  toMoveOf as hiddenHandToMove,
} from './hidden-hand.js'

export { hiddenHandSubject } from './hidden-hand-subject.js'

export {
  type StandoffAction,
  type StandoffEvent,
  type StandoffSettings,
  type StandoffState,
  type StandoffView,
  FIRST_MOVE_TIMER as standoffFirstMoveTimer,
  actionSchema as standoffActionSchema,
  manifest as standoffManifest,
  server as standoffServer,
  settingsSchema as standoffSettingsSchema,
} from './standoff.js'

export { standoffSubject } from './standoff-subject.js'
