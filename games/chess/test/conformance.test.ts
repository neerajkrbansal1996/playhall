/**
 * The platform gate. `packages/game-testkit`'s turn-based conformance suite, run
 * against chess as an ordinary SDK game module — one `it` per check.
 *
 * The subject (settings variants, abort scenarios, the playout policy and the
 * probe batteries) is in `./conformance-subject.ts`, with the measurement behind
 * every number it declares.
 *
 * ## The abort-cause split, stated rather than left as a hole
 *
 * Chess reaches `reason: 'abort'` two ways, and only one of them is reachable
 * from `abortScenarios`:
 *
 *   - **`cause: 'agreed'`** — a player aborts inside the window. Covered here, at
 *     both ends of the window (`afterSteps: 0` and `afterSteps: 1`).
 *   - **`cause: 'first_move_timeout'`** — nobody moved within 30 s. **Not**
 *     reachable through `abortScenarios`, and covered by unit test at
 *     `player-endings.test.ts` instead.
 *
 * Why it is unreachable: the driver dispatches the abort at
 * `sequence = afterSteps + 1` with `now = startNow + sequence * nowStepMs`, and
 * `nowStepMs` defaults to 1,000 ms. Chess's first-move deadline is
 * `startedAt + 30_000`, where `startedAt` is `ctx.now` at sequence 0. `afterSteps`
 * is itself capped at 1 by `canAbort`, so `ctx.now` at the abort is at most
 * `startNow + 2_000` and the reducer correctly returns
 * `first_move_deadline_not_reached`. The only lever is `nowStepMs`, which is
 * subject-level and shared by every check: raising it to 30,000 would advance
 * every playout's clock 30 s per ply and flag a bullet preset mid-playout. A
 * per-scenario clock offset on `AbortScenario` would close this, but that is a
 * testkit contract change and belongs to the CTO (PER-47 / PER-136), not to a
 * game.
 *
 * The `{ seatId }` shape is not the obstacle: chess handles `first_move_timeout`
 * before the seat check, so any roster seat would be accepted.
 */

import { describeTurnBasedConformance } from '@playhall/game-testkit/vitest'

import { CHESS_CONFORMANCE_OPTIONS, chessConformanceSubject } from './conformance-subject.js'

describeTurnBasedConformance(chessConformanceSubject, CHESS_CONFORMANCE_OPTIONS)
