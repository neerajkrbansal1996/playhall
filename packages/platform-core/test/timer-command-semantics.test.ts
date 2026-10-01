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
 * Intentionally empty: the service satisfies every row. The mechanism is kept
 * rather than deleted because it is the honest way to carry a divergence that
 * only an ADR can settle, and the next one should land in it rather than be
 * resolved by whoever notices first — ADR-0010 §4 reserves "which reading is
 * normative" to an ADR, not to either suite.
 *
 * It last held `ties-break-by-timer-id-ascending`, where the table required
 * `timerId` ascending and `TimerService.poll` delivered an equal-deadline batch
 * in arm order. ADR-0010 §4a decided for the table; `compareFireOrder` in
 * `../src/timers/service.ts` implements it, and the two directions are asserted
 * below under "does not let arm order decide an equal-deadline batch".
 */
const DIVERGING_ROWS: ReadonlyMap<string, string> = new Map()

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
   * ADR-0010 §4a, stated as the independence property rather than as an order.
   *
   * Both arm orders are driven and both must produce `timerId` ascending. Either
   * direction alone is a weaker assertion than it looks: "arm alpha first" also
   * passes under the arm-order reading the service used to have, and "arm beta
   * first" also passes under a rule that simply reverses arm order. Only the
   * pair says what §4a actually decided — that arm order does not decide this.
   *
   * The room runner sees exactly this order, because `poll` invokes `onExpire`
   * in it, so this is the order `game.onTimer` is called in for a two-timer game
   * whose clocks fall on the same millisecond.
   *
   * The same pair exists in the shared table as
   * `ties-break-by-timer-id-ascending` and `...-when-armed-in-id-order`, which
   * is what holds `TimerQueue` to it too; this keeps the property legible in the
   * suite that owns the service.
   */
  it.each([
    ['arm alpha first', ['alpha', 'beta'] as const],
    ['arm beta first', ['beta', 'alpha'] as const],
  ])('does not let arm order decide an equal-deadline batch (%s)', (_label, armOrder) => {
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

    expect(fired).toEqual(['alpha', 'beta'])
  })

  /**
   * The service's *second* ordering site, which the shared table cannot reach.
   *
   * `#forceExpireDue` sorts its own batch — the `MAX_DRAIN_PASSES` escape hatch
   * reports through `onDrainExhausted`, not `onExpire`, so the fixture driver
   * (which only observes `onExpire`) never sees it, and `TimerQueue` has no
   * equivalent of a drain cap for a row to describe. It had the same
   * deadline-only sort `poll` did and would have been left behind by a fix
   * applied only where PER-255 pointed.
   *
   * It is a bug-signal path, but an ordered one: `onDrainExhausted` is what tells
   * an operator which clocks a runaway handler cost a live match, and the same
   * batch arriving in a different order on a replay than it did live is the
   * reason the primary path is ordered in the first place.
   */
  it('orders the force-expired batch by timerId when the drain cap is hit', () => {
    const clock = fixedClock(0)
    const batches: string[][] = []
    const service: TimerService = new TimerService({
      matchId: MATCH,
      clock,
      scheduler: createManualScheduler(),
      specs: ['zulu', 'alpha'].map(toSpec),
      // Re-arms itself already-due on every pass: the exact runaway handler
      // `MAX_DRAIN_PASSES` exists to terminate. The nested `apply` does not
      // re-enter the drain — `#drainDue` is a no-op while firing — so this grows
      // the pass count rather than the stack.
      onExpire: (expiry) => {
        service.apply(
          toCommands([{ op: 'set', timerId: String(expiry.timerId), delayMs: 0 }]),
          expiry.dueAtMs,
        )
      },
      onDrainExhausted: (batch) => {
        batches.push(batch.map((expiry) => String(expiry.timerId)))
      },
    })

    // Armed in reverse id order and in the *future*, so `#records` insertion
    // order and id order disagree. Arming both at `delayMs: 0` instead would
    // prove nothing: `apply` runs each command through `set`, which is itself a
    // mutator that drains, so the first id would hit the cap and be force-expired
    // alone before the second was ever armed — two batches of one, which no
    // ordering can get wrong.
    service.apply(
      toCommands([
        { op: 'set', timerId: 'zulu', delayMs: 2000 },
        { op: 'set', timerId: 'alpha', delayMs: 2000 },
      ]),
      0,
    )

    // One mutation that steps over the shared deadline. Both are due in the same
    // pass, so the runaway keeps both alive to the cap and they are force-expired
    // as one batch.
    clock.set(2000)
    service.apply([], 2000)

    expect(batches).toEqual([['alpha', 'zulu']])
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
