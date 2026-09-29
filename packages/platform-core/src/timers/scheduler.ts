/**
 * The one piece of the timer service that touches the event loop.
 *
 * The service arms *a single* timeout for the earliest deadline across all
 * timers in the room, and re-arms after every firing. One timeout per room
 * rather than one per timer is what makes 2,000 concurrent rooms on one
 * instance affordable: a room with four clocks, a turn timer and a match timer
 * still costs exactly one entry in Node's timer heap.
 *
 * Firing accuracy is deliberately *not* this module's problem. `setTimeout` is
 * late under load and Node caps it at ~24.8 days; both are handled by the
 * service re-reading the clock when it wakes and recomputing deadlines from
 * anchors, so a late or short wake-up costs nothing but a second pass.
 */

import type { Clock } from './clock.js'

export interface Scheduler {
  /** Arm for `atMs`, replacing any previous arm. */
  arm(atMs: number, fire: () => void): void
  /** Cancel any pending arm. */
  disarm(): void
}

/** `setTimeout` will not accept a delay above this; it wraps to 1 ms if you try. */
const MAX_TIMEOUT_MS = 2_147_483_647

export function createTimeoutScheduler(clock: Clock): Scheduler {
  let handle: ReturnType<typeof setTimeout> | null = null

  return {
    arm(atMs: number, fire: () => void): void {
      if (handle !== null) clearTimeout(handle)
      const delayMs = Math.min(MAX_TIMEOUT_MS, Math.max(0, atMs - clock.now()))
      handle = setTimeout(() => {
        handle = null
        fire()
      }, delayMs)
      // A room waiting on a 30-minute expiry must not hold the process open.
      handle.unref?.()
    },
    disarm(): void {
      if (handle !== null) {
        clearTimeout(handle)
        handle = null
      }
    },
  }
}

/**
 * A scheduler that never fires on its own; the test drives the manual clock and
 * calls `service.poll()`. Keeps every timer test synchronous and instant.
 */
export function createManualScheduler(): Scheduler {
  return {
    arm(): void {},
    disarm(): void {},
  }
}
