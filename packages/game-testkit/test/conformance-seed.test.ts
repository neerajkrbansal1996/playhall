/**
 * `DEFAULTS.seed` is the one string in this package whose *value* is behaviour.
 *
 * It roots the RNG stream for every playout, so editing it drives every conformance
 * subject through a different action sequence: a subject that passes can start
 * failing, or — worse — keep passing for a different reason. Before PER-217 the
 * literal was referenced exactly once, at its own definition, so nothing went red
 * when it changed. That is what this file fixes: the pin below is the thing that
 * turns a seed edit from an invisible diff into a failing test, and the comment on
 * `DEFAULTS.seed` tells the next author what to do about it.
 *
 * A pin on its own would be a tautology — `expect(X).toBe(X)` restated as a literal.
 * The cases after it are what make it mean something: they prove the string actually
 * reaches the derived seeds, so the pin is guarding a real dependency rather than
 * decorating a constant.
 */

import { describe, expect, it } from 'vitest'
import { APPROVED_NAME, INTERNAL_CODENAME } from '@playhall/shared'

import { DEFAULTS } from '../src/internal/prepare.js'
import { seedFor } from '../src/internal/driver.js'
import { ticTacToeSubject } from './subjects.js'
import { runTurnBasedConformance } from '../src/index.js'

describe('the default conformance seed', () => {
  it('is pinned to its exact literal', () => {
    // Spelled out on purpose. Changing the seed must change this line too, which is
    // the review signal: the diff then says "every subject gets resampled", instead
    // of saying nothing. Bump the `-v` suffix when you mean it, re-run the suite
    // against every enrolled subject, and diff the reports rather than trusting
    // green — the status/notes of each check are what must stay put, not the
    // assertion counts, which move precisely because the playouts moved.
    expect(DEFAULTS.seed).toBe('turn-based-conformance-v2')
  })

  it('names what it seeds and carries no product name', () => {
    // PER-217. The previous value embedded the pre-approval codename, which put a
    // rebrand — a change with no business touching a test fixture — one sed away
    // from resampling every conformance subject in the repo. The guard lives here,
    // next to the constant, for the same reason the repo-wide brand scan lives next
    // to `brand.ts`: the test that fails should be the one beside the thing you
    // edited. Both literals are read from the constants so this file never spells
    // either of them and cannot trip the repo-wide scan itself.
    expect(DEFAULTS.seed).not.toMatch(new RegExp(INTERNAL_CODENAME, 'i'))
    expect(DEFAULTS.seed).not.toMatch(new RegExp(APPROVED_NAME, 'i'))
  })

  it('actually reaches the derived seeds, so the pin guards something', () => {
    // `deriveSeed` is length-prefixed concatenation, so the base seed is embedded
    // verbatim in every match seed. Asserting that directly is what stops the pin
    // above from being a tautology: if `prepare` ever stopped threading
    // `DEFAULTS.seed` into `seedFor`, this fails and the pin becomes honest again.
    const mine = seedFor(DEFAULTS.seed, 'defaults × 2p', 0)
    const other = seedFor('a-different-root', 'defaults × 2p', 0)

    expect(String(mine)).toContain(DEFAULTS.seed)
    expect(String(mine)).not.toBe(String(other))
  })

  it('is the root a default conformance run reports', () => {
    // The end-to-end half: `runTurnBasedConformance` with no options must derive its
    // seeds from this constant. A run that quietly defaulted somewhere else would
    // leave the pin green while the suite sampled a different stream entirely.
    const report = runTurnBasedConformance(ticTacToeSubject)

    expect(report.seeds.length).toBeGreaterThan(0)
    for (const seed of report.seeds) expect(seed).toContain(DEFAULTS.seed)
  })
})
