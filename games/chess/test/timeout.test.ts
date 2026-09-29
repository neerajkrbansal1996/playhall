import { describe, expect, it } from 'vitest'
import { canPossiblyMate } from '../src/rules/material.js'
import { getResult } from '../src/result.js'
import { applyAction } from '../src/state.js'
import { ctx, newGame, seatOf } from './helpers.js'

/** Flag `color`, going through the reducer the way the platform clock would. */
function flag(fen: string, color: 'w' | 'b') {
  const game = newGame({ fen })
  const result = applyAction(game, { type: 'flag', color }, null, ctx())
  if (!result.ok) throw new Error(`flag rejected: ${result.error}`)
  return result.state
}

describe('canPossiblyMate — the material test behind FIDE 6.9', () => {
  const cases: ReadonlyArray<readonly [string, string, 'w' | 'b', boolean]> = [
    ['a bare king cannot mate', '4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'w', false],
    ['king and one knight cannot mate', '4k3/8/8/8/8/8/8/3NK3 w - - 0 1', 'w', false],
    ['king and one bishop cannot mate', '4k3/8/8/8/8/8/8/3BK3 w - - 0 1', 'w', false],
    // c1 and g1 are both dark squares; c1 and f1 are opposite colours.
    ['king and two same-colour bishops cannot mate', '4k3/8/8/8/8/8/8/2B1K1B1 w - - 0 1', 'w', false],
    ['king and two opposite-colour bishops CAN mate', '4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1', 'w', true],
    ['king and two knights CAN mate (it just cannot be forced)', '4k3/8/8/8/8/8/8/1N1NK3 w - - 0 1', 'w', true],
    ['king, bishop and knight CAN mate', '4k3/8/8/8/8/8/8/2BNK3 w - - 0 1', 'w', true],
    ['king and a pawn CAN mate', '4k3/8/8/8/8/8/P7/4K3 w - - 0 1', 'w', true],
    ['king and a rook CAN mate', '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'w', true],
    ['king and a queen CAN mate', '4k3/8/8/8/8/8/8/Q3K3 w - - 0 1', 'w', true],
    ['the test is per side — Black is bare here', '4k3/8/8/8/8/8/8/Q3K3 w - - 0 1', 'b', false],
  ]

  for (const [name, fen, color, expected] of cases) {
    it(name, () => {
      expect(canPossiblyMate(fen, color)).toBe(expected)
    })
  }
})

describe('timeout', () => {
  it('gives the win to the opponent when they can still mate', () => {
    // Black flags; White has a queen.
    const after = flag('4k3/8/8/8/8/8/8/Q3K3 b - - 0 1', 'b')
    expect(after.ending).toEqual({ reason: 'timeout', winner: 'w' })
    expect(getResult(after)).toEqual({
      reason: 'timeout',
      standings: [
        { seatId: seatOf(after, 'w'), rank: 1, score: 1, outcome: 'win' },
        { seatId: seatOf(after, 'b'), rank: 2, score: 0, outcome: 'loss' },
      ],
      detail: {
        chessReason: 'timeout',
        description: 'Black ran out of time',
        moves: 0,
        recorded: true,
      },
    })
  })

  it('DRAWS when the side that did not flag has only a bare king', () => {
    // Black has a queen and flags anyway; White cannot mate with a lone king,
    // so FIDE 6.9 makes it a draw, not a win for White.
    const after = flag('4k3/8/8/8/8/8/q7/4K3 w - - 0 1', 'b')
    expect(after.ending).toEqual({
      reason: 'timeout_vs_insufficient_material',
      flagged: 'b',
    })
    expect(getResult(after)).toEqual({
      // Still `timeout` to the platform, but a draw in the standings.
      reason: 'timeout',
      standings: [
        { seatId: seatOf(after, 'w'), rank: 1, score: 0.5, outcome: 'draw' },
        { seatId: seatOf(after, 'b'), rank: 1, score: 0.5, outcome: 'draw' },
      ],
      detail: {
        chessReason: 'timeout_vs_insufficient_material',
        description: 'Black ran out of time, but White cannot checkmate',
        moves: 0,
        recorded: true,
      },
    })
  })

  it('DRAWS when the side that did not flag has only king and knight', () => {
    const after = flag('4k3/8/8/8/8/8/r7/3NK3 w - - 0 1', 'b')
    expect(after.ending).toEqual({
      reason: 'timeout_vs_insufficient_material',
      flagged: 'b',
    })
  })

  it('DRAWS when the side that did not flag has only king and bishop', () => {
    const after = flag('4k3/8/8/8/8/8/r7/3BK3 w - - 0 1', 'b')
    expect(getResult(after)?.standings.every((s) => s.outcome === 'draw')).toBe(true)
  })

  it('WINS when the side that did not flag has two knights', () => {
    // Two knights cannot force mate, but mate is reachable, so the flag counts.
    const after = flag('4k3/8/8/8/8/8/r7/1N1NK3 w - - 0 1', 'b')
    expect(after.ending).toEqual({ reason: 'timeout', winner: 'w' })
  })

  it('WINS when the side that did not flag has a single pawn', () => {
    const after = flag('4k3/8/8/8/8/8/P6r/4K3 w - - 0 1', 'b')
    expect(after.ending).toEqual({ reason: 'timeout', winner: 'w' })
  })

  it('applies the same rule when White flags', () => {
    const after = flag('4k3/8/8/8/8/8/8/n3K3 b - - 0 1', 'w')
    expect(after.ending).toEqual({
      reason: 'timeout_vs_insufficient_material',
      flagged: 'w',
    })
  })

  it('is refused once the game is already over', () => {
    const finished = flag('4k3/8/8/8/8/8/8/Q3K3 b - - 0 1', 'b')
    expect(applyAction(finished, { type: 'flag', color: 'w' }, null, ctx())).toEqual({
      ok: false,
      error: 'game_over',
    })
  })
})
