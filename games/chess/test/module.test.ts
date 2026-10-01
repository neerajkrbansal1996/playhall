/**
 * The SDK adapter: manifest, action schema, timers, error-code mapping.
 *
 * `conformance.test.ts` covers the properties the platform cares about
 * (determinism, purity, redaction, rejection) across hundreds of seeded
 * playouts. What it cannot cover is the handful of things a playout never
 * reaches: the timer hooks, the roster guard, and which platform error code a
 * given chess rejection turns into. Those are here, one assertion apiece.
 */

import { describe, expect, it } from 'vitest'
import {
  asPlayerId,
  asSeatId,
  asTimerId,
  seatViewer,
  toCatalogEntry,
  validateManifest,
  type Seat,
  type SeatRoster,
} from '@playhall/game-sdk'

import {
  chessActionSchema,
  chessStateSchema,
  manifest,
  server,
  CHESS_CLOCK_TIMER,
  FIRST_MOVE_TIMER,
  type ChessClientAction,
} from '../src/index.js'
import { FIRST_MOVE_TIMEOUT_MS } from '../src/state.js'
import { ctx, newGame, playMoves, HOST, GUEST } from './helpers.js'

function seat(id: string, index: number): Seat {
  return {
    seatId: asSeatId(id),
    index,
    teamId: null,
    occupant: { playerId: asPlayerId(`player-${index}`), displayName: `P${index}`, isBot: false },
  }
}

const ROSTER: SeatRoster = [seat('seat-host', 0), seat('seat-guest', 1)]

/** The code `validateAction` reports, or `null` when it accepts the action. */
function reject(
  state: Parameters<typeof server.validateAction>[1],
  seatId: Parameters<typeof server.validateAction>[2],
  action: ChessClientAction,
  now = 0,
): string | null {
  const outcome = server.validateAction(ctx({ now }), state, seatId, action)
  return outcome.ok ? null : outcome.error.code
}

describe('manifest', () => {
  it('passes the SDK’s own validation', () => {
    const validated = validateManifest(manifest)
    expect(validated.ok ? [] : validated.error).toEqual([])
  })

  it('declares every timer the server references', () => {
    expect(manifest.timers.map((timer) => timer.id).sort()).toEqual(
      [String(CHESS_CLOCK_TIMER), String(FIRST_MOVE_TIMER)].sort(),
    )
  })

  it('survives the JSON projection the lobby actually consumes', () => {
    const entry = toCatalogEntry(manifest)
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry)
  })

  it('keeps the clock running through a disconnect, and claims nothing automatically', () => {
    expect(server.disconnectPolicy.pauseTimersDuringGrace).toBe(false)
    expect(server.disconnectPolicy.onGraceExpired).toBe('nothing')
  })
})

describe('actionSchema', () => {
  it('accepts a promotion that names its piece', () => {
    expect(
      chessActionSchema.safeParse({ type: 'move', move: { from: 'e7', to: 'e8', promotion: 'n' } })
        .success,
    ).toBe(true)
  })

  it.each(['flag', 'first_move_timeout', 'claim_abandonment'])(
    'rejects the server-raised action %s',
    (type) => {
      expect(chessActionSchema.safeParse({ type }).success).toBe(false)
    },
  )

  it('rejects an unknown key rather than stripping it', () => {
    expect(chessActionSchema.safeParse({ type: 'resign', hurry: true }).success).toBe(false)
  })

  it('rejects a square that is not a square', () => {
    expect(
      chessActionSchema.safeParse({ type: 'move', move: { from: 'e2', to: 'j9' } }).success,
    ).toBe(false)
  })
})

describe('stateSchema', () => {
  it('accepts a state the reducer produced, after a JSON round trip', () => {
    const state = playMoves(newGame(), ['e4', 'e5'])
    expect(chessStateSchema.safeParse(JSON.parse(JSON.stringify(state))).success).toBe(true)
  })

  it('rejects a blob with a key the current shape does not have', () => {
    const state = { ...newGame(), legacyFen: 'rnbq...' }
    expect(chessStateSchema.safeParse(JSON.parse(JSON.stringify(state))).success).toBe(false)
  })
})

describe('createInitialState', () => {
  it('starts the 30 s window on whoever is to move and announces the colours', () => {
    const { state, events, timers } = server.createInitialState(
      ctx(),
      manifest.defaultSettings,
      ROSTER,
    )
    expect(timers).toEqual([
      {
        op: 'set',
        timerId: FIRST_MOVE_TIMER,
        seatId: state.colors.w,
        delayMs: FIRST_MOVE_TIMEOUT_MS,
      },
    ])
    expect(events.map((event) => event.type)).toEqual(['match_started'])
    expect(events[0]?.payload).toMatchObject({ white: String(state.colors.w) })
  })

  it('refuses a roster that is not two seats', () => {
    expect(() => server.createInitialState(ctx(), manifest.defaultSettings, [ROSTER[0]!])).toThrow(
      /exactly 2 seats/,
    )
  })
})

describe('getLegalActions', () => {
  it('offers White the opening moves plus the always-available actions', () => {
    const state = newGame()
    const actions = server.getLegalActions!(state, HOST)
    expect(actions.filter((action) => action.type === 'move')).toHaveLength(20)
    expect(
      actions
        .filter((action) => action.type !== 'move')
        .map((a) => a.type)
        .sort(),
    ).toEqual(['abort', 'offer_draw', 'resign'])
  })

  it('offers the side that is not to move no moves, but still a way out', () => {
    const actions = server.getLegalActions!(newGame(), GUEST)
    expect(actions.some((action) => action.type === 'move')).toBe(false)
    expect(actions.map((action) => action.type).sort()).toEqual(['abort', 'offer_draw', 'resign'])
  })

  it('drops abort once both players have moved', () => {
    const state = playMoves(newGame(), ['e4', 'e5'])
    expect(server.getLegalActions!(state, HOST).some((a) => a.type === 'abort')).toBe(false)
  })

  it('offers accept and decline only to the side that did not offer', () => {
    const offered = server.applyAction(ctx(), newGame(), HOST, { type: 'offer_draw' }).state
    expect(server.getLegalActions!(offered, GUEST).map((a) => a.type)).toContain('accept_draw')
    expect(server.getLegalActions!(offered, HOST).map((a) => a.type)).not.toContain('accept_draw')
  })

  it('offers nothing at all once the match is over', () => {
    const resigned = server.applyAction(ctx(), newGame(), HOST, { type: 'resign' }).state
    expect(server.getLegalActions!(resigned, HOST)).toEqual([])
    expect(server.getLegalActions!(resigned, GUEST)).toEqual([])
  })
})

describe('validateAction maps chess rejections onto platform codes', () => {
  it('not_seated for a seat that is not in this match', () => {
    expect(reject(newGame(), asSeatId('seat-stranger'), { type: 'resign' })).toBe('not_seated')
  })

  it('not_your_turn for a move by the wrong colour', () => {
    expect(reject(newGame(), GUEST, { type: 'move', move: { from: 'e7', to: 'e5' } })).toBe(
      'not_your_turn',
    )
  })

  it('illegal_action for a move against the rules', () => {
    expect(reject(newGame(), HOST, { type: 'move', move: { from: 'e2', to: 'e5' } })).toBe(
      'illegal_action',
    )
  })

  it('illegal_action for a draw claim that is not available', () => {
    expect(reject(newGame(), HOST, { type: 'claim_draw', claim: 'fifty_move_rule' })).toBe(
      'illegal_action',
    )
  })

  it('out_of_phase for an abort after both players have moved', () => {
    expect(reject(playMoves(newGame(), ['e4', 'e5']), HOST, { type: 'abort' })).toBe('out_of_phase')
  })

  it('out_of_phase for a second pending draw offer', () => {
    const offered = server.applyAction(ctx(), newGame(), HOST, { type: 'offer_draw' }).state
    expect(reject(offered, GUEST, { type: 'offer_draw' })).toBe('out_of_phase')
  })

  it('rate_limited for an offer inside the cooldown', () => {
    const offered = server.applyAction(ctx(), newGame(), HOST, { type: 'offer_draw' }).state
    const declined = server.applyAction(ctx(), offered, GUEST, { type: 'decline_draw' }).state
    expect(reject(declined, HOST, { type: 'offer_draw' })).toBe('rate_limited')
  })

  it('match_over once the match has ended', () => {
    const resigned = server.applyAction(ctx(), newGame(), HOST, { type: 'resign' }).state
    expect(reject(resigned, GUEST, { type: 'resign' })).toBe('match_over')
  })
})

describe('applyAction', () => {
  it('hands the 30 s window to the other side after the first move, then clears it', () => {
    const state = newGame()
    const first = server.applyAction(ctx(), state, HOST, {
      type: 'move',
      move: { from: 'e2', to: 'e4' },
    })
    expect(first.timers).toEqual([
      {
        op: 'set',
        timerId: FIRST_MOVE_TIMER,
        seatId: state.colors.b,
        delayMs: FIRST_MOVE_TIMEOUT_MS,
      },
    ])

    const second = server.applyAction(ctx({ sequence: 2 }), first.state, GUEST, {
      type: 'move',
      move: { from: 'e7', to: 'e5' },
    })
    expect(second.timers).toEqual([{ op: 'clear', timerId: FIRST_MOVE_TIMER }])
  })

  it('addresses a draw offer to the two seats, never to spectators', () => {
    const state = newGame()
    const { events } = server.applyAction(ctx(), state, HOST, { type: 'offer_draw' })
    expect(events).toEqual([
      {
        type: 'draw_offered',
        payload: { by: 'w' },
        audience: { kind: 'seats', seatIds: [state.colors.w, state.colors.b] },
      },
    ])
  })

  it('emits match_ended and clears the window when the match ends', () => {
    const { events, timers } = server.applyAction(ctx(), newGame(), HOST, { type: 'resign' })
    expect(events.map((event) => event.type)).toEqual(['match_ended'])
    expect(events[0]?.payload).toMatchObject({ reason: 'resignation' })
    expect(timers).toEqual([{ op: 'clear', timerId: FIRST_MOVE_TIMER }])
  })

  it('throws rather than silently no-opping when the runner skipped validateAction', () => {
    expect(() =>
      server.applyAction(ctx(), newGame(), GUEST, { type: 'move', move: { from: 'e7', to: 'e5' } }),
    ).toThrow(/validateAction rejects/)
  })
})

describe('onTimer', () => {
  it('aborts when the first-move window really has expired', () => {
    const state = newGame()
    const fired = server.onTimer!(
      ctx({ now: FIRST_MOVE_TIMEOUT_MS }),
      state,
      FIRST_MOVE_TIMER,
      state.colors.w,
    )
    expect(fired.state.ending).toEqual({ reason: 'abort', cause: 'first_move_timeout' })
    expect(server.getResult(fired.state)).toMatchObject({ reason: 'aborted', standings: [] })
  })

  it('leaves the match alone when the window has not expired yet', () => {
    const state = newGame()
    const fired = server.onTimer!(ctx({ now: 1 }), state, FIRST_MOVE_TIMER, state.colors.w)
    expect(fired.state).toBe(state)
    expect(fired.events).toEqual([])
  })

  it('flags the seat whose clock ran out, and the opponent wins', () => {
    const state = playMoves(newGame(), ['e4', 'e5'])
    const fired = server.onTimer!(ctx(), state, CHESS_CLOCK_TIMER, state.colors.b)
    expect(fired.state.ending).toEqual({ reason: 'timeout', winner: 'w' })
  })

  it('draws when the side that did not flag cannot possibly mate', () => {
    // Black flags, White has a bare king: FIDE 6.9 makes it a draw, not a win.
    // Black keeps a rook so the position is not already drawn by insufficient
    // material — bare king vs bare king never reaches the clock at all.
    const state = newGame({ fen: '4k3/8/8/8/8/8/6r1/4K3 w - - 0 1' })
    const moved = playMoves(state, ['Kd1', 'Ke7'])
    const fired = server.onTimer!(ctx(), moved, CHESS_CLOCK_TIMER, moved.colors.b)
    expect(fired.state.ending).toEqual({ reason: 'timeout_vs_insufficient_material', flagged: 'b' })
  })

  it('ignores a timer id it never declared', () => {
    const state = newGame()
    expect(server.onTimer!(ctx(), state, asTimerId('nonsense'), null).state).toBe(state)
  })

  it('ignores a clock firing for a seat that is not in this match', () => {
    const state = newGame()
    expect(server.onTimer!(ctx(), state, CHESS_CLOCK_TIMER, asSeatId('seat-stranger')).state).toBe(
      state,
    )
  })
})

describe('the rest of the contract', () => {
  it('redacts a pending draw offer from spectators but not from the players', () => {
    const offered = server.applyAction(ctx(), newGame(), HOST, { type: 'offer_draw' }).state
    expect(server.getViewFor(offered, seatViewer(GUEST)).drawOffer).toEqual({
      by: 'w',
      isYours: false,
    })
    expect(server.getViewFor(offered, { kind: 'spectator' }).drawOffer).toBeNull()
  })

  it('exports the finished match as PGN', () => {
    const resigned = server.applyAction(ctx(), playMoves(newGame(), ['e4', 'e5']), HOST, {
      type: 'resign',
    }).state
    const record = server.exportRecord!(resigned, [])
    expect(record.format).toBe('pgn')
    expect(record.content).toContain('1. e4 e5')
    expect(record.content).toContain('[Result "0-1"]')
  })
})
