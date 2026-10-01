/**
 * Mutation testing of the conformance suite itself.
 *
 * A suite that passes a correct game proves nothing; the only thing that
 * proves a gate works is watching it stop something. So each case here takes
 * a game that conforms, breaks exactly one property, and asserts that the
 * check responsible for that property fails — and, importantly, that it fails
 * with a message a game author can act on.
 *
 * Every mutant below is a real bug someone has shipped: a `getViewFor` that
 * returns the raw state, an event that broadcasts what the view redacted, a
 * `Math.random()` in a reducer, a state field that does not survive Redis, a
 * missing turn check.
 */

import { describe, expect, it } from 'vitest'
import type {
  ConformanceCheck,
  ConformanceReport,
  TurnBasedConformanceSubject,
} from '../src/index.js'
import { failedChecks, runTurnBasedConformance } from '../src/index.js'
import {
  type HiddenHandAction,
  type HiddenHandEvent,
  type HiddenHandSettings,
  type HiddenHandState,
  type HiddenHandView,
  hiddenHandSubject,
} from '../src/reference/index.js'
import { PUBLIC, type MatchResult, checkSettingsForm } from '@playhall/game-sdk'
import { ticTacToeSubject, type TicTacToeState, type TicTacToeSubject } from './subjects.js'

/** Small runs: a mutant is caught on the first seed or it is not caught. */
const FAST = { playoutsPerVariant: 3 } as const

type HiddenHandSubject = TurnBasedConformanceSubject<
  HiddenHandState,
  HiddenHandAction,
  HiddenHandView,
  HiddenHandSettings,
  HiddenHandEvent
>

function mutateTicTacToe(
  patch: Partial<TicTacToeSubject['server']>,
  subjectPatch: Partial<TicTacToeSubject> = {},
): ConformanceReport {
  return runTurnBasedConformance(
    { ...ticTacToeSubject, ...subjectPatch, server: { ...ticTacToeSubject.server, ...patch } },
    FAST,
  )
}

function mutateHiddenHand(
  patch: Partial<HiddenHandSubject['server']>,
  subjectPatch: Partial<HiddenHandSubject> = {},
): ConformanceReport {
  return runTurnBasedConformance(
    { ...hiddenHandSubject, ...subjectPatch, server: { ...hiddenHandSubject.server, ...patch } },
    FAST,
  )
}

/** Every failure message one check recorded, joined so a test can grep it. */
function messagesFor(report: ConformanceReport, check: ConformanceCheck): string {
  return (report.checks.find((candidate) => candidate.id === check)?.failures ?? [])
    .map((failure) => failure.message)
    .join('\n')
}

/** Every `reducer-purity` failure message, joined so a test can grep it. */
function purityMessages(report: ConformanceReport): string {
  return messagesFor(report, 'reducer-purity')
}

function expectCaughtBy(report: ConformanceReport, check: ConformanceCheck): void {
  expect(
    report.passed,
    `report unexpectedly passed:\n${JSON.stringify(failedChecks(report))}`,
  ).toBe(false)
  expect(failedChecks(report)).toContain(check)
  const failed = report.checks.find((candidate) => candidate.id === check)
  expect(failed?.failures.length ?? 0).toBeGreaterThan(0)
  // Every failure must name where it happened. A message with no coordinates
  // is a message a game author cannot act on.
  for (const failure of failed?.failures ?? []) {
    expect(failure.message.length).toBeGreaterThan(10)
  }
}

describe('hidden information leaks', () => {
  it('catches a getViewFor that returns every seat’s hand', () => {
    const report = mutateHiddenHand({
      getViewFor: (state) => ({
        // The classic: "I will redact it later."
        hand: state.hands.flatMap((entry) => entry.cards),
        trick: state.trick,
        handSizes: state.hands.map((entry) => ({
          seatId: entry.seatId,
          count: entry.cards.length,
        })),
        tricksWon: state.tricksWon,
        toMove: null,
        tricksPlayed: state.tricksPlayed,
        totalTricks: state.totalTricks,
      }),
    })
    expectCaughtBy(report, 'no-hidden-info-leak')
    const leak = report.checks.find((check) => check.id === 'no-hidden-info-leak')
    expect(leak?.failures[0]?.message).toContain("leaks 'seat hand'")
    expect(leak?.failures[0]?.where).toBeDefined()
  })

  it('catches a leak hidden inside a string rather than a field', () => {
    const report = mutateHiddenHand({
      getViewFor: (state, viewer) => {
        const base = hiddenHandSubject.server.getViewFor(state, viewer)
        const opponent = state.hands.find((entry) =>
          viewer.kind === 'seat' ? entry.seatId !== viewer.seatId : true,
        )
        return {
          ...base,
          // A "debug" string nobody thought of as a field.
          toMove: `${String(base.toMove)} (next: ${opponent?.cards[0]?.id ?? '-'})` as never,
        }
      },
    })
    expectCaughtBy(report, 'no-hidden-info-leak')
  })

  it('catches a correctly redacted view undone by a public event', () => {
    const report = mutateHiddenHand({
      createInitialState: (ctx, settings, seats) => {
        const initial = hiddenHandSubject.server.createInitialState(ctx, settings, seats)
        return {
          ...initial,
          // The view is fine. The deal is broadcast to the whole room.
          events: initial.events.map((event) => ({ ...event, audience: PUBLIC })),
        }
      },
    })
    expectCaughtBy(report, 'no-hidden-info-leak')
    const leak = report.checks.find((check) => check.id === 'no-hidden-info-leak')
    expect(leak?.failures.some((failure) => failure.message.includes("event 'dealt'"))).toBe(true)
  })

  it('catches a manifest that claims hidden information but declares no secrets', () => {
    const report = runTurnBasedConformance(
      {
        ...ticTacToeSubject,
        manifest: { ...ticTacToeSubject.manifest, hasHiddenInformation: true },
      },
      FAST,
    )
    expectCaughtBy(report, 'manifest-valid')
    expect(
      report.checks
        .find((check) => check.id === 'manifest-valid')
        ?.failures.some((failure) => failure.message.includes('vacuously')),
    ).toBe(true)
  })
})

describe('determinism', () => {
  it('catches Math.random() in a reducer', () => {
    const report = mutateTicTacToe({
      applyAction: (ctx, state, seatId, action) => {
        const applied = ticTacToeSubject.server.applyAction(ctx, state, seatId, action)
        return {
          ...applied,
          state: {
            ...applied.state,
            moveCount: applied.state.moveCount + (Math.random() < 0 ? 1 : 0),
          },
        }
      },
    })
    expectCaughtBy(report, 'determinism')
    expect(
      report.checks
        .find((check) => check.id === 'determinism')
        ?.failures.some((failure) => failure.message.includes('Math.random()')),
    ).toBe(true)
  })

  it('catches Date.now() in a reducer', () => {
    const report = mutateTicTacToe({
      applyAction: (ctx, state, seatId, action) => {
        const applied = ticTacToeSubject.server.applyAction(ctx, state, seatId, action)
        return { ...applied, state: { ...applied.state, moveTimeoutMs: Date.now() } }
      },
    })
    expectCaughtBy(report, 'determinism')
  })

  it('catches a reducer that mutates the state it was given', () => {
    const report = mutateTicTacToe({
      applyAction: (ctx, state, seatId, action) => {
        if (action.type === 'place') {
          // In-place write: fine in a unit test, catastrophic with a match log.
          ;(state.board as (typeof state.board)[number][])[action.cell] = 'x'
        }
        return ticTacToeSubject.server.applyAction(ctx, state, seatId, action)
      },
    })
    expect(report.passed).toBe(false)
    expect(failedChecks(report)).toContain('reducer-purity')
    expect(purityMessages(report)).toContain('applyAction mutated the state it was given')
  })

  /**
   * PER-269: the mutation `reducer-purity` used to miss completely.
   *
   * The baseline it compares against was `stableStringify(step.before)` read at
   * check time, and `step.before` was the very object the playout had already
   * passed through the impure reducer. So the check was really asking "does a
   * *second* application change anything?", and a reducer that writes the same
   * value every call answered no.
   *
   * This is not a contrived shape. It is memoisation — the single most natural
   * optimisation to reach for in a reducer that re-derives a position from a
   * move list (see PER-92) — and on this subject it shipped the whole suite
   * green, not merely this one check.
   */
  it('catches a reducer that memoises a constant onto the state it was given', () => {
    const report = mutateTicTacToe({
      applyAction: (ctx, state, seatId, action) => {
        // `state.cache = analyse(state)` in miniature: idempotent, JSON-safe,
        // and identical on every call.
        ;(state as unknown as Record<string, unknown>).memo = 'analysed'
        return ticTacToeSubject.server.applyAction(ctx, state, seatId, action)
      },
    })
    expectCaughtBy(report, 'reducer-purity')
    expect(purityMessages(report)).toContain('applyAction mutated the state it was given')

    // The sharp half. Before the fix this list was `[]` — the mutation was
    // invisible to the entire suite. It must also stay exactly this: a
    // `determinism` or `serialization-round-trip` entry appearing here would
    // mean a driver call site stopped handing the game its own copy, so a
    // purity bug is being reported as a replay or Redis failure instead.
    expect(failedChecks(report)).toEqual(['reducer-purity'])
  })

  /**
   * PER-273 review finding: the check's *own* probe was the last leak.
   *
   * `checkReducerPurity` handed `step.before` to `validateAction` raw, so an
   * idempotent `validateAction` mutation wrote the stray key into the record
   * the driver had just kept pristine — and the `applyAction` assertion two
   * lines later then compared a clone of that polluted state against a
   * polluted baseline. The mutation was reported twice: once correctly, and
   * once as a *false* "applyAction mutated the state it was given".
   *
   * Attribution is the whole product of this check. A purity failure that
   * names the wrong function sends a game author to rewrite a reducer that is
   * already pure.
   */
  it('attributes an idempotent validateAction mutation to validateAction alone', () => {
    const report = mutateTicTacToe({
      validateAction: (ctx, state, seatId, action) => {
        // Same shape as the memoisation mutant above, on the other entry point.
        ;(state as unknown as Record<string, unknown>).memo = 'analysed'
        return ticTacToeSubject.server.validateAction(ctx, state, seatId, action)
      },
    })
    expectCaughtBy(report, 'reducer-purity')
    expect(purityMessages(report)).toContain('validateAction mutated the state it was given')
    // The sharp half. Before the fix this said 'applyAction mutated the state
    // it was given instead of returning a new one' as well, because the check
    // itself had polluted the baseline that assertion reads.
    expect(purityMessages(report)).not.toContain('applyAction mutated')

    // PER-278: the same mutation used to be blamed on a *third* function as
    // well. `illegal-action-rejected` and `legal-actions-agree` both ran
    // `validateAction` against the retained `step.before` / `step.after` /
    // `finalState`, so by the time `serialization-round-trip` replayed the
    // match the record carried the stray key and the replay could not
    // reproduce it. That is a spurious check name in an already-red run,
    // pointing a game author at a serialization bug that does not exist.
    //
    // This list is the whole pin. A `serialization-round-trip` or
    // `reconnect-snapshot-matches-live` entry reappearing here means a
    // `validateAction` call site in a check stopped cloning.
    expect(failedChecks(report)).toEqual(['reducer-purity', 'illegal-action-rejected'])

    // Cloning must not weaken what `illegal-action-rejected` already gets
    // right: it captures its baseline before the call either way, so it still
    // reports the mutation against itself.
    expect(messagesFor(report, 'illegal-action-rejected')).toContain(
      'state changed while rejecting ',
    )
  })

  it('catches a non-deterministic getViewFor', () => {
    let calls = 0
    const report = mutateTicTacToe({
      getViewFor: (state, viewer) => {
        calls += 1
        const base = ticTacToeSubject.server.getViewFor(state, viewer)
        return { ...base, moveCount: base.moveCount + (calls % 2) }
      },
    })
    expectCaughtBy(report, 'reducer-purity')
  })
})

describe('action rejection', () => {
  it('catches a missing turn check', () => {
    const report = mutateTicTacToe({
      validateAction: (ctx, state, seatId, action) => {
        const base = ticTacToeSubject.server.validateAction(ctx, state, seatId, action)
        // "Whose turn is it" removed; everything else kept.
        if (!base.ok && base.error.code === 'not_your_turn') return { ok: true }
        return base
      },
    })
    expect(report.passed).toBe(false)
    expect(failedChecks(report)).toContain('illegal-action-rejected')
  })

  it('catches an actionSchema that accepts anything', () => {
    const anySchema = {
      safeParse: (value: unknown) => ({ success: true as const, data: value as never }),
    }
    const report = mutateTicTacToe({
      actionSchema: anySchema as unknown as TicTacToeSubject['server']['actionSchema'],
    })
    expectCaughtBy(report, 'illegal-action-rejected')
    expect(
      report.checks
        .find((check) => check.id === 'illegal-action-rejected')
        ?.failures.some((failure) => failure.message.includes('malformed payload')),
    ).toBe(true)
  })

  it('catches a validateAction that throws instead of returning a rejection', () => {
    const report = mutateTicTacToe({
      validateAction: (ctx, state, seatId, action) => {
        const base = ticTacToeSubject.server.validateAction(ctx, state, seatId, action)
        if (!base.ok) throw new Error('not your turn')
        return base
      },
    })
    expect(report.passed).toBe(false)
    expect(failedChecks(report)).toContain('illegal-action-rejected')
  })

  it('catches getLegalActions disagreeing with validateAction', () => {
    const report = mutateTicTacToe({
      // Forgets that resigning is always available — the bug that makes a bot
      // seat hang when it has no board move it likes.
      getLegalActions: (state, seatId) =>
        (ticTacToeSubject.server.getLegalActions?.(state, seatId) ?? []).filter(
          (action) => action.type !== 'resign',
        ),
    })
    expectCaughtBy(report, 'legal-actions-agree')
  })
})

describe('persistence and reconnection', () => {
  it('catches state that does not survive JSON', () => {
    const report = mutateTicTacToe({
      createInitialState: (ctx, settings, seats) => {
        const initial = ticTacToeSubject.server.createInitialState(ctx, settings, seats)
        return {
          ...initial,
          state: {
            ...initial.state,
            // Survives in memory, becomes `{}` on the way back from Redis.
            takenCells: new Set<number>() as unknown as TicTacToeState['winningLine'],
          },
        }
      },
    })
    expect(report.passed).toBe(false)
    expect(failedChecks(report)).toContain('serialization-round-trip')
  })

  it('catches an onReconnect that changes what other seats see', () => {
    const report = mutateHiddenHand({
      // "Reset the trick so the reconnecting player is not confused." It is
      // also a free undo for whoever reconnects on purpose.
      onReconnect: (_ctx, state) => ({ state: { ...state, trick: [] }, events: [] }),
    })
    expect(report.passed).toBe(false)
    expect(failedChecks(report)).toContain('reconnect-snapshot-matches-live')
  })

  it('catches a non-deterministic onReconnect', () => {
    let calls = 0
    const report = mutateHiddenHand({
      onReconnect: (_ctx, state) => {
        calls += 1
        return {
          state: { ...state, leaderIndex: (state.leaderIndex + calls) % state.order.length },
          events: [],
        }
      },
    })
    expect(report.passed).toBe(false)
    expect(failedChecks(report)).toContain('reconnect-snapshot-matches-live')
  })

  it('catches a reconnect snapshot that differs from the live view', () => {
    // A view that depends on object identity rather than on value: it looks
    // right live, and comes back wrong from Redis.
    const seen = new WeakSet<object>()
    const report = mutateTicTacToe({
      getViewFor: (state, viewer) => {
        const base = ticTacToeSubject.server.getViewFor(state, viewer)
        const fresh = !seen.has(state as object)
        seen.add(state as object)
        return { ...base, moveCount: fresh ? base.moveCount : base.moveCount + 100 }
      },
    })
    expect(report.passed).toBe(false)
    expect(failedChecks(report)).toContain('reconnect-snapshot-matches-live')
  })
})

describe('termination and results', () => {
  it('catches a game that never ends', () => {
    const report = mutateTicTacToe({ getResult: () => null })
    expectCaughtBy(report, 'random-playout-terminates')
    expect(
      report.checks
        .find((check) => check.id === 'random-playout-terminates')
        ?.failures.some((failure) => failure.message.includes('stalled')),
    ).toBe(true)
  })

  it('catches a malformed result', () => {
    const report = mutateTicTacToe({
      getResult: (state): MatchResult | null => {
        const base = ticTacToeSubject.server.getResult(state)
        if (base === null) return null
        // Competition ranking broken: 1, 1, 2 instead of 1, 1, 3 — and one
        // seat dropped entirely.
        return { ...base, standings: base.standings.slice(0, 1).map((s) => ({ ...s, rank: 2 })) }
      },
    })
    // `random-playout-terminates` only asks whether a result was *reached*;
    // whether it is well-formed is `result-standings-well-formed`'s question
    // (ADR-0006), so the failure has to name that check and not the other one.
    expectCaughtBy(report, 'result-standings-well-formed')
    expect(failedChecks(report)).not.toContain('random-playout-terminates')
  })

  it('catches a timer the manifest never declared', () => {
    const report = mutateTicTacToe({
      applyAction: (ctx, state, seatId, action) => {
        const applied = ticTacToeSubject.server.applyAction(ctx, state, seatId, action)
        return {
          ...applied,
          timers: [
            ...(applied.timers ?? []),
            { op: 'set' as const, timerId: 'undeclared-timer' as never, seatId: null, delayMs: 10 },
          ],
        }
      },
    })
    expectCaughtBy(report, 'manifest-valid')
    expect(
      report.checks
        .find((check) => check.id === 'manifest-valid')
        ?.failures.some((failure) => failure.message.includes('undeclared-timer')),
    ).toBe(true)
  })
})

/**
 * The ADR-0007 settings-form descriptor.
 *
 * Every mutant here typechecks. That is the whole point: `SettingsField` is a
 * structural type, so a descriptor assembled through a spread satisfies it and
 * the drift only exists at runtime. Before `settings-form-contract` had a call
 * site, each of these shipped green.
 */
describe('settings form descriptor', () => {
  function mutateForm(form: unknown): ConformanceReport {
    return runTurnBasedConformance(
      {
        ...ticTacToeSubject,
        manifest: { ...ticTacToeSubject.manifest, settingsForm: form as never },
      },
      FAST,
    )
  }

  function messagesOf(report: ConformanceReport, check: ConformanceCheck): string {
    return (report.checks.find((candidate) => candidate.id === check)?.failures ?? [])
      .map((failure) => `${failure.message} @ ${failure.where ?? '-'}`)
      .join('\n')
  }

  const baseFields = ticTacToeSubject.manifest.settingsForm.fields

  it('catches a visibleWhen naming a field that does not exist', () => {
    const report = mutateForm({
      version: 1,
      fields: baseFields.map((field) =>
        field.kind === 'number'
          ? // `timeControl` is a chess key. Copy-pasted descriptors do this,
            // and the field then never appears in any lobby.
            { ...field, visibleWhen: { field: 'timeControl', equals: ['custom'] } }
          : field,
      ),
    })
    expectCaughtBy(report, 'settings-form-contract')
    expect(messagesOf(report, 'settings-form-contract')).toContain('visibility_target_missing')
  })

  it('catches a field bound to a settings key that does not exist', () => {
    const report = mutateForm({
      version: 1,
      fields: [...baseFields, { kind: 'toggle', key: 'rated', label: 'Rated' }],
    })
    expectCaughtBy(report, 'settings-form-contract')
    expect(messagesOf(report, 'settings-form-contract')).toContain('unknown_field_key')
  })

  it('catches a select option the settings schema rejects', () => {
    const report = mutateForm({
      version: 1,
      fields: baseFields.map((field) =>
        field.key === 'firstMove' && field.kind === 'select'
          ? { ...field, options: [...field.options, { value: 'alternate', label: 'Alternate' }] }
          : field,
      ),
    })
    expectCaughtBy(report, 'settings-form-contract')
    expect(messagesOf(report, 'settings-form-contract')).toContain('option_rejected')
  })

  it('catches number bounds that have drifted from the schema', () => {
    const report = mutateForm({
      version: 1,
      fields: baseFields.map((field) => (field.kind === 'number' ? { ...field, max: 600 } : field)),
    })
    expectCaughtBy(report, 'settings-form-contract')
    expect(messagesOf(report, 'settings-form-contract')).toContain('number_bound_rejected')
  })

  it('catches an unknown key, which TypeScript only rejects on a fresh literal', () => {
    // Assembled through a spread, so the excess-property check never fires —
    // and `settingsFieldSchema` is `.strict()`, so it fails at runtime.
    const stale = { placeholder: 'Seconds' }
    const report = mutateForm({
      version: 1,
      fields: baseFields.map((field) => ({ ...field, ...stale })),
    })
    expectCaughtBy(report, 'settings-form-contract')
    expect(messagesOf(report, 'settings-form-contract')).toContain('settingsFormDescriptorSchema')
  })

  it('catches a preset the form cannot produce', () => {
    // The `blitz` preset sets firstMove: 'random', and the select no longer
    // offers it — so picking Blitz gives the host a setting the form cannot
    // draw, and the first edit silently snaps it back to 'seat-order'.
    const form = {
      version: 1,
      fields: baseFields.map((field) =>
        field.key === 'firstMove' && field.kind === 'select'
          ? { ...field, options: field.options.filter((option) => option.value !== 'random') }
          : field,
      ),
    } as const

    const report = mutateForm(form)
    expectCaughtBy(report, 'settings-form-contract')
    const messages = messagesOf(report, 'settings-form-contract')
    expect(messages).toContain("preset 'blitz'")
    expect(messages).toContain('select control cannot produce')

    // This one is genuinely new rather than a relabelling of `manifest-valid`:
    // the SDK checker probes only `defaultSettings`, so it is silent on this
    // exact descriptor — and `manifest-valid`, which runs it, stays green.
    expect(
      checkSettingsForm({
        settingsForm: form,
        settingsSchema: ticTacToeSubject.manifest.settingsSchema,
        defaultSettings: ticTacToeSubject.manifest.defaultSettings,
      }),
    ).toEqual([])
    expect(failedChecks(report)).toEqual(['settings-form-contract'])
  })

  it('leaves the other checks alone: a broken descriptor is one failure', () => {
    const report = mutateForm({
      version: 1,
      fields: [...baseFields, { kind: 'toggle', key: 'rated', label: 'Rated' }],
    })
    expect(failedChecks(report)).toEqual(['manifest-valid', 'settings-form-contract'])
  })

  it('defers "a setting no control binds" to the SDK checker', () => {
    // PER-110 adds `setting_without_field` to `checkSettingsForm`. Until it
    // lands this is silent, and when it lands the verdict arrives through the
    // checker rather than from a second opinion in the testkit.
    const form = {
      version: 1,
      fields: baseFields.filter((field) => field.key !== 'firstMove'),
    } as const
    const report = mutateForm(form)
    const check = report.checks.find((candidate) => candidate.id === 'settings-form-contract')
    const fromSdk = checkSettingsForm({
      settingsForm: form,
      settingsSchema: ticTacToeSubject.manifest.settingsSchema,
      defaultSettings: ticTacToeSubject.manifest.defaultSettings,
    })
    expect(check?.status).toBe(fromSdk.length === 0 ? 'passed' : 'failed')
  })
})
