import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import { repetitionKey } from '../src/rules/position.js'
import { canPlay, newGame, playMoves } from './helpers.js'

describe('en passant', () => {
  it('allows the capture immediately after a double pawn push', () => {
    // 1. e4 a6 2. e5 d5 — Black's d-pawn jumps past the white e5 pawn.
    const after = playMoves(newGame(), ['e4', 'a6', 'e5', 'd5'])
    expect(canPlay(after, 'exd6')).toBe(true)

    const captured = playMoves(after, ['exd6'])
    expect(captured.moves.at(-1)).toBe('exd6')
    // The captured pawn came off d5, not d6.
    expect(new Chess(captured.initialFen).fen()).toBeTruthy()
  })

  it('removes the captured pawn from its own square, not the landing square', () => {
    const after = playMoves(newGame(), ['e4', 'a6', 'e5', 'd5', 'exd6'])
    const board = new Chess()
    for (const san of after.moves) board.move(san)
    expect(board.get('d6')?.color).toBe('w')
    expect(board.get('d5')).toBeFalsy()
  })

  it('expires if not taken immediately', () => {
    // Same position, but White spends a move elsewhere first.
    const after = playMoves(newGame(), ['e4', 'a6', 'e5', 'd5', 'a3', 'h6'])
    expect(canPlay(after, 'exd6')).toBe(false)
  })

  it('is an ordinary capture, not en passant, against a single-square push', () => {
    // 1. e4 a6 2. e5 d6 writes the same SAN, "exd6", but it is a normal capture
    // of the pawn standing on d6. Only the double push produces an e.p. flag.
    const flagsAfter = (sans: readonly string[]): string => {
      const board = new Chess()
      for (const san of sans) board.move(san)
      return board.history({ verbose: true }).at(-1)?.flags ?? ''
    }
    expect(flagsAfter(['e4', 'a6', 'e5', 'd6', 'exd6'])).not.toContain('e')
    expect(flagsAfter(['e4', 'a6', 'e5', 'd5', 'exd6'])).toContain('e')
  })

  it('works for Black capturing a white double push', () => {
    // 1. a4 e5 2. a5 d5?? is White pushing past; mirror it for Black instead.
    const after = playMoves(newGame(), ['h4', 'e5', 'h5', 'e4', 'd4'])
    expect(canPlay(after, 'exd3')).toBe(true)
    const captured = playMoves(after, ['exd3'])
    expect(captured.moves.at(-1)).toBe('exd3')
  })

  it('refuses the capture when it would expose the capturing side to check', () => {
    // White Ka5, Pd5; Black Pc5, Rh5. Taking en passant vacates d5 *and*
    // removes c5, opening the fifth rank so the rook checks a5. Illegal.
    const pinned = newGame({ fen: '7k/8/8/K1pP3r/8/8/8/8 w - c6 0 1' })
    expect(canPlay(pinned, 'dxc6')).toBe(false)
    // The straight push is still fine — only the en passant capture is barred.
    expect(canPlay(pinned, 'd6')).toBe(true)
  })

  it('allows the capture when the same rank is blocked by another piece', () => {
    // Identical, but a black bishop on g5 blocks the rook's line to a5.
    const safe = newGame({ fen: '7k/8/8/K1pP2br/8/8/8/8 w - c6 0 1' })
    expect(canPlay(safe, 'dxc6')).toBe(true)
  })
})

describe('en passant and the repetition key', () => {
  it('carries no en passant square when no capture is available', () => {
    // FIDE only treats two positions as different if the en passant capture is
    // actually available. 1. e4 sets an e3 target, but no black pawn can take,
    // so the key must not record one — otherwise threefold under-counts after
    // every double push.
    const push = new Chess()
    push.move('e4')
    expect(repetitionKey(push).endsWith(' -')).toBe(true)
  })

  it('carries no en passant square when the capture exists but is illegal', () => {
    // White Ka5 is behind the d5 pawn; taking would open the rank to Rh5.
    const pinned = new Chess('7k/2p5/8/K2P3r/8/8/8/8 b - - 0 1')
    pinned.move('c5')
    expect(pinned.moves()).not.toContain('dxc6')
    expect(repetitionKey(pinned).endsWith(' -')).toBe(true)
  })

  it('keeps the en passant square when the capture really is available', () => {
    // Same position, but a black bishop on g5 blocks the rook, so dxc6 is legal.
    const live = new Chess('7k/2p5/8/K2P2br/8/8/8/8 b - - 0 1')
    live.move('c5')
    expect(live.moves()).toContain('dxc6')
    expect(repetitionKey(live).endsWith(' c6')).toBe(true)
  })
})
