/**
 * Drives the tic-tac-toe fixture through the turn-based contract the way the
 * room runner will, and asserts the properties the contract exists to
 * guarantee: determinism, immutability, redaction, and a single definition of
 * "the match is over".
 *
 * This is the M1 proof that the contract is implementable. The reusable
 * version of these checks becomes `@playhall/game-testkit` (PER-17), which every
 * game must pass in CI.
 */

import { describe, expect, it } from 'vitest'
import {
  type GameContext,
  type Seat,
  type SeatId,
  asGameId,
  asMatchId,
  asMatchSeed,
  asPlayerId,
  asSeatId,
  asTimerId,
  audienceIncludesSeat,
  audienceIncludesSpectators,
  createGameContext,
  seatViewer,
  SPECTATOR,
} from '../src/index.js'
import {
  server,
  type TicTacToeAction,
  type TicTacToeSettings,
  type TicTacToeState,
} from './fixtures/tic-tac-toe.js'

const SEED = asMatchSeed('fixture-seed')
const seatX = asSeatId('seat-0')
const seatO = asSeatId('seat-1')

const roster: Seat[] = [
  {
    seatId: seatX,
    index: 0,
    teamId: null,
    occupant: { playerId: asPlayerId('p0'), displayName: 'Ada', isBot: false },
  },
  {
    seatId: seatO,
    index: 1,
    teamId: null,
    occupant: { playerId: asPlayerId('p1'), displayName: 'Rin', isBot: false },
  },
]

function ctx(sequence: number, seed = SEED): GameContext {
  return createGameContext({
    matchId: asMatchId('m1'),
    gameId: asGameId('tic-tac-toe'),
    gameVersion: '1.0.0',
    sdkContractVersion: 1,
    now: 1_700_000_000_000 + sequence * 1_000,
    seed,
    sequence,
  })
}

const seatOrder: TicTacToeSettings = { moveTimeoutSeconds: 30, firstMove: 'seat-order' }
const randomFirst: TicTacToeSettings = { moveTimeoutSeconds: 5, firstMove: 'random' }

/** Plays a list of cells alternately, returning the final state and all events. */
function play(cells: readonly number[], settings = seatOrder) {
  const initial = server.createInitialState(ctx(0), settings, roster)
  let state = initial.state
  const allEvents = [...initial.events]

  cells.forEach((cell, index) => {
    const seatId = state.toMove
    expect(seatId, `no seat to move at move ${index}`).not.toBeNull()
    const action: TicTacToeAction = { type: 'place', cell }

    const validation = server.validateAction(ctx(index + 1), state, seatId as SeatId, action)
    expect(validation.ok, `move ${index} (cell ${cell}) should be legal`).toBe(true)

    const applied = server.applyAction(ctx(index + 1), state, seatId as SeatId, action)
    state = applied.state
    allEvents.push(...applied.events)
  })

  return { state, events: allEvents }
}

describe('determinism', () => {
  it('same seed and same inputs produce an identical state', () => {
    const a = play([0, 3, 1, 4, 2])
    const b = play([0, 3, 1, 4, 2])
    expect(a.state).toEqual(b.state)
    expect(a.events).toEqual(b.events)
  })

  it('a different seed changes a random coin flip', () => {
    // `firstMove: 'random'` is the fixture's only use of ctx.rng, so a seed
    // that flips it is the observable proof the stream reaches the game.
    const marks = (seed: string) =>
      server.createInitialState(ctx(0, asMatchSeed(seed)), randomFirst, roster).state.seatMarks[0]
        ?.seatId

    const seeds = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']
    const outcomes = new Set(seeds.map(marks))
    expect(outcomes.size).toBe(2)
  })

  it('the same seed always produces the same coin flip', () => {
    const first = server.createInitialState(ctx(0), randomFirst, roster).state.seatMarks
    const again = server.createInitialState(ctx(0), randomFirst, roster).state.seatMarks
    expect(first).toEqual(again)
  })

  it('replaying the log from the start reproduces the final state', () => {
    const live = play([4, 0, 8, 2, 1, 7, 6])
    const replayed = play([4, 0, 8, 2, 1, 7, 6])
    expect(replayed.state).toEqual(live.state)
    expect(server.getResult(replayed.state)).toEqual(server.getResult(live.state))
  })
})

describe('applyAction purity', () => {
  it('does not mutate the state it was given', () => {
    const { state } = server.createInitialState(ctx(0), seatOrder, roster)
    const before = structuredClone(state)

    server.applyAction(ctx(1), state, seatX, { type: 'place', cell: 0 })

    expect(state).toEqual(before)
  })

  it('returns a new state object, not the same reference', () => {
    const { state } = server.createInitialState(ctx(0), seatOrder, roster)
    const next = server.applyAction(ctx(1), state, seatX, { type: 'place', cell: 0 })
    expect(next.state).not.toBe(state)
  })

  it('validateAction does not mutate state', () => {
    const { state } = server.createInitialState(ctx(0), seatOrder, roster)
    const before = structuredClone(state)
    server.validateAction(ctx(1), state, seatX, { type: 'place', cell: 0 })
    server.validateAction(ctx(1), state, seatO, { type: 'place', cell: 0 })
    expect(state).toEqual(before)
  })

  it('state survives a JSON round trip', () => {
    const { state } = play([0, 3, 1])
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })
})

describe('validateAction', () => {
  it('rejects a move from the seat that is not to move', () => {
    const { state } = server.createInitialState(ctx(0), seatOrder, roster)
    const rejection = server.validateAction(ctx(1), state, seatO, { type: 'place', cell: 0 })
    expect(rejection.ok).toBe(false)
    expect(rejection.ok === false && rejection.error.code).toBe('not_your_turn')
  })

  it('rejects a seat that is not in the match', () => {
    const { state } = server.createInitialState(ctx(0), seatOrder, roster)
    const rejection = server.validateAction(ctx(1), state, asSeatId('spectator'), {
      type: 'place',
      cell: 0,
    })
    expect(rejection.ok === false && rejection.error.code).toBe('not_seated')
  })

  it('rejects an occupied cell and says which one', () => {
    const { state } = play([4])
    const rejection = server.validateAction(ctx(2), state, seatO, { type: 'place', cell: 4 })
    expect(rejection.ok === false && rejection.error.code).toBe('illegal_action')
    expect(rejection.ok === false && rejection.error.params).toEqual({ cell: 4 })
  })

  it('rejects any action once the match is over', () => {
    const { state } = play([0, 3, 1, 4, 2])
    expect(server.getResult(state)).not.toBeNull()
    const rejection = server.validateAction(ctx(9), state, seatO, { type: 'place', cell: 5 })
    expect(rejection.ok === false && rejection.error.code).toBe('match_over')
  })

  it('agrees with getLegalActions', () => {
    const { state } = play([4, 0])
    const seatId = state.toMove as SeatId
    const legal = server.getLegalActions?.(state, seatId) ?? []
    expect(legal.length).toBeGreaterThan(0)
    for (const action of legal) {
      expect(server.validateAction(ctx(3), state, seatId, action).ok, JSON.stringify(action)).toBe(
        true,
      )
    }
  })

  it('offers no legal actions once the match is over', () => {
    const { state } = play([0, 3, 1, 4, 2])
    expect(server.getLegalActions?.(state, seatX)).toEqual([])
  })
})

describe('actionSchema', () => {
  it('accepts well-formed actions', () => {
    expect(server.actionSchema.safeParse({ type: 'place', cell: 4 }).success).toBe(true)
    expect(server.actionSchema.safeParse({ type: 'resign' }).success).toBe(true)
  })

  it('rejects out-of-range and unknown actions before the game sees them', () => {
    expect(server.actionSchema.safeParse({ type: 'place', cell: 9 }).success).toBe(false)
    expect(server.actionSchema.safeParse({ type: 'place', cell: -1 }).success).toBe(false)
    expect(server.actionSchema.safeParse({ type: 'place', cell: 1.5 }).success).toBe(false)
    expect(server.actionSchema.safeParse({ type: 'teleport' }).success).toBe(false)
    expect(server.actionSchema.safeParse({ type: 'place' }).success).toBe(false)
  })
})

describe('getViewFor redaction', () => {
  it('gives each seat its own mark and never the mark of the other seat', () => {
    const { state } = play([4])
    expect(server.getViewFor(state, seatViewer(seatX)).yourMark).toBe('x')
    expect(server.getViewFor(state, seatViewer(seatO)).yourMark).toBe('o')
  })

  it('gives a spectator no seat-specific information', () => {
    const { state } = play([4])
    expect(server.getViewFor(state, SPECTATOR).yourMark).toBeNull()
  })

  it('never leaks internal state fields into a view', () => {
    const { state } = play([4, 0])
    const view = server.getViewFor(state, seatViewer(seatX))
    // `seatMarks` is how the game maps seats to marks; a view that carried it
    // would tell every client what every other seat holds.
    expect(view).not.toHaveProperty('seatMarks')
    expect(view).not.toHaveProperty('resignedBy')
    expect(view).not.toHaveProperty('moveTimeoutMs')
  })

  it('produces a JSON-serialisable view for every viewer kind', () => {
    const { state } = play([4, 0, 8])
    for (const viewer of [seatViewer(seatX), seatViewer(seatO), SPECTATOR]) {
      const view = server.getViewFor(state, viewer)
      expect(JSON.parse(JSON.stringify(view))).toEqual(view)
    }
  })
})

describe('event audiences', () => {
  it('every emitted event declares an audience', () => {
    const { events } = play([0, 3, 1, 4, 2])
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event.audience).toBeDefined()
      expect(['public', 'seats', 'spectators', 'server']).toContain(event.audience.kind)
    }
  })

  it('routes public events to both seats and spectators', () => {
    const { events } = play([4])
    const placed = events.find((event) => event.type === 'placed')
    expect(placed).toBeDefined()
    expect(audienceIncludesSeat(placed!.audience, seatO)).toBe(true)
    expect(audienceIncludesSpectators(placed!.audience)).toBe(true)
  })
})

describe('getResult', () => {
  it('is null while the match is live', () => {
    const { state } = play([4, 0])
    expect(server.getResult(state)).toBeNull()
  })

  it('reports a win with ranks 1 and 2', () => {
    const { state } = play([0, 3, 1, 4, 2])
    const result = server.getResult(state)
    expect(result?.reason).toBe('completed')
    expect(result?.standings).toEqual([
      { seatId: seatX, rank: 1, outcome: 'win' },
      { seatId: seatO, rank: 2, outcome: 'loss' },
    ])
  })

  it('reports a draw on a full board with no line', () => {
    const { state } = play([4, 0, 8, 2, 1, 7, 3, 5, 6])
    const result = server.getResult(state)
    expect(result?.reason).toBe('completed')
    expect(result?.standings.every((standing) => standing.outcome === 'draw')).toBe(true)
  })

  it('reports a resignation as a loss for the resigning seat', () => {
    const { state } = play([4])
    const resigned = server.applyAction(ctx(2), state, seatO, { type: 'resign' })
    const result = server.getResult(resigned.state)
    expect(result?.reason).toBe('resignation')
    expect(result?.standings.find((s) => s.seatId === seatO)?.outcome).toBe('loss')
    expect(result?.standings.find((s) => s.seatId === seatX)?.outcome).toBe('win')
  })

  it('reports a timeout as a loss for the seat on the clock', () => {
    const { state } = play([4])
    const expired = server.onTimer!(ctx(2), state, asTimerId('move'), seatO)
    const result = server.getResult(expired.state)
    expect(result?.reason).toBe('timeout')
    expect(result?.standings.find((s) => s.seatId === seatO)?.outcome).toBe('loss')
  })

  it('every standing names a seat that is actually in the match', () => {
    const { state } = play([0, 3, 1, 4, 2])
    const seats = [seatX, seatO]
    for (const standing of server.getResult(state)?.standings ?? []) {
      expect(seats).toContain(standing.seatId)
    }
    expect(server.getResult(state)?.standings).toHaveLength(seats.length)
  })
})

describe('timers', () => {
  it('starts a move clock for the opening seat', () => {
    const initial = server.createInitialState(ctx(0), seatOrder, roster)
    expect(initial.timers).toEqual([{ op: 'set', timerId: 'move', seatId: seatX, delayMs: 30_000 }])
  })

  it('honours the configured move timeout from settings', () => {
    const initial = server.createInitialState(
      ctx(0),
      { ...seatOrder, moveTimeoutSeconds: 12 },
      roster,
    )
    expect(initial.timers?.[0]).toMatchObject({ delayMs: 12_000 })
  })

  it('hands the clock to the other seat after a move', () => {
    const { state } = server.createInitialState(ctx(0), seatOrder, roster)
    const applied = server.applyAction(ctx(1), state, seatX, { type: 'place', cell: 0 })
    expect(applied.timers?.[0]).toMatchObject({ op: 'set', seatId: seatO })
  })

  it('clears the clock when the match ends', () => {
    const { state } = play([0, 3, 1, 4])
    const winning = server.applyAction(ctx(5), state, seatX, { type: 'place', cell: 2 })
    expect(server.getResult(winning.state)).not.toBeNull()
    expect(winning.timers).toEqual([{ op: 'clear', timerId: 'move' }])
  })

  it('only references timer ids the manifest declares', () => {
    const initial = server.createInitialState(ctx(0), seatOrder, roster)
    const { state } = play([0])
    const applied = server.applyAction(ctx(2), state, seatO, { type: 'place', cell: 3 })
    const declared = new Set(['move'])
    for (const command of [...(initial.timers ?? []), ...(applied.timers ?? [])]) {
      expect(declared).toContain(command.timerId)
    }
  })
})

describe('disconnect policy and record export', () => {
  it('declares a forfeit policy with a grace window', () => {
    expect(server.disconnectPolicy.onGraceExpired).toBe('forfeit')
    expect(server.disconnectPolicy.graceMs).toBeGreaterThan(0)
    expect(server.disconnectPolicy.allowReconnectUntilMatchEnd).toBe(true)
  })

  it('exports a record for a finished match', () => {
    const { state } = play([0, 3, 1, 4, 2])
    const record = server.exportRecord!(state, [])
    expect(record.mimeType).toBe('application/json')
    expect(JSON.parse(record.content)).toMatchObject({ moves: 5 })
  })
})

describe('createInitialState', () => {
  it('rejects a roster that cannot fill the game', () => {
    const solo = [roster[0] as Seat]
    expect(() => server.createInitialState(ctx(0), seatOrder, solo)).toThrow()
  })

  it('assigns x and o to distinct seats', () => {
    const { state }: { state: TicTacToeState } = server.createInitialState(
      ctx(0),
      seatOrder,
      roster,
    )
    expect(state.seatMarks.map((entry) => entry.mark).sort()).toEqual(['o', 'x'])
    expect(new Set(state.seatMarks.map((entry) => entry.seatId)).size).toBe(2)
    expect(state.toMove).toBe(seatX)
  })
})
