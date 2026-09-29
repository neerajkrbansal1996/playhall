/**
 * The tic-tac-toe fixture wired up as a complete `GameModule`.
 *
 * Splitting this from `tic-tac-toe.ts` mirrors how a real game package is laid
 * out: rules are importable on their own (server, tests, bots) without pulling
 * in the client entry.
 */

import { defineTurnBasedGame, type GameViewProps } from '../../src/index.js'
import {
  manifest,
  server,
  type TicTacToeAction,
  type TicTacToeEvent,
  type TicTacToeSettings,
  type TicTacToeState,
  type TicTacToeView,
} from './tic-tac-toe.js'

/**
 * Stands in for `() => import('./client/GameView.js')`. The contract requires
 * a thunk returning a module with a `default` component, which is what keeps a
 * game's UI out of every other bundle.
 */
function ticTacToeView(props: GameViewProps<TicTacToeView, TicTacToeAction>): string {
  return `tic-tac-toe: ${props.view.moveCount} moves`
}

export const ticTacToeModule = defineTurnBasedGame<
  TicTacToeState,
  TicTacToeAction,
  TicTacToeView,
  TicTacToeSettings,
  TicTacToeEvent
>({
  manifest,
  server,
  client: {
    GameView: () => Promise.resolve({ default: ticTacToeView }),
  },
})
