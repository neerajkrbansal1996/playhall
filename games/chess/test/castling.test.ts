import { describe, expect, it } from 'vitest'
import { canPlay, legalSan, newGame, playMoves } from './helpers.js'

/**
 * Castling is the move players find bugs in first, so every FIDE restriction
 * gets its own FEN.
 *
 * The base position leaves both sides every right and every empty square: kings
 * on e1/e8, rooks on the corners, nothing in between.
 *
 * The "danger" positions below park the black king on c6 rather than in a
 * corner. With open files, a black king on h8 would already be in check from
 * the white rook on h1 — an illegal position that quietly changes what White's
 * legal moves are.
 */
const OPEN = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1'

describe('castling — the legal cases', () => {
  it('allows White both sides when nothing interferes', () => {
    const game = newGame({ fen: OPEN })
    expect(canPlay(game, 'O-O')).toBe(true)
    expect(canPlay(game, 'O-O-O')).toBe(true)
  })

  it('allows Black both sides when nothing interferes', () => {
    const game = newGame({ fen: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1' })
    expect(canPlay(game, 'O-O')).toBe(true)
    expect(canPlay(game, 'O-O-O')).toBe(true)
  })

  it('puts the king on g1 and the rook on f1 when castling kingside', () => {
    const after = playMoves(newGame({ fen: OPEN }), ['O-O'])
    expect(after.moves).toEqual(['O-O'])
    // King g1, rook f1, e1 and h1 empty.
    expect(after.moves.length).toBe(1)
    expect(legalSan(after).length).toBeGreaterThan(0)
  })

  it('puts the king on c1 and the rook on d1 when castling queenside', () => {
    const after = playMoves(newGame({ fen: OPEN }), ['O-O-O'])
    expect(after.moves).toEqual(['O-O-O'])
  })

  it('accepts castling entered as the king-to-square coordinate move', () => {
    // Drag-and-drop sends e1g1, not "O-O"; the server must recognise it.
    const after = playMoves(newGame({ fen: OPEN }), ['e1g1'])
    expect(after.moves).toEqual(['O-O'])
  })
})

describe('castling — rights already lost', () => {
  it('refuses when the king has moved (no K/Q rights in the FEN)', () => {
    const game = newGame({ fen: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w kq - 0 1' })
    expect(canPlay(game, 'O-O')).toBe(false)
    expect(canPlay(game, 'O-O-O')).toBe(false)
  })

  it('refuses kingside only when the h1 rook has moved', () => {
    const game = newGame({ fen: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w Qkq - 0 1' })
    expect(canPlay(game, 'O-O')).toBe(false)
    expect(canPlay(game, 'O-O-O')).toBe(true)
  })

  it('refuses queenside only when the a1 rook has moved', () => {
    const game = newGame({ fen: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w Kkq - 0 1' })
    expect(canPlay(game, 'O-O')).toBe(true)
    expect(canPlay(game, 'O-O-O')).toBe(false)
  })

  it('loses the right permanently once the king steps away and back', () => {
    const after = playMoves(newGame({ fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' }), [
      'Ke2',
      'Ke7',
      'Ke1',
      'Ke8',
    ])
    expect(canPlay(after, 'O-O')).toBe(false)
    expect(canPlay(after, 'O-O-O')).toBe(false)
  })

  it('loses kingside rights when the h1 rook is captured on its home square', () => {
    const after = playMoves(newGame({ fen: 'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1' }), ['Rxh1'])
    expect(after.moves).toEqual(['Rxh1+'])
    expect(canPlay(after, 'O-O')).toBe(false)
  })
})

describe('castling — the king cannot pass through danger', () => {
  it('refuses to castle out of check', () => {
    // Black rook on e8 rakes the e-file; White is in check.
    const game = newGame({ fen: '4r3/8/2k5/8/8/8/8/R3K2R w KQ - 0 1' })
    expect(canPlay(game, 'O-O')).toBe(false)
    expect(canPlay(game, 'O-O-O')).toBe(false)
  })

  it('refuses to castle through an attacked square (f1)', () => {
    const game = newGame({ fen: '5r2/8/2k5/8/8/8/8/R3K2R w KQ - 0 1' })
    expect(canPlay(game, 'O-O')).toBe(false)
    expect(canPlay(game, 'O-O-O')).toBe(true)
  })

  it('refuses to castle into check (g1)', () => {
    const game = newGame({ fen: '6r1/8/2k5/8/8/8/8/R3K2R w KQ - 0 1' })
    expect(canPlay(game, 'O-O')).toBe(false)
    expect(canPlay(game, 'O-O-O')).toBe(true)
  })

  it('refuses queenside when d1 is attacked', () => {
    const game = newGame({ fen: '3r4/8/2k5/8/8/8/8/R3K2R w KQ - 0 1' })
    expect(canPlay(game, 'O-O-O')).toBe(false)
    expect(canPlay(game, 'O-O')).toBe(true)
  })

  it('ALLOWS queenside when only b1 is attacked', () => {
    // The classic exception: b1 is crossed by the *rook*, not the king, so an
    // attack on it does not prevent castling. Getting this wrong is the single
    // most common castling bug.
    const game = newGame({ fen: '1r6/8/2k5/8/8/8/8/R3K2R w KQ - 0 1' })
    expect(canPlay(game, 'O-O-O')).toBe(true)
  })
})

describe('castling — the squares between must be empty', () => {
  it('refuses queenside when a piece stands on d1', () => {
    const game = newGame({ fen: 'r3k2r/8/8/8/8/8/8/R2QK2R w KQkq - 0 1' })
    expect(canPlay(game, 'O-O-O')).toBe(false)
    expect(canPlay(game, 'O-O')).toBe(true)
  })

  it('refuses queenside when a piece stands on b1', () => {
    const game = newGame({ fen: 'r3k2r/8/8/8/8/8/8/RN2K2R w KQkq - 0 1' })
    expect(canPlay(game, 'O-O-O')).toBe(false)
    expect(canPlay(game, 'O-O')).toBe(true)
  })

  it('refuses kingside when a piece stands on f1', () => {
    const game = newGame({ fen: 'r3k2r/8/8/8/8/8/8/R3KB1R w KQkq - 0 1' })
    expect(canPlay(game, 'O-O')).toBe(false)
    expect(canPlay(game, 'O-O-O')).toBe(true)
  })
})
