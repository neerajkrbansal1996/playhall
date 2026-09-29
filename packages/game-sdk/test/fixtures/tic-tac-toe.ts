/**
 * Tic-tac-toe, implemented against the turn-based contract.
 *
 * This is a *contract fixture*, not the shipping game — `games/_examples/tic-tac-toe`
 * (PER-18) is that, and it is owned by Platform Engineer. Its job here is to
 * prove, in the same commit that defines the contracts, that a complete
 * turn-based game can be written using nothing but `@playhall/game-sdk`: no
 * platform internals, no I/O, no `Date.now`, no `Math.random`.
 *
 * Note the single import below. That is the whole point.
 */

import {
  DEFAULT_DISCONNECT_POLICY,
  PUBLIC,
  type GameContext,
  type GameEvent,
  type GameManifest,
  type MatchResult,
  type SeatId,
  type SeatRoster,
  type TurnBasedGameServer,
  type Viewer,
  VALID,
  asTimerId,
  drawStandings,
  invalid,
  setTimer,
  standingsFromWinners,
} from '../../src/index.js'
import { z } from 'zod'

// --- settings ---------------------------------------------------------------

export const settingsSchema = z.object({
  /** Seconds each player gets per move. */
  moveTimeoutSeconds: z.number().int().min(5).max(300),
  /** Who plays first: the seat at index 0, or a coin flip. */
  firstMove: z.enum(['seat-order', 'random']),
})

export type TicTacToeSettings = z.infer<typeof settingsSchema>

// --- state, actions, view ---------------------------------------------------

export type Mark = 'x' | 'o'
export type Cell = Mark | null

export interface TicTacToeState {
  readonly board: readonly Cell[]
  readonly seatMarks: readonly { readonly seatId: SeatId; readonly mark: Mark }[]
  readonly toMove: SeatId | null
  readonly winner: SeatId | null
  readonly winningLine: readonly number[] | null
  readonly moveCount: number
  readonly resignedBy: SeatId | null
  readonly timedOut: boolean
  /**
   * Settings are handed to `createInitialState` and to nothing else. A game
   * that still needs them later copies what it needs into its own state, which
   * keeps state the single self-contained thing a replay has to load.
   */
  readonly moveTimeoutMs: number
}

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('place'), cell: z.number().int().min(0).max(8) }),
  z.object({ type: z.literal('resign') }),
])

export type TicTacToeAction = z.infer<typeof actionSchema>

export interface TicTacToeView {
  readonly board: readonly Cell[]
  readonly toMove: SeatId | null
  readonly yourMark: Mark | null
  readonly moveCount: number
  readonly winningLine: readonly number[] | null
}

export type TicTacToeEvent =
  | GameEvent<'placed', { readonly seatId: SeatId; readonly cell: number; readonly mark: Mark }>
  | GameEvent<'resigned', { readonly seatId: SeatId }>
  | GameEvent<'match_ended', { readonly winner: SeatId | null }>

const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]

const MOVE_TIMER = asTimerId('move')

function markOf(state: TicTacToeState, seatId: SeatId): Mark | null {
  return state.seatMarks.find((entry) => entry.seatId === seatId)?.mark ?? null
}

function opponentOf(state: TicTacToeState, seatId: SeatId): SeatId | null {
  return state.seatMarks.find((entry) => entry.seatId !== seatId)?.seatId ?? null
}

function findWinningLine(board: readonly Cell[], mark: Mark): readonly number[] | null {
  for (const line of LINES) {
    if (line.every((index) => board[index] === mark)) return line
  }
  return null
}

// --- manifest ---------------------------------------------------------------

export const manifest: GameManifest<TicTacToeSettings> = {
  id: 'tic-tac-toe',
  slug: 'tic-tac-toe',
  name: 'Tic-tac-toe',
  shortDescription: 'Three in a row. The smallest possible game, and the first SDK consumer.',
  thumbnail: 'assets/thumbnail.png',
  category: 'board',
  minPlayers: 2,
  maxPlayers: 2,
  teams: 'none',
  turnModel: 'sequential',
  hasHiddenInformation: false,
  usesRandomness: true, // `firstMove: 'random'` consumes ctx.rng
  supportsSpectators: true,
  supportsBots: false,
  settingsSchema,
  defaultSettings: { moveTimeoutSeconds: 30, firstMove: 'seat-order' },
  presets: [
    {
      id: 'classic',
      label: 'Classic',
      settings: { moveTimeoutSeconds: 30, firstMove: 'seat-order' },
      isDefault: true,
    },
    {
      id: 'blitz',
      label: 'Blitz',
      settings: { moveTimeoutSeconds: 5, firstMove: 'random' },
      featured: true,
    },
  ],
  // The generality test for ADR-0007: tic-tac-toe is nothing like chess and
  // needs no field kind chess did not need, and no chess concept.
  settingsForm: {
    version: 1,
    fields: [
      {
        kind: 'number',
        key: 'moveTimeoutSeconds',
        label: 'Seconds per move',
        unit: 's',
        min: 5,
        max: 300,
        step: 5,
      },
      {
        kind: 'select',
        key: 'firstMove',
        label: 'Who moves first',
        display: 'chips',
        options: [
          { value: 'seat-order', label: 'Host' },
          { value: 'random', label: 'Coin flip' },
        ],
      },
    ],
  },
  timers: [
    {
      id: 'move',
      kind: 'turn',
      description: 'Per-move deadline for the seat to move.',
      pausesOnDisconnect: true,
    },
  ],
  status: 'beta',
  version: '1.0.0',
  sdkContractVersion: 1,
}

// --- server -----------------------------------------------------------------

export const server: TurnBasedGameServer<
  TicTacToeState,
  TicTacToeAction,
  TicTacToeView,
  TicTacToeSettings,
  TicTacToeEvent
> = {
  actionSchema,

  createInitialState(ctx: GameContext, settings: TicTacToeSettings, seats: SeatRoster) {
    const [first, second] = seats
    if (first === undefined || second === undefined) {
      throw new Error('tic-tac-toe requires exactly two seats')
    }

    // The only randomness in the game, and it comes from ctx.rng — so the same
    // seed always produces the same opening.
    const xFirst = settings.firstMove === 'seat-order' ? true : ctx.rng.bool()
    const xSeat = xFirst ? first.seatId : second.seatId
    const oSeat = xFirst ? second.seatId : first.seatId

    const state: TicTacToeState = {
      board: Array.from({ length: 9 }, () => null),
      seatMarks: [
        { seatId: xSeat, mark: 'x' },
        { seatId: oSeat, mark: 'o' },
      ],
      toMove: xSeat,
      winner: null,
      winningLine: null,
      moveCount: 0,
      resignedBy: null,
      timedOut: false,
      moveTimeoutMs: settings.moveTimeoutSeconds * 1000,
    }

    return {
      state,
      events: [],
      timers: [setTimer(MOVE_TIMER, settings.moveTimeoutSeconds * 1000, xSeat)],
    }
  },

  validateAction(_ctx, state, seatId, action) {
    if (markOf(state, seatId) === null) return invalid('not_seated')
    if (server.getResult(state) !== null) return invalid('match_over')
    if (action.type === 'resign') return VALID
    if (state.toMove !== seatId) return invalid('not_your_turn')
    if (state.board[action.cell] !== null) {
      return invalid('illegal_action', 'cell is already taken', { cell: action.cell })
    }
    return VALID
  },

  applyAction(_ctx, state, seatId, action) {
    if (action.type === 'resign') {
      const next: TicTacToeState = { ...state, resignedBy: seatId, toMove: null }
      return {
        state: next,
        events: [
          { type: 'resigned', payload: { seatId }, audience: PUBLIC },
          { type: 'match_ended', payload: { winner: opponentOf(state, seatId) }, audience: PUBLIC },
        ],
        timers: [{ op: 'clear', timerId: MOVE_TIMER }],
      }
    }

    const mark = markOf(state, seatId)
    if (mark === null) throw new Error('applyAction called for a seat with no mark')

    const board = state.board.slice()
    board[action.cell] = mark

    const winningLine = findWinningLine(board, mark)
    const moveCount = state.moveCount + 1
    const isDraw = winningLine === null && moveCount === 9
    const opponent = opponentOf(state, seatId)
    const over = winningLine !== null || isDraw

    const next: TicTacToeState = {
      ...state,
      board,
      moveCount,
      winner: winningLine === null ? null : seatId,
      winningLine,
      toMove: over ? null : opponent,
    }

    const events: TicTacToeEvent[] = [
      { type: 'placed', payload: { seatId, cell: action.cell, mark }, audience: PUBLIC },
    ]
    if (over) {
      events.push({ type: 'match_ended', payload: { winner: next.winner }, audience: PUBLIC })
    }

    return {
      state: next,
      events,
      timers: over
        ? [{ op: 'clear', timerId: MOVE_TIMER }]
        : // Relative delay — the runner resolves it against the ctx.now it
          // passed in, so replay lands on the same deadline.
          [setTimer(MOVE_TIMER, state.moveTimeoutMs, opponent)],
    }
  },

  getViewFor(state, viewer: Viewer): TicTacToeView {
    // Tic-tac-toe has no hidden information, so the board is public for every
    // viewer kind. `yourMark` is still per-viewer: a spectator has no mark.
    return {
      board: state.board,
      toMove: state.toMove,
      yourMark: viewer.kind === 'seat' ? markOf(state, viewer.seatId) : null,
      moveCount: state.moveCount,
      winningLine: state.winningLine,
    }
  },

  getLegalActions(state, seatId) {
    if (server.getResult(state) !== null) return []
    if (markOf(state, seatId) === null) return []
    const resign: TicTacToeAction = { type: 'resign' }
    if (state.toMove !== seatId) return [resign]
    const places = state.board
      .map((cell, index): TicTacToeAction | null =>
        cell === null ? { type: 'place', cell: index } : null,
      )
      .filter((action): action is TicTacToeAction => action !== null)
    return [...places, resign]
  },

  onTimer(_ctx, state, _timerId, seatId) {
    // The seat on the clock ran out: they lose.
    const next: TicTacToeState = { ...state, timedOut: true, resignedBy: seatId, toMove: null }
    return {
      state: next,
      events: [
        {
          type: 'match_ended',
          payload: { winner: seatId === null ? null : opponentOf(state, seatId) },
          audience: PUBLIC,
        },
      ],
      timers: [{ op: 'clear', timerId: MOVE_TIMER }],
    }
  },

  disconnectPolicy: { ...DEFAULT_DISCONNECT_POLICY, onGraceExpired: 'forfeit', graceMs: 45_000 },

  getResult(state): MatchResult | null {
    const all = state.seatMarks.map((entry) => entry.seatId)

    if (state.resignedBy !== null) {
      const winner = all.find((seatId) => seatId !== state.resignedBy)
      return {
        reason: state.timedOut ? 'timeout' : 'resignation',
        standings: standingsFromWinners(all, winner === undefined ? [] : [winner]),
      }
    }
    if (state.winner !== null) {
      return { reason: 'completed', standings: standingsFromWinners(all, [state.winner]) }
    }
    if (state.moveCount === 9) {
      return { reason: 'completed', standings: drawStandings(all) }
    }
    return null
  },

  exportRecord(state) {
    return {
      format: 'json',
      mimeType: 'application/json',
      filenameHint: 'tic-tac-toe.json',
      content: JSON.stringify({ board: state.board, moves: state.moveCount }),
    }
  },
}
