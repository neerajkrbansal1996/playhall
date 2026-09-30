/**
 * The `MatchResult` contract from ADR-0006.
 *
 * The cases that matter are the ones a game gets wrong: an abort that still
 * carries standings, a real result that is missing a seat, and a draw ranked
 * 1, 1, 2 instead of 1, 1.
 */

import { describe, expect, it } from 'vitest'
import {
  RESULT_REASONS,
  UNRECORDED_RESULT_REASONS,
  asSeatId,
  drawStandings,
  isRecordedResult,
  standingsFromWinners,
  unrecordedStandings,
  validateMatchResult,
  type MatchResult,
  type ResultReason,
  type SeatId,
  type Standing,
} from '../src/index.js'

const WHITE = asSeatId('w')
const BLACK = asSeatId('b')
const SEATS: readonly SeatId[] = [WHITE, BLACK]

function result(reason: ResultReason, standings: readonly Standing[]): MatchResult {
  return { reason, standings }
}

describe('isRecordedResult', () => {
  it('partitions every reason, with aborted and abandoned the only unrecorded ones', () => {
    const unrecorded = RESULT_REASONS.filter((reason) => !isRecordedResult(result(reason, [])))
    expect([...unrecorded].sort()).toEqual([...UNRECORDED_RESULT_REASONS].sort())
    expect(unrecorded).toHaveLength(2)
  })

  it('reads the reason, not the standings — a game cannot vote on whether it counts', () => {
    // The shape chess used to emit: aborted, but claiming it was recorded.
    const lying: MatchResult = {
      reason: 'aborted',
      standings: standingsFromWinners(SEATS, [WHITE]),
      detail: { recorded: true },
    }
    expect(isRecordedResult(lying)).toBe(false)
  })
})

describe('validateMatchResult', () => {
  it('accepts a win/loss result with one standing per seat', () => {
    expect(
      validateMatchResult(result('completed', standingsFromWinners(SEATS, [WHITE])), SEATS),
    ).toEqual([])
  })

  it('accepts a draw as a shared rank 1', () => {
    expect(validateMatchResult(result('agreed_draw', drawStandings(SEATS)), SEATS)).toEqual([])
  })

  it('accepts an unrecorded reason with empty standings', () => {
    for (const reason of UNRECORDED_RESULT_REASONS) {
      expect(validateMatchResult(result(reason, unrecordedStandings()), SEATS)).toEqual([])
    }
  })

  it('accepts reason and outcome disagreeing — timeout can be a draw', () => {
    // chess: timeout_vs_insufficient_material. Nothing may infer a loser here.
    expect(validateMatchResult(result('timeout', drawStandings(SEATS)), SEATS)).toEqual([])
  })

  it('rejects an unrecorded reason that still carries standings', () => {
    const problems = validateMatchResult(
      result('aborted', standingsFromWinners(SEATS, [WHITE])),
      SEATS,
    )
    expect(problems).toEqual([
      { code: 'standings_arity', reason: 'aborted', expected: 0, actual: 2 },
    ])
  })

  it('rejects a recorded result with empty standings — the forgotten-standings bug', () => {
    const problems = validateMatchResult(result('completed', []), SEATS)
    expect(problems).toContainEqual({
      code: 'standings_arity',
      reason: 'completed',
      expected: 2,
      actual: 0,
    })
  })

  it('names the seat a partial roster left out', () => {
    const problems = validateMatchResult(
      result('completed', [{ seatId: WHITE, rank: 1, outcome: 'win' }]),
      SEATS,
    )
    expect(problems).toContainEqual({ code: 'missing_seat', seatId: BLACK })
  })

  it('rejects a seat that is not in the match', () => {
    const ghost = asSeatId('ghost')
    const problems = validateMatchResult(
      result('completed', [
        { seatId: WHITE, rank: 1, outcome: 'win' },
        { seatId: ghost, rank: 2, outcome: 'loss' },
      ]),
      SEATS,
    )
    expect(problems).toContainEqual({ code: 'unknown_seat', seatId: ghost })
  })

  it('rejects the same seat placed twice', () => {
    const problems = validateMatchResult(
      result('completed', [
        { seatId: WHITE, rank: 1, outcome: 'win' },
        { seatId: WHITE, rank: 2, outcome: 'loss' },
      ]),
      SEATS,
    )
    expect(problems).toContainEqual({ code: 'duplicate_seat', seatId: WHITE })
    expect(problems).toContainEqual({ code: 'missing_seat', seatId: BLACK })
  })

  it('rejects a rank below 1 or non-integer', () => {
    const problems = validateMatchResult(
      result('completed', [
        { seatId: WHITE, rank: 0, outcome: 'win' },
        { seatId: BLACK, rank: 1.5, outcome: 'loss' },
      ]),
      SEATS,
    )
    expect(problems).toContainEqual({ code: 'bad_rank', seatId: WHITE, rank: 0 })
    expect(problems).toContainEqual({ code: 'bad_rank', seatId: BLACK, rank: 1.5 })
  })

  it('requires competition ranking: a two-way tie is 1, 1, 3 — never 1, 1, 2', () => {
    const third = asSeatId('c')
    const seats = [WHITE, BLACK, third]
    expect(
      validateMatchResult(
        result('completed', [
          { seatId: WHITE, rank: 1, outcome: 'draw' },
          { seatId: BLACK, rank: 1, outcome: 'draw' },
          { seatId: third, rank: 3, outcome: 'loss' },
        ]),
        seats,
      ),
    ).toEqual([])

    expect(
      validateMatchResult(
        result('completed', [
          { seatId: WHITE, rank: 1, outcome: 'draw' },
          { seatId: BLACK, rank: 1, outcome: 'draw' },
          { seatId: third, rank: 2, outcome: 'loss' },
        ]),
        seats,
      ),
    ).toContainEqual({ code: 'rank_not_competition_ordered', rank: 2, expected: 3 })
  })

  it('rejects standings that never reach rank 1', () => {
    expect(
      validateMatchResult(
        result('completed', [
          { seatId: WHITE, rank: 2, outcome: 'loss' },
          { seatId: BLACK, rank: 3, outcome: 'loss' },
        ]),
        SEATS,
      ),
    ).toContainEqual({ code: 'rank_not_competition_ordered', rank: 2, expected: 1 })
  })
})

describe('standings helpers', () => {
  it('standingsFromWinners produces a contract-valid result', () => {
    expect(standingsFromWinners(SEATS, [BLACK])).toEqual([
      { seatId: WHITE, rank: 2, outcome: 'loss' },
      { seatId: BLACK, rank: 1, outcome: 'win' },
    ])
  })

  it('drawStandings puts every seat at rank 1', () => {
    expect(drawStandings(SEATS).every((standing) => standing.rank === 1)).toBe(true)
  })

  it('unrecordedStandings is empty', () => {
    expect(unrecordedStandings()).toEqual([])
  })
})
