import { asGameId, asMatchId, asMatchSeed, createRng, type Rng } from '@playhall/game-sdk'
import { parseMoveInput, replay } from '../src/rules/position.js'
import type { Color } from '../src/rules/types.js'
import { asSeatId, type GameContext, type SeatId } from '../src/sdk/contract.js'
import { chessSettingsSchema, type ChessSettingsInput } from '../src/settings/schema.js'
import { applyAction, setup, type ChessMatchState } from '../src/state.js'

export const HOST: SeatId = asSeatId('seat-host')
export const GUEST: SeatId = asSeatId('seat-guest')

/**
 * An `Rng` whose `next()` is fixed, so a colour draw is a test input rather
 * than a thing to be discovered. Everything else delegates to a real stream.
 */
export function fixedRng(next: () => number): Rng {
  const real = createRng(asMatchSeed('test'))
  return { ...real, next, fork: () => fixedRng(next) }
}

/** A context with a fixed clock and a fixed rng draw, unless overridden. */
export function ctx(
  overrides: Partial<Omit<GameContext, 'rng'>> & { readonly rng?: () => number } = {},
): GameContext {
  const { rng, ...rest } = overrides
  return {
    matchId: asMatchId('match-test'),
    gameId: asGameId('chess'),
    gameVersion: '0.0.0',
    sdkContractVersion: 1,
    now: 0,
    seed: asMatchSeed('test'),
    sequence: 0,
    ...rest,
    rng: fixedRng(rng ?? (() => 0.42)),
  }
}

interface NewGameOptions {
  readonly fen?: string
  readonly settings?: ChessSettingsInput
  readonly now?: number
  readonly rng?: () => number
}

/**
 * A match with the host on White by default, so tests can talk about colours
 * instead of seats.
 */
export function newGame(options: NewGameOptions = {}): ChessMatchState {
  return setup(
    {
      hostSeatId: HOST,
      guestSeatId: GUEST,
      settings: chessSettingsSchema.parse({ color: 'white', ...options.settings }),
      ...(options.fen ? { initialFen: options.fen } : {}),
    },
    ctx({ now: options.now ?? 0, ...(options.rng ? { rng: options.rng } : {}) }),
  )
}

/** The seat playing a given colour. */
export function seatOf(state: ChessMatchState, color: Color): SeatId {
  return state.colors[color]
}

/**
 * Play a list of SAN moves through `applyAction`.
 *
 * Deliberately goes through the reducer rather than driving chess.js directly:
 * every test position is therefore reached the same way a real client would
 * reach it, and any move the server would reject fails the test loudly.
 */
export function playMoves(
  state: ChessMatchState,
  sans: readonly string[],
  now = 0,
): ChessMatchState {
  let current = state
  for (const san of sans) {
    const chess = replay(current.initialFen, current.moves)
    const input = parseMoveInput(chess, san)
    if (input === null) {
      throw new Error(`Test setup error: "${san}" is not legal in ${chess.fen()}`)
    }
    const result = applyAction(
      current,
      { type: 'move', move: input },
      current.colors[chess.turn()],
      ctx({ now }),
    )
    if (!result.ok) {
      throw new Error(`Test setup error: "${san}" rejected with ${result.error}`)
    }
    current = result.state
  }
  return current
}

/** Legal SAN moves in the current position, for assertions about legality. */
export function legalSan(state: ChessMatchState): string[] {
  return replay(state.initialFen, state.moves).moves()
}

/**
 * Whether a SAN move is legal right now.
 *
 * Goes through `parseMoveInput`, so `'O-O'` matches whether or not chess.js
 * decorates it as `'O-O+'` — and the SAN parser the keyboard entry uses gets
 * exercised by every legality test.
 */
export function canPlay(state: ChessMatchState, san: string): boolean {
  return parseMoveInput(replay(state.initialFen, state.moves), san) !== null
}
