/**
 * The conformance driver's timer queue (ADR-0010 §1).
 *
 * The suite cannot reach a timer-driven ending by calling `onTimer` itself: a
 * game with an `onTimer` arm for `'first-move'` that never emits
 * `setTimer('first-move', …)` would then go green on an ending production can
 * never reach. So the driver honours the commands the game actually emitted —
 * this queue — and fires the expiry the game itself scheduled. `onTimer`'s
 * `seatId` comes from that `set` command, not from a scenario author.
 *
 * It is not `TimerService`. `no-testkit-to-platform` (ADR-0002 §2) forbids the
 * testkit importing `packages/platform-core`, so this is deliberately a second
 * reading of the same semantics. The two are held together by the data table at
 * `packages/game-sdk/test/fixtures/timer-command-semantics.json`, which both
 * must pass; a new op or a changed tie-break adds a row there first.
 *
 * Scope: deciding *which timer is due and when*. Clamping `ctx.now` for the
 * resulting call is the driver's job (`timerAbortRun` in `driver.ts`), because
 * it is the thing that knows what the previous mutation's clock was.
 */

import type { SeatId, TimerCommand, TimerId } from '@playhall/game-sdk'

/**
 * A `set` for a `timerId` the manifest never declared.
 *
 * `TurnBasedGameServer.onTimer` promises that `timerId` always corresponds to a
 * declared `TimerSpec`, and the real service enforces it through its `specs`
 * option. A game that breaks the promise would have the platform drop the
 * `set` on the floor in production, so the harness fails the scenario rather
 * than arming a timer that could not exist.
 */
export class UndeclaredTimerError extends Error {
  readonly timerId: string
  readonly declared: readonly string[]

  constructor(timerId: string, declared: readonly string[]) {
    super(
      `the game set a timer '${timerId}' that manifest.timers does not declare (declared: ${
        declared.length === 0 ? 'none' : declared.join(', ')
      })`,
    )
    this.name = 'UndeclaredTimerError'
    this.timerId = timerId
    this.declared = declared
  }
}

export interface ArmedTimer {
  readonly timerId: TimerId
  /** Taken from the `set` command, which is why the scenario cannot invent one. */
  readonly seatId: SeatId | null
  /** Absolute ms. While paused this is the pre-pause value and is not due. */
  readonly deadline: number
  /** Milliseconds that remained when it was paused, or `null` while running. */
  readonly pausedRemainingMs: number | null
}

/** Earliest deadline first; ties by `timerId` ascending. */
function dueOrder(a: ArmedTimer, b: ArmedTimer): number {
  if (a.deadline !== b.deadline) return a.deadline - b.deadline
  return String(a.timerId) < String(b.timerId) ? -1 : 1
}

export class TimerQueue {
  readonly #declared: ReadonlySet<string>
  readonly #armed = new Map<string, ArmedTimer>()
  readonly #everArmed = new Set<string>()

  constructor(declaredTimerIds: Iterable<string>) {
    this.#declared = new Set(declaredTimerIds)
  }

  /**
   * Applies one call's `ApplyResult.timers`.
   *
   * `now` is the `ctx.now` of the call that returned them — `timers.ts` is
   * explicit that a `set`'s `delayMs` resolves against exactly that instant,
   * which is what makes a deadline a pure function of the log.
   *
   * Throws `UndeclaredTimerError` on a `set` for an id outside the manifest.
   * `clear` / `pause` / `resume` for an unknown or unarmed id are no-ops: a
   * game that clears defensively on every move is doing nothing wrong.
   */
  apply(commands: readonly TimerCommand[], now: number): void {
    for (const command of commands) {
      const key = String(command.timerId)
      switch (command.op) {
        case 'set': {
          if (!this.#declared.has(key)) {
            throw new UndeclaredTimerError(key, [...this.#declared].sort())
          }
          // `SetTimerCommand.replace` defaults true.
          if (command.replace === false && this.#armed.has(key)) break
          this.#armed.set(key, {
            timerId: command.timerId,
            seatId: command.seatId,
            deadline: now + command.delayMs,
            pausedRemainingMs: null,
          })
          this.#everArmed.add(key)
          break
        }
        case 'clear':
          this.#armed.delete(key)
          break
        case 'pause': {
          const entry = this.#armed.get(key)
          // Idempotent. Re-measuring from a later clock would silently extend
          // the timer every time a game paused twice.
          if (entry === undefined || entry.pausedRemainingMs !== null) break
          this.#armed.set(key, { ...entry, pausedRemainingMs: entry.deadline - now })
          break
        }
        case 'resume': {
          const entry = this.#armed.get(key)
          if (entry === undefined || entry.pausedRemainingMs === null) break
          this.#armed.set(key, {
            ...entry,
            deadline: now + entry.pausedRemainingMs,
            pausedRemainingMs: null,
          })
          break
        }
      }
    }
  }

  /** Whether a `set` for this id has been honoured at any point in the run. */
  wasEverArmed(timerId: TimerId | string): boolean {
    return this.#everArmed.has(String(timerId))
  }

  /** The next timer to fire, without removing it. Paused timers are not due. */
  peek(): ArmedTimer | null {
    let best: ArmedTimer | null = null
    for (const entry of this.#armed.values()) {
      if (entry.pausedRemainingMs !== null) continue
      if (best === null || dueOrder(entry, best) < 0) best = entry
    }
    return best
  }

  /**
   * Removes and returns the next timer to fire.
   *
   * Expiry disarms: the real service does not re-arm on its own, and a queue
   * that left it in place would fire the same deadline forever. A game that
   * wants another one returns a fresh `set` from `onTimer`.
   */
  takeNext(): ArmedTimer | null {
    const next = this.peek()
    if (next !== null) this.#armed.delete(String(next.timerId))
    return next
  }

  /** Everything still armed, in fire order, with paused timers last. */
  snapshot(): readonly ArmedTimer[] {
    const running = [...this.#armed.values()].filter((entry) => entry.pausedRemainingMs === null)
    const paused = [...this.#armed.values()].filter((entry) => entry.pausedRemainingMs !== null)
    return [
      ...running.sort(dueOrder),
      ...paused.sort((a, b) => (String(a.timerId) < String(b.timerId) ? -1 : 1)),
    ]
  }

  /** One line for a failure message, e.g. `first-move@31000, grace (paused)`. */
  describe(): string {
    const entries = this.snapshot()
    if (entries.length === 0) return 'nothing'
    return entries
      .map((entry) =>
        entry.pausedRemainingMs === null
          ? `${String(entry.timerId)}@${String(entry.deadline)}`
          : `${String(entry.timerId)} (paused)`,
      )
      .join(', ')
  }
}
