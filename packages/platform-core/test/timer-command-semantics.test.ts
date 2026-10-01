/**
 * `TimerService` against the shared semantics table (ADR-0010 §4).
 *
 * The table lives at `packages/game-sdk/test/fixtures/timer-command-semantics.json`
 * and is the contract between the two independent readings of `TimerCommand`:
 * `TimerQueue` in `packages/game-testkit/src/internal/timer-queue.ts` (the
 * conformance driver) and `TimerService` here (the real room-runner scheduler).
 * `no-testkit-to-platform` (ADR-0002 §2) forbids the testkit importing the
 * platform, so the two cannot share code — they share this table instead, and
 * ADR-0010 §4 makes passing it a condition of the service shipping.
 *
 * `packages/game-testkit/test/timer-queue.test.ts` is the same test for the
 * other reading. Read from disk by path, not re-declared here and not imported
 * as a package: a copy of the table would let the two drift while both suites
 * stayed green, which is the exact failure the fixture exists to prevent.
 * `platform-core` -> `game-sdk` is a legal edge, and reading a file out of that
 * package's test tree crosses no boundary rule.
 */

import { readFileSync } from 'node:fs'
import {
  type SeatId,
  type TimerCommand,
  type TimerSpec,
  asMatchId,
  asTimerId,
} from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { fixedClock } from '../src/runtime.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { TimerService } from '../src/timers/service.js'

const FIXTURE_PATH = new URL(
  '../../game-sdk/test/fixtures/timer-command-semantics.json',
  import.meta.url,
)

interface RawCommand {
  readonly op: 'set' | 'clear' | 'pause' | 'resume'
  readonly timerId: string
  readonly seatId?: string | null
  readonly delayMs?: number
  readonly replace?: boolean
}

interface RawStep {
  readonly now: number
  readonly commands: readonly RawCommand[]
}

interface RawFire {
  readonly timerId: string
  readonly deadline: number
  readonly seatId: string | null
}

interface RawCase {
  readonly id: string
  readonly description: string
  readonly declaredTimerIds: readonly string[]
  readonly maxFires?: number
  readonly steps: readonly RawStep[]
  readonly onFire?: Readonly<Record<string, readonly RawCommand[]>>
  readonly expectedFires: readonly RawFire[]
}

interface Fixture {
  readonly version: number
  readonly defaultMaxFires: number
  readonly cases: readonly RawCase[]
  readonly undeclaredSetIsAnError: {
    readonly declaredTimerIds: readonly string[]
    readonly steps: readonly RawStep[]
  }
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture

const MATCH = asMatchId('timer-command-semantics')

/**
 * Table rows `TimerService` does **not** satisfy, by row id, with why.
 *
 * ADR-0010 §4 says a changed tie-break adds a row to the fixture before it
 * changes either implementation, so neither closing this by editing the table
 * nor closing it by re-ordering `poll` is this suite's call to make — which
 * reading is normative is an ADR decision (PER-252, CTO). Pinned as
 * `it.fails` rather than deleted or `it.skip`ped so the divergence is a live,
 * named assertion: the row goes red the moment either side moves, including
 * when the service is fixed, and the suite stays honest in the meantime.
 *
 * `TimerService`'s actual ordering is asserted positively in
 * "orders an equal-deadline batch by arm order" below, so this records what the
 * service does and not merely that it disagrees.
 */
const DIVERGING_ROWS: ReadonlyMap<string, string> = new Map([
  [
    'ties-break-by-timer-id-ascending',
    'TimerService.poll sorts an equal-deadline batch by deadline alone, so a stable sort ' +
      'leaves it in arm order; the table requires timerId ascending.',
  ],
])

/**
 * The table declares ids, not specs, because it is about `TimerCommand` and not
 * about the manifest. `kind: 'custom'` is what `TimerService.set` itself falls
 * back to for a `set` that names no kind, so it is the kind the table's plain
 * `set` actually means. It must not be `chess-clock`: those run only for the
 * seat on move, which is game state the table deliberately does not model.
 *
 * `pausesOnDisconnect` is unobservable here — no case marks a seat absent — so
 * the value is arbitrary; `false` is the one that cannot introduce a hold.
 */
function toSpec(id: string): TimerSpec {
  return { id, kind: 'custom', description: `fixture timer ${id}`, pausesOnDisconnect: false }
}

/** The table stores commands as plain JSON, so the branded ids are reapplied. */
function toCommands(raw: readonly RawCommand[]): readonly TimerCommand[] {
  return raw.map((command) => {
    switch (command.op) {
      case 'set':
        return {
          op: 'set' as const,
          timerId: asTimerId(command.timerId),
          seatId: (command.seatId ?? null) as SeatId | null,
          delayMs: command.delayMs ?? 0,
          ...(command.replace === undefined ? {} : { replace: command.replace }),
        }
      default:
        return { op: command.op, timerId: asTimerId(command.timerId) }
    }
  })
}

/**
 * Runs one case exactly as the fixture's "how to run a case" prose says.
 *
 * Two shape differences from the testkit's queue driver, both forced by the
 * service's contract rather than chosen:
 *
 * 1. The service has no `takeNext()`. It delivers expiries through `onExpire`,
 *    and it drains them *inside* every mutator — so a `delayMs: 0` fires during
 *    `apply` and a deadline that a later step steps over fires during that step.
 *    Observing fires in the callback rather than in the drain loop is therefore
 *    the only way to see the whole sequence in order.
 * 2. `poll()` fires every timer due at one instant in a single pass. The loop
 *    below advances the clock to `nextDeadlineMs()` and polls there, which is
 *    what the real `setTimeout` scheduler does; a pass that finds two timers due
 *    at the same instant delivers both, and the order it delivers them in is
 *    precisely the tie-break the table pins.
 */
function drive(testCase: RawCase, defaultMaxFires: number): readonly RawFire[] {
  const clock = fixedClock(0)
  const observed: RawFire[] = []
  let fireClock = Number.NEGATIVE_INFINITY

  // `onFire` re-enters the service it is handed by, so the handler closes over
  // `service` before the constructor returns. Safe because `onExpire` can only
  // run from inside a call *on* the service, which is necessarily after that.
  const service: TimerService = new TimerService({
    matchId: MATCH,
    clock,
    scheduler: createManualScheduler(),
    specs: testCase.declaredTimerIds.map(toSpec),
    onExpire: (expiry) => {
      fireClock = Math.max(expiry.dueAtMs, fireClock)
      observed.push({
        timerId: String(expiry.timerId),
        deadline: expiry.dueAtMs,
        seatId: expiry.seatId === null ? null : String(expiry.seatId),
      })
      const onFire = testCase.onFire?.[String(expiry.timerId)]
      if (onFire !== undefined) service.apply(toCommands(onFire), fireClock)
    },
  })

  for (const step of testCase.steps) {
    clock.set(step.now)
    service.apply(toCommands(step.commands), step.now)
  }

  const budget = testCase.maxFires ?? defaultMaxFires
  while (observed.length < budget) {
    const next = service.nextDeadlineMs()
    if (next === null) break
    fireClock = Math.max(next, fireClock)
    clock.set(fireClock)
    if (service.poll(fireClock).length === 0) break
  }

  return observed
}

describe('the shared TimerCommand semantics fixture', () => {
  it('is version 1 and has a case for every op', () => {
    expect(fixture.version).toBe(1)
    const ops = new Set(
      fixture.cases.flatMap((entry) =>
        entry.steps.flatMap((step) => step.commands.map((c) => c.op)),
      ),
    )
    expect([...ops].sort()).toEqual(['clear', 'pause', 'resume', 'set'])
  })

  // Guards the quarantine list against the table moving underneath it: a
  // renamed or deleted row would otherwise leave a `DIVERGING_ROWS` entry that
  // excuses nothing and silences nothing, and the row it names would quietly
  // start being asserted (or stop existing) with no one told.
  it('quarantines only rows the table actually has', () => {
    const ids = new Set(fixture.cases.map((entry) => entry.id))
    expect([...DIVERGING_ROWS.keys()].filter((id) => !ids.has(id))).toEqual([])
  })

  // A `.each` over the table rather than one assertion per hand-written case,
  // for the same reason the testkit's copy of this file does it: a row added to
  // the fixture becomes a test on both sides with no edit to either file.
  it.each(
    fixture.cases
      .filter((entry) => !DIVERGING_ROWS.has(entry.id))
      .map((entry) => [entry.id, entry] as const),
  )('satisfies %s', (_id, testCase) => {
    expect(drive(testCase, fixture.defaultMaxFires)).toEqual(testCase.expectedFires)
  })

  // See `DIVERGING_ROWS`. `it.fails` asserts the body throws, so this block is
  // green only while the service still disagrees; fixing the service turns it
  // red with "expected test to fail", which is the signal to delete the entry.
  for (const [id, why] of DIVERGING_ROWS) {
    const testCase = fixture.cases.find((entry) => entry.id === id) as RawCase
    it.fails(`diverges from ${id} — ${why}`, () => {
      expect(drive(testCase, fixture.defaultMaxFires)).toEqual(testCase.expectedFires)
    })
  }

  /**
   * What the service does instead, stated positively.
   *
   * Arm order and id order are made to disagree in both directions on purpose:
   * one direction alone would also pass under an id-descending sort, and the
   * finding is specifically that nothing but insertion order decides this. The
   * room runner sees exactly this order — `poll` invokes `onExpire` in it — so a
   * two-timer game that flags on the same millisecond resolves by whichever
   * `set` the reducer happened to emit first.
   */
  it.each([
    ['arm alpha first', ['alpha', 'beta'] as const],
    ['arm beta first', ['beta', 'alpha'] as const],
  ])('orders an equal-deadline batch by arm order (%s)', (_label, armOrder) => {
    const clock = fixedClock(0)
    const fired: string[] = []
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: ['alpha', 'beta'].map(toSpec),
      onExpire: (expiry) => fired.push(String(expiry.timerId)),
    })

    service.apply(
      toCommands(armOrder.map((timerId) => ({ op: 'set' as const, timerId, delayMs: 2000 }))),
      0,
    )
    clock.set(2000)
    service.poll(2000)

    expect(fired).toEqual([...armOrder])
  })

  it('rejects a set for a timerId the manifest does not declare', () => {
    const { declaredTimerIds, steps } = fixture.undeclaredSetIsAnError
    const clock = fixedClock(0)
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: declaredTimerIds.map(toSpec),
    })

    expect(() => {
      for (const step of steps) service.apply(toCommands(step.commands), step.now)
    }).toThrow(/is not declared in the game manifest/)
  })

  it('arms nothing when it rejects an undeclared set', () => {
    const { declaredTimerIds, steps } = fixture.undeclaredSetIsAnError
    const clock = fixedClock(0)
    const expiries: string[] = []
    const service = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: declaredTimerIds.map(toSpec),
      onExpire: (expiry) => expiries.push(String(expiry.timerId)),
    })

    // Thrown rather than returned, and thrown from `apply`'s pre-pass so a
    // batch cannot be half-applied: the service's records are the room's only
    // account of what the game armed.
    for (const step of steps) {
      expect(() => service.apply(toCommands(step.commands), step.now)).toThrow()
    }
    expect(service.nextDeadlineMs()).toBeNull()
    expect(service.list()).toEqual([])
    expect(expiries).toEqual([])
  })
})
