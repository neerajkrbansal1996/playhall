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
import { z } from 'zod'
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

  /**
   * ADR-0012: `accepted ⊆ offered`. PER-198's shape, on a game whose playouts
   * are reproducible — `actionSchema` declares an optional field, the reducer
   * ignores it, and `getLegalActions` lists only the bare spelling. Every
   * ordinary move then has a second wire spelling nothing enumerates, nothing
   * hints and no replay reproduces.
   *
   * The CTO measured on `main` at `15efe05` that sampling is blind to this at
   * 1, 3, 12 and 24 playouts per variant: the reverse corpus was
   * `probeActions ∪ (actions offered to other seats)`, and the payload is in
   * neither. These cases all run at FAST (3 playouts) on purpose — the point of
   * perturbation is that it does not need seeds.
   */
  describe('accepted ⊆ offered (ADR-0012)', () => {
    /** `face` is declared, parsed, and read by nothing. */
    const toleratedField = z.object({
      type: z.literal('play'),
      cardId: z.string().min(1).max(8),
      face: z.enum(['up', 'down']).optional(),
    })

    function noteOf(report: ConformanceReport, needle: string): string | undefined {
      return report.checks
        .find((check) => check.id === 'legal-actions-agree')
        ?.notes.find((note) => note.includes(needle))
    }

    function notesOf(report: ConformanceReport): readonly string[] {
      return report.checks.find((check) => check.id === 'legal-actions-agree')?.notes ?? []
    }

    /** `[cost law] fields=F forward=N perturbed=P asserted=A`, as ADR-0012 prints it. */
    function costLaw(report: ConformanceReport): {
      fields: number
      forward: number
      perturbed: number
      asserted: number
    } {
      const note = noteOf(report, '[cost law]')
      expect(note, `no cost-law note in:\n${notesOf(report).join('\n')}`).toBeDefined()
      const matched = /fields=(\d+) forward=(\d+) perturbed=(\d+) asserted=(\d+)/.exec(note ?? '')
      expect(matched, `cost-law note not parseable: ${String(note)}`).not.toBeNull()
      return {
        fields: Number(matched?.[1]),
        forward: Number(matched?.[2]),
        perturbed: Number(matched?.[3]),
        asserted: Number(matched?.[4]),
      }
    }

    it('catches an optional field the game tolerates and ignores', () => {
      const report = mutateHiddenHand({
        actionSchema: toleratedField as HiddenHandSubject['server']['actionSchema'],
      })
      expectCaughtBy(report, 'legal-actions-agree')
      // Nothing else moved: this is one defect, not a broken subject.
      expect(failedChecks(report)).toEqual(['legal-actions-agree'])
      const failures =
        report.checks.find((check) => check.id === 'legal-actions-agree')?.failures ?? []
      expect(failures[0]?.message).toContain('getLegalActions does not list')
      // The finding has to name the spelling, or the author cannot act on it.
      expect(failures.some((failure) => failure.detail?.includes('"face"') === true)).toBe(true)
    })

    it('passes the same game once validateAction rejects the extra spelling', () => {
      // The fix ADR-0012 prescribes: reject the second spelling, never widen
      // `getLegalActions` to enumerate both.
      const report = mutateHiddenHand({
        actionSchema: toleratedField as HiddenHandSubject['server']['actionSchema'],
        validateAction: (ctx, state, seatId, action) => {
          if ('face' in action) return { ok: false, error: { code: 'invalid_action' } }
          return hiddenHandSubject.server.validateAction(ctx, state, seatId, action)
        },
      })
      expect(failedChecks(report)).toEqual([])
      // …and it ran: a pass here must be distinguishable from a pass that
      // never probed anything.
      expect(noteOf(report, 'perturbation direction covered')).toBeDefined()
      expect(costLaw(report).perturbed).toBeGreaterThan(0)
    })

    it('reports nothing to cover, not coverage, for a schema with no optional field', () => {
      const report = runTurnBasedConformance(hiddenHandSubject, FAST)
      expect(failedChecks(report)).toEqual([])
      expect(noteOf(report, 'has nothing to cover')).toBeDefined()
      expect(noteOf(report, 'perturbation direction covered')).toBeUndefined()
      // Zero extra `validateAction` calls, which is the cost ADR-0012 claims
      // for a schema that declares no optional field.
      expect(costLaw(report)).toMatchObject({ fields: 0, perturbed: 0 })
    })

    it('holds the cost law: perturbed == forward × |optional fields|', () => {
      const report = mutateHiddenHand({
        actionSchema: toleratedField as HiddenHandSubject['server']['actionSchema'],
      })
      const { fields, forward, perturbed } = costLaw(report)
      expect(fields).toBe(1)
      expect(forward).toBeGreaterThan(0)
      // Equality, not just the bound: no offered action carries `face`, and
      // `actionSchema` accepts every representative value.
      expect(perturbed).toBe(forward * fields)
    })

    it('keeps the cost law as a bound when a field is declared twice over', () => {
      const report = mutateHiddenHand(
        { actionSchema: toleratedField as HiddenHandSubject['server']['actionSchema'] },
        { actionPerturbations: [{ key: 'face', values: ['up', 'down'] }] },
      )
      const { fields, forward, perturbed } = costLaw(report)
      expect(fields).toBe(2)
      expect(perturbed).toBe(forward * fields)
    })

    it('skips a perturbation that is itself offered, instead of flagging it', () => {
      // `promotion: 'q'` → `promotion: 'r'` on a real promotion is another
      // genuinely legal move. The existing `listedKeys` skip has to absorb it,
      // which is why perturbation feeds the assertion that already exists
      // rather than a new one.
      const report = mutateHiddenHand({
        actionSchema: toleratedField as HiddenHandSubject['server']['actionSchema'],
        // Every spelling is offered, so every perturbation lands in `listed`.
        getLegalActions: (state, seatId) =>
          (hiddenHandSubject.server.getLegalActions?.(state, seatId) ?? []).flatMap((action) => [
            action,
            { ...action, face: 'up' as const },
            { ...action, face: 'down' as const },
          ]),
      })
      expect(failedChecks(report)).toEqual([])
      const law = costLaw(report)
      // The corpus is generated — so the direction ran — and every member of it
      // is a move the game offers, so there is nothing left to assert.
      expect(law.perturbed).toBeGreaterThan(0)
      expect(law.asserted).toBe(0)
      expect(noteOf(report, 'already offers every one of them')).toBeDefined()
    })

    it('says so when every probe is rejected by the schema it came from', () => {
      // A readable field the value sampler cannot satisfy: `'atrium-probe'` is
      // not two digits. The direction generated nothing, and the report has to
      // say that rather than read as a pass — this is the value-level half the
      // ADR names as not covered, surfacing as a corpus of zero.
      const constrained = z.object({
        type: z.literal('play'),
        cardId: z.string().min(1).max(8),
        tag: z
          .string()
          .regex(/^\d{2}$/)
          .optional(),
      })
      const report = mutateHiddenHand({
        actionSchema: constrained as HiddenHandSubject['server']['actionSchema'],
      })
      expect(failedChecks(report)).toEqual([])
      expect(costLaw(report)).toMatchObject({ fields: 1, perturbed: 0 })
      expect(noteOf(report, 'produced 0 surviving probes')).toBeDefined()
      expect(noteOf(report, 'perturbation direction covered')).toBeUndefined()
    })

    /**
     * The loud-absence requirement, which is the condition ADR-0012's approval
     * rests on. A direction that silently generates zero probes and reports a
     * pass reproduces `passWithNoTests` on a check whose entire purpose is to
     * stop a silent pass.
     */
    describe('loud absence', () => {
      /** Not a zod schema at all — a hand-rolled parser, as a game may ship. */
      const opaque = {
        safeParse: (value: unknown) => {
          const ok =
            typeof value === 'object' &&
            value !== null &&
            (value as { type?: unknown }).type === 'play' &&
            typeof (value as { cardId?: unknown }).cardId === 'string'
          return ok
            ? { success: true as const, data: value as HiddenHandAction }
            : { success: false as const, error: new Error('nope') }
        },
      }

      it('names an actionSchema it cannot introspect, and claims no coverage', () => {
        const report = mutateHiddenHand({
          actionSchema: opaque as unknown as HiddenHandSubject['server']['actionSchema'],
        })
        const note = noteOf(report, 'NOT covered for actionSchema')
        expect(note, `notes were:\n${notesOf(report).join('\n')}`).toBeDefined()
        expect(note).toContain('actionPerturbations')
        expect(noteOf(report, 'perturbation direction covered')).toBeUndefined()
        expect(noteOf(report, 'has nothing to cover')).toBeUndefined()
        expect(costLaw(report)).toMatchObject({ fields: 0, perturbed: 0 })
      })

      it('still names the schema when actionPerturbations papers over it', () => {
        // The fallback restores the direction; the gap stays visible, because a
        // schema the introspector cannot read is a thing to fix, not to hide.
        const report = mutateHiddenHand(
          { actionSchema: opaque as unknown as HiddenHandSubject['server']['actionSchema'] },
          { actionPerturbations: [{ key: 'face', values: ['up'] }] },
        )
        expectCaughtBy(report, 'legal-actions-agree')
        expect(noteOf(report, 'NOT covered for actionSchema')).toBeDefined()
        expect(noteOf(report, 'perturbation direction covered')).toBeDefined()
      })

      it('names an optional field whose inner type it cannot sample', () => {
        const unsampleable = z.object({
          type: z.literal('play'),
          cardId: z.string().min(1).max(8),
          meta: z.record(z.string()).optional(),
        })
        const report = mutateHiddenHand({
          actionSchema: unsampleable as HiddenHandSubject['server']['actionSchema'],
        })
        const note = noteOf(report, "optional field 'meta'")
        expect(note, `notes were:\n${notesOf(report).join('\n')}`).toBeDefined()
        expect(note).toContain('NOT covered')
        expect(note).toContain('ZodRecord')
        expect(noteOf(report, 'perturbation direction covered')).toBeUndefined()
      })

      it('takes the loud path when zod moves its internals out from under us', () => {
        // The version canary ADR-0012 names as the mitigation for coupling to
        // `_def`. Shaped like a post-v3 schema: a `_def`, no `typeName`.
        // (Measured against the real `zod/v4` on 3.25.76: `_def.typeName` is
        // `undefined` there, so it lands here.)
        const futureZod = {
          _def: { type: 'object' },
          shape: { type: {}, cardId: {} },
          safeParse: (value: unknown) => ({ success: true as const, data: value as never }),
        }
        const report = mutateHiddenHand({
          actionSchema: futureZod as unknown as HiddenHandSubject['server']['actionSchema'],
        })
        const note = noteOf(report, 'NOT covered for actionSchema')
        expect(note).toBeDefined()
        expect(note).toContain('zod v4')
      })
    })
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
