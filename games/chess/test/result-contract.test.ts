import { describe, expect, it } from 'vitest'
import { getResult, scoreLine } from '../src/result.js'
import type { ChessEnding, EndingReason } from '../src/rules/types.js'
import {
  isRecordedResult,
  validateMatchResult,
  type MatchResult,
  type SeatId,
} from '../src/sdk/contract.js'
import type { ChessMatchState } from '../src/state.js'
import { GUEST, HOST, newGame } from './helpers.js'

/**
 * Chess against the ADR-0006 `MatchResult` contract.
 *
 * `validateMatchResult` is the SDK's own checker — the same function the
 * `result-standings-well-formed` conformance check runs — so these tests prove
 * the alignment rather than restating it. Asserting on hand-written expected
 * standings, as the per-ending suites do, cannot catch an arity or ranking rule
 * that chess and the platform quietly disagree about. Asking the platform can.
 *
 * Every arm of `ChessEnding` is exercised. The table is typed so that adding a
 * new arm fails to compile here until its result is checked too, which is the
 * point: an end condition nobody validated is the bug this file exists to stop.
 */
type EndingArms = { readonly [R in EndingReason]: Extract<ChessEnding, { reason: R }> }

const ARMS: EndingArms = {
  checkmate: { reason: 'checkmate', winner: 'w' },
  stalemate: { reason: 'stalemate' },
  insufficient_material: { reason: 'insufficient_material' },
  threefold_repetition: { reason: 'threefold_repetition', claimedBy: 'w' },
  fivefold_repetition: { reason: 'fivefold_repetition' },
  fifty_move_rule: { reason: 'fifty_move_rule', claimedBy: 'b' },
  seventy_five_move_rule: { reason: 'seventy_five_move_rule' },
  resignation: { reason: 'resignation', winner: 'b' },
  draw_agreement: { reason: 'draw_agreement' },
  timeout: { reason: 'timeout', winner: 'w' },
  timeout_vs_insufficient_material: { reason: 'timeout_vs_insufficient_material', flagged: 'b' },
  abandonment: { reason: 'abandonment', winner: 'w' },
  abandonment_draw: { reason: 'abandonment_draw' },
  abort: { reason: 'abort', cause: 'agreed' },
}

const ARM_LIST = Object.values(ARMS) as readonly ChessEnding[]

/** The seat roster the platform would hand `validateMatchResult`. */
const SEATS: readonly SeatId[] = [HOST, GUEST]

/**
 * A finished match sitting on a given ending.
 *
 * The ending is set directly rather than played out: whether the reducer can
 * *reach* each arm is what `end-conditions`, `timeout` and `player-endings`
 * already cover, each with a FEN. What is under test here is the mapping from
 * an arm to a contract-valid `MatchResult`, and an exhaustive table over every
 * arm — including the seventy-five-move rule — is only affordable this way.
 */
function endedOn(ending: ChessEnding): ChessMatchState {
  return { ...newGame(), phase: 'finished', ending }
}

/** The result for an ending, which is never `null` on a finished match. */
function resultFor(ending: ChessEnding): MatchResult {
  const result = getResult(endedOn(ending))
  if (result === null) throw new Error(`${ending.reason} produced no result`)
  return result
}

describe('every ChessEnding arm produces a contract-valid MatchResult', () => {
  it('covers every arm of the union', () => {
    // Fourteen, matching ADR-0006 §"Consequences" and the note at §2. PER-42
    // said "eleven" throughout because it predates the fivefold and
    // seventy-five-move arms that split the automatic draws out from their
    // claimable partners; the ADR was corrected to fourteen rather than the
    // issue. This assertion is the tripwire that keeps the two in step.
    expect(ARM_LIST).toHaveLength(14)
    expect(new Set(ARM_LIST.map((arm) => arm.reason)).size).toBe(14)
  })

  for (const ending of ARM_LIST) {
    it(`${ending.reason} passes validateMatchResult`, () => {
      // Empty means valid, and the problem list is printed on failure, so a
      // broken arm names its own problem code instead of failing a bare count.
      expect(validateMatchResult(resultFor(ending), SEATS)).toEqual([])
    })
  }
})

describe('the platform owns "did this count"', () => {
  it('never authors a recorded flag in detail', () => {
    for (const ending of ARM_LIST) {
      // ADR-0006 §4: these three keys are chess's version-pinned public
      // surface. `recorded` is not among them — §2 gives that answer to
      // `isRecordedResult`, and a game asserting it is a second source of
      // truth with no tiebreak.
      expect(Object.keys(resultFor(ending).detail ?? {}).sort()).toEqual([
        'chessReason',
        'description',
        'moves',
      ])
    }
  })

  it('agrees with isRecordedResult: only an abort did not count', () => {
    const unrecorded = ARM_LIST.filter((ending) => !isRecordedResult(resultFor(ending))).map(
      (ending) => ending.reason,
    )

    expect(unrecorded).toEqual(['abort'])
  })

  it('returns empty standings for exactly the unrecorded arms', () => {
    for (const ending of ARM_LIST) {
      const result = resultFor(ending)
      expect(result.standings).toHaveLength(isRecordedResult(result) ? SEATS.length : 0)
    }
  })

  it('maps the abort arm to reason "aborted" with no standings', () => {
    for (const cause of ['agreed', 'first_move_timeout'] as const) {
      const result = resultFor({ reason: 'abort', cause })
      expect(result.reason).toBe('aborted')
      expect(result.standings).toEqual([])
      expect(validateMatchResult(result, SEATS)).toEqual([])
    }
  })

  it('exports PGN "*" for exactly the matches that did not count', () => {
    for (const ending of ARM_LIST) {
      const state = endedOn(ending)
      expect(scoreLine(state) === '*').toBe(!isRecordedResult(resultFor(ending)))
    }
  })

  it('still returns null — not an unrecorded result — while the game runs', () => {
    const running = newGame()
    expect(getResult(running)).toBeNull()
    expect(scoreLine(running)).toBe('*')
  })
})

describe('validateMatchResult catches a broken chess result', () => {
  // A guard on the guard: if the validator were vacuous, every assertion above
  // would pass no matter what chess returned.
  it('rejects populated standings on an unrecorded reason', () => {
    const bogus: MatchResult = {
      ...resultFor({ reason: 'abort', cause: 'agreed' }),
      standings: [{ seatId: HOST, rank: 1, outcome: 'win' }],
    }
    expect(validateMatchResult(bogus, SEATS)).toEqual([
      { code: 'standings_arity', reason: 'aborted', expected: 0, actual: 1 },
    ])
  })

  it('rejects a recorded reason whose standings miss a seat', () => {
    const mated = resultFor(ARMS.checkmate)
    const winner = mated.standings.filter((standing) => standing.outcome === 'win')
    const bogus: MatchResult = { ...mated, standings: winner }

    expect(winner).toHaveLength(1)
    expect(validateMatchResult(bogus, SEATS)).toEqual([
      { code: 'standings_arity', reason: 'completed', expected: 2, actual: 1 },
      { code: 'missing_seat', seatId: GUEST },
    ])
  })
})
