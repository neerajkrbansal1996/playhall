import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import { exportRecord } from '../src/record.js'
import { scoreLine } from '../src/result.js'
import { applyAction } from '../src/state.js'
import { ctx, newGame, playMoves, seatOf } from './helpers.js'

describe('exportRecord — PGN', () => {
  it('exports the move text and a checkmate result', () => {
    const game = playMoves(newGame(), ['f3', 'e5', 'g4', 'Qh4'])
    const record = exportRecord(game, { playerNames: { w: 'Ada', b: 'Linus' } })

    expect(record.format).toBe('pgn')
    expect(record.mimeType).toBe('application/x-chess-pgn')
    expect(record.content).toContain('[White "Ada"]')
    expect(record.content).toContain('[Black "Linus"]')
    expect(record.content).toContain('[Result "0-1"]')
    expect(record.content).toContain('[Termination "Black wins by checkmate"]')
    expect(record.content).toContain('1. f3 e5 2. g4 Qh4#')
  })

  it('round-trips: re-importing the PGN reproduces the position', () => {
    const game = playMoves(newGame(), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'])
    const reloaded = new Chess()
    reloaded.loadPgn(exportRecord(game).content)
    expect(reloaded.history()).toEqual([...game.moves])
  })

  it('writes 1-0 when White wins and 1/2-1/2 for a draw', () => {
    const resigned = playMoves(newGame(), ['e4', 'e5'])
    const blackResigns = applyAction(resigned, { type: 'resign' }, seatOf(resigned, 'b'), ctx())
    if (!blackResigns.ok) throw new Error(blackResigns.error)
    expect(scoreLine(blackResigns.state)).toBe('1-0')
    expect(exportRecord(blackResigns.state).content).toContain('[Result "1-0"]')

    const offered = applyAction(resigned, { type: 'offer_draw' }, seatOf(resigned, 'w'), ctx())
    if (!offered.ok) throw new Error(offered.error)
    const agreed = applyAction(offered.state, { type: 'accept_draw' }, seatOf(resigned, 'b'), ctx())
    if (!agreed.ok) throw new Error(agreed.error)
    expect(scoreLine(agreed.state)).toBe('1/2-1/2')
    expect(exportRecord(agreed.state).content).toContain('[Termination "Draw by agreement"]')
  })

  it('writes * for a game still in progress', () => {
    const game = playMoves(newGame(), ['e4'])
    expect(scoreLine(game)).toBe('*')
    expect(exportRecord(game).content).toContain('[Result "*"]')
  })

  it('writes * for an aborted game, because an abort records no result', () => {
    const game = newGame()
    const aborted = applyAction(game, { type: 'abort' }, seatOf(game, 'w'), ctx())
    if (!aborted.ok) throw new Error(aborted.error)
    expect(scoreLine(aborted.state)).toBe('*')
    expect(exportRecord(aborted.state).content).toContain('[Result "*"]')
  })

  it('emits SetUp and FEN headers for a non-standard starting position', () => {
    const fen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1'
    const record = exportRecord(playMoves(newGame({ fen }), ['a8=Q']))
    expect(record.content).toContain('[SetUp "1"]')
    expect(record.content).toContain(`[FEN "${fen}"]`)
  })

  it('omits SetUp for a normal game', () => {
    expect(exportRecord(playMoves(newGame(), ['e4'])).content).not.toContain('[SetUp')
  })

  it('takes the date from the caller rather than reading the clock', () => {
    const record = exportRecord(newGame(), { date: '2026.09.30', event: 'Test match' })
    expect(record.content).toContain('[Date "2026.09.30"]')
    expect(record.content).toContain('[Event "Test match"]')
  })
})
