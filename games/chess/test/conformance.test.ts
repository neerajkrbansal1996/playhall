/**
 * The platform gate. `packages/game-testkit`'s turn-based conformance suite, run
 * against chess as an ordinary SDK game module — one `it` per check.
 *
 * The subject (settings variants, abort scenarios, the playout policy and the
 * probe batteries) is in `./conformance-subject.ts`, with the measurement behind
 * every number it declares.
 *
 * ## Both abort causes, both reached from the suite
 *
 * Chess reaches `reason: 'abort'` two ways, and `abortScenarios` declares both:
 *
 *   - **`cause: 'agreed'`** — a player aborts inside the window. The action arm,
 *     at both ends of the window (`afterSteps: 0` and `afterSteps: 1`).
 *   - **`cause: 'first_move_timeout'`** — nobody moved within 30 s. The timer arm
 *     (ADR-0010): the driver replays the `setTimer` chess returns from
 *     `createInitialState` and fires it at `startedAt + 30_000`, which is exactly
 *     the boundary the reducer checks. `player-endings.test.ts` still unit-tests
 *     the rule itself.
 *
 * Before ADR-0010 the timeout was unreachable from here, and this block said so.
 * That was accurate, and the reason is worth keeping because the obstacle was
 * never the one it looks like. It was not the clock: the driver dispatched an
 * abort at `now = startNow + (afterSteps + 1) * nowStepMs`, `nowStepMs` defaults
 * to 1,000 ms, and `afterSteps` is capped at 1 by `canAbort`, so the reducer
 * correctly returned `first_move_deadline_not_reached`. It was not the
 * `{ seatId }` shape either — chess handles `first_move_timeout` before the seat
 * check, so any roster seat is accepted.
 *
 * It was that the only arm was a *player action*, and `first_move_timeout` is
 * deliberately absent from `chessActionSchema` because the server raises it
 * through `onTimer`. That is also why `ActionAbortScenario.advanceMs` (PER-136)
 * does not close it, despite being built for deadline-gated aborts: there is no
 * client action to offset the clock for. A game whose timeout is *claimed* by the
 * opponent would use `advanceMs`; chess's is raised, so it needs the timer arm.
 */

import { describeTurnBasedConformance } from '@playhall/game-testkit/vitest'

import { CHESS_CONFORMANCE_OPTIONS, chessConformanceSubject } from './conformance-subject.js'

describeTurnBasedConformance(chessConformanceSubject, CHESS_CONFORMANCE_OPTIONS)
