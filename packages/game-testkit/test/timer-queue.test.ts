/**
 * `TimerQueue` against the shared semantics table (ADR-0010 §4).
 *
 * The table lives at `packages/game-sdk/test/fixtures/timer-command-semantics.json`
 * and is read from disk rather than re-declared here on purpose. It is the
 * contract between two implementations that cannot share code —
 * `no-testkit-to-platform` (ADR-0002 §2) forbids the testkit importing
 * `packages/platform-core`, so the driver's queue and the real `TimerService`
 * are two readings of the same prose. A copy of the table in this file would
 * let the two drift while both suites stayed green, which is the exact failure
 * the fixture exists to prevent.
 *
 * It is loaded by path, not by package import: the testkit does not depend on
 * `game-sdk`'s test tree, and nothing should make it.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { asTimerId, type TimerCommand } from '@playhall/game-sdk'
import { TimerQueue, UndeclaredTimerError } from '../src/internal/timer-queue.js'

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

/**
 * The table stores commands as plain JSON, so the branded ids are reapplied
 * here. `seatId` is cast rather than passed through an `asSeatId` because the
 * queue only ever carries it to `onTimer`; it is not interpreted.
 */
function toCommands(raw: readonly RawCommand[]): readonly TimerCommand[] {
  return raw.map((command) => {
    switch (command.op) {
      case 'set':
        return {
          op: 'set' as const,
          timerId: asTimerId(command.timerId),
          seatId: (command.seatId ?? null) as never,
          delayMs: command.delayMs ?? 0,
          ...(command.replace === undefined ? {} : { replace: command.replace }),
        }
      default:
        return { op: command.op, timerId: asTimerId(command.timerId) }
    }
  })
}

/**
 * Runs one case exactly as the fixture's "how to run a case" prose says: apply
 * every step, then drain by firing the earliest-deadline unpaused timer and
 * applying that fire's own commands at `max(deadline, previous clock)`.
 */
function drain(testCase: RawCase, defaultMaxFires: number): readonly RawFire[] {
  const queue = new TimerQueue(testCase.declaredTimerIds)
  for (const step of testCase.steps) {
    queue.apply(toCommands(step.commands), step.now)
  }

  const budget = testCase.maxFires ?? defaultMaxFires
  const observed: RawFire[] = []
  let clock = Number.NEGATIVE_INFINITY

  for (let fired = 0; fired < budget; fired += 1) {
    const due = queue.takeNext()
    if (due === null) break
    clock = Math.max(due.deadline, clock)
    observed.push({
      timerId: String(due.timerId),
      deadline: due.deadline,
      seatId: due.seatId === null ? null : String(due.seatId),
    })
    const onFire = testCase.onFire?.[String(due.timerId)]
    if (onFire !== undefined) queue.apply(toCommands(onFire), clock)
  }

  return observed
}

describe('the shared TimerCommand semantics fixture', () => {
  it('is version 1 and has a case for every op', () => {
    expect(fixture.version).toBe(1)
    const ops = new Set(
      fixture.cases.flatMap((entry) => entry.steps.flatMap((step) => step.commands.map((c) => c.op))),
    )
    expect([...ops].sort()).toEqual(['clear', 'pause', 'resume', 'set'])
  })

  // A `.each` over the table rather than one assertion per hand-written case:
  // a row added to the fixture by whoever lands `TimerService` becomes a test
  // here with no edit to this file, which is the point of a shared table.
  it.each(fixture.cases.map((entry) => [entry.id, entry] as const))(
    'satisfies %s',
    (_id, testCase) => {
      expect(drain(testCase, fixture.defaultMaxFires)).toEqual(testCase.expectedFires)
    },
  )

  it('rejects a set for a timerId the manifest does not declare', () => {
    const { declaredTimerIds, steps } = fixture.undeclaredSetIsAnError
    const queue = new TimerQueue(declaredTimerIds)

    expect(() => {
      for (const step of steps) queue.apply(toCommands(step.commands), step.now)
    }).toThrow(UndeclaredTimerError)
  })

  it('names the offending id and what was declared in the rejection', () => {
    const queue = new TimerQueue(['grace', 'first-move'])

    // Thrown rather than returned so a `set` cannot be half-applied: the queue
    // is the driver's only record of what the game armed.
    let caught: unknown
    try {
      queue.apply(toCommands([{ op: 'set', timerId: 'ghost', delayMs: 10 }]), 0)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(UndeclaredTimerError)
    const error = caught as UndeclaredTimerError
    expect(error.timerId).toBe('ghost')
    expect(error.message).toContain("manifest.timers does not declare")
    // Sorted, so the message does not depend on manifest order.
    expect(error.message).toContain('first-move, grace')
  })
})

describe('TimerQueue reporting', () => {
  it('reports nothing armed on an empty queue', () => {
    expect(new TimerQueue(['a']).describe()).toBe('nothing')
    expect(new TimerQueue(['a']).peek()).toBeNull()
    expect(new TimerQueue(['a']).takeNext()).toBeNull()
  })

  it('distinguishes a paused timer from a running one in describe()', () => {
    const queue = new TimerQueue(['a', 'b'])
    queue.apply(
      toCommands([
        { op: 'set', timerId: 'a', delayMs: 1000 },
        { op: 'set', timerId: 'b', delayMs: 2000 },
        { op: 'pause', timerId: 'b' },
      ]),
      0,
    )

    // Running first in fire order, paused last — the order a failure message
    // needs: "this is what was armed instead".
    expect(queue.describe()).toBe('a@1000, b (paused)')
  })

  it('tracks whether an id was ever armed, independently of whether it is still armed', () => {
    const queue = new TimerQueue(['a', 'b'])
    queue.apply(
      toCommands([
        { op: 'set', timerId: 'a', delayMs: 1000 },
        { op: 'clear', timerId: 'a' },
      ]),
      0,
    )

    // The distinction the never-armed failure rests on: `a` was armed and
    // cleared (a legal game), `b` never was (a scenario naming a timer the
    // game does not use).
    expect(queue.wasEverArmed(asTimerId('a'))).toBe(true)
    expect(queue.wasEverArmed(asTimerId('b'))).toBe(false)
    expect(queue.peek()).toBeNull()
  })

  it('does not count a rejected set as ever armed', () => {
    const queue = new TimerQueue(['a'])
    expect(() => queue.apply(toCommands([{ op: 'set', timerId: 'ghost', delayMs: 1 }]), 0)).toThrow()
    expect(queue.wasEverArmed('ghost')).toBe(false)
  })

  it('leaves the timer in place on peek and removes it on takeNext', () => {
    const queue = new TimerQueue(['a'])
    queue.apply(toCommands([{ op: 'set', timerId: 'a', delayMs: 50 }]), 0)

    expect(queue.peek()?.deadline).toBe(50)
    expect(queue.peek()?.deadline).toBe(50)
    expect(queue.takeNext()?.deadline).toBe(50)
    expect(queue.takeNext()).toBeNull()
  })
})
