/**
 * The server's clock. One per process, owned by the composition root.
 *
 * This lives in `apps/realtime` and not in a package, and that placement is
 * the point rather than an accident of layout. A `packages` source tree may not
 * read ambient time at all (ADR-0002 §4, and §4 says of that ban that "an escape
 * hatch here is never granted"). `platform-core` therefore takes a `Clock`
 * port — `TimerServiceOptions.clock` is required, so a room cannot be built
 * without being handed one — and the one implementation that actually reads
 * the host lives here, in the layer that is already exempt because it is where
 * the process starts.
 *
 * ## Why not just `Date.now()`
 *
 * A timer service that samples `Date.now()` inherits every wall-clock
 * adjustment the host makes. NTP does not only speed the clock up or slow it
 * down; `ntpd`/`chronyd` will *step* it when the offset is large, and a
 * container resuming from a paused host can see a step of seconds. A chess
 * clock that loses a second because the host synced with an upstream server is
 * a bug players notice and cannot be told to ignore.
 *
 * So the clock is anchored once:
 *
 *     now() = wallOrigin + (performance.now() - monoOrigin)
 *
 * `performance.now()` is a monotonic counter that no clock adjustment touches,
 * so every *duration* the timer service measures is immune to wall-clock steps.
 * The epoch offset is fixed at construction, which is what makes the returned
 * value still meaningful as "ms since the Unix epoch" to a client.
 *
 * ## The tradeoff, stated
 *
 * Because the anchor is never refreshed, `now()` slowly diverges from true wall
 * time at the rate of the host's oscillator error (tens of ppm — single-digit
 * ms over the ~1 h life of a room). That does not matter: clients synchronise
 * to *this* clock via `timer:sync`, not to their own, so the server's clock is
 * correct by definition for the duration of a match. It matters only across a
 * process restart, where the new process re-anchors — see `restoreTimerService`
 * in `platform-core`, which rejects a snapshot stamped after the restoring
 * process's own clock.
 *
 * The browser shell needs the same construction for the client half of
 * `timer:sync` (see `TimerSyncTrackerOptions.clock`). It cannot import this
 * one — apps do not import each other — so until there is a home a package can
 * expose, `apps/web` carries its own. Flagged to the CTO on PER-70.
 */

import type { Clock } from '@playhall/platform-core'

/**
 * The production clock. Call once per process and share the instance — two
 * instances anchor at different moments and would disagree by their
 * construction gap, which is the "second unsynchronised notion of now" the
 * whole port exists to prevent.
 */
export function createSystemClock(): Clock {
  const wallOriginMs = Date.now()
  const monoOriginMs = performance.now()
  return {
    now(): number {
      // Rounded, not truncated: timers are compared against integers all the
      // way down, and truncation biases every measured duration low by up to
      // 1 ms per sample.
      return Math.round(wallOriginMs + (performance.now() - monoOriginMs))
    },
  }
}
