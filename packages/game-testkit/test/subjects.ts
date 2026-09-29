/**
 * The subjects the testkit's own tests run against.
 *
 * Tic-tac-toe comes from the SDK's contract fixture rather than being copied
 * here. `games/_examples/tic-tac-toe` (PER-18) is the shipping version and
 * will bring its own conformance test; until it exists, the fixture is the
 * same game written against the same contract, and testing against it keeps
 * one definition instead of three.
 */

import {
  actionSchema as ticTacToeActionSchema,
  manifest as ticTacToeManifest,
  server as ticTacToeServer,
  type TicTacToeAction,
  type TicTacToeEvent,
  type TicTacToeSettings,
  type TicTacToeState,
  type TicTacToeView,
} from '../../game-sdk/test/fixtures/tic-tac-toe.js'
import type { TurnBasedConformanceSubject } from '../src/index.js'

export {
  ticTacToeActionSchema,
  ticTacToeManifest,
  ticTacToeServer,
  type TicTacToeAction,
  type TicTacToeEvent,
  type TicTacToeSettings,
  type TicTacToeState,
  type TicTacToeView,
}

export type TicTacToeSubject = TurnBasedConformanceSubject<
  TicTacToeState,
  TicTacToeAction,
  TicTacToeView,
  TicTacToeSettings,
  TicTacToeEvent
>

export const ticTacToeSubject: TicTacToeSubject = {
  manifest: ticTacToeManifest,
  server: ticTacToeServer,
  // Tic-tac-toe is perfect information: there is nothing to declare, and
  // `manifest-valid` enforces that this matches `hasHiddenInformation: false`.
  malformedActions: [
    { type: 'place' },
    { type: 'place', cell: 9 },
    { type: 'place', cell: -1 },
    { type: 'place', cell: 1.5 },
  ],
  // Resigning is legal for either seat at any time, and it is the action a
  // `getLegalActions` implementation is most likely to forget. Declaring it
  // here is what lets the reverse half of `legal-actions-agree` see it.
  probeActions: [{ type: 'resign' }, { type: 'place', cell: 0 }, { type: 'place', cell: 8 }],
  /**
   * Resigning is legal on every turn, so a uniform driver would concede out
   * of roughly one playout in ten and leave the endgame rules untested.
   * Weighting it down is exactly what `chooseAction` is for.
   */
  chooseAction(_state, candidates, rng) {
    let best: (typeof candidates)[number] | null = null
    for (const candidate of candidates) {
      if (candidate.actions.length === 0) continue
      if (best === null || candidate.actions.length > best.actions.length) best = candidate
    }
    if (best === null) return null
    const places = best.actions.filter((action) => action.type === 'place')
    // Resign 5% of the time, so the resignation path is still covered.
    if (places.length === 0 || rng.next() < 0.05) {
      return { seatId: best.seatId, action: rng.pick(best.actions) }
    }
    return { seatId: best.seatId, action: rng.pick(places) }
  },
}
