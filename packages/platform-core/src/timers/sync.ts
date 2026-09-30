/**
 * The client half of timer sync.
 *
 * Lives in platform-core rather than in a game because principle 1 says so:
 * every game renders clocks, so no game may own the code that computes them.
 * `apps/web` imports this; a game package never does — it receives the finished
 * `TimerView[]` through the SDK.
 *
 * ## How a client ends up with the right number on screen
 *
 * 1. The client stamps its own clock, sends `timer:sync-request`, and stamps
 *    again when the answer arrives. That gives a round trip and a server time
 *    for the midpoint of it.
 * 2. `offset = serverTime + rtt / 2 - receivedAt` estimates
 *    `serverClock - clientClock`.
 * 3. Remaining time for a running timer is then
 *    `deadlineAtMs - (clientNow + offset)` — an absolute deadline minus an
 *    absolute now. Nothing counts down locally, so nothing accumulates error.
 *
 * ## Why the minimum-round-trip filter
 *
 * `rtt / 2` assumes a symmetric path. On mobile data it often is not, and a
 * single sample that queued behind a radio wake-up can be 500 ms off. NTP's
 * answer, which this borrows, is that the *shortest* observed round trip is the
 * least contaminated one: a sample cannot be faster than the true path, so the
 * minimum is the closest to symmetric. We keep a small window of samples and
 * use the best one rather than averaging in the bad ones.
 *
 * The client clock must be monotonic (`createSystemClock`). A phone that
 * corrects its wall clock mid-match would otherwise jump every timer at once.
 */

import type { SeatId, TimerKind } from '@playhall/game-sdk'
import type { Clock } from './clock.js'
import { createSystemClock } from './clock.js'
import type { TimerSyncMessage } from './wire.js'
import { timerSyncMessageSchema } from './wire.js'

export interface RoundTripSample {
  /** Client clock when the request went out. */
  readonly requestedAtMs: number
  /** Client clock when the answer arrived. */
  readonly receivedAtMs: number
  /** `serverTime` from the answer. */
  readonly serverTimeMs: number
}

export interface OffsetEstimate {
  /** `serverClock - clientClock`, in ms. */
  readonly offsetMs: number
  /** The round trip of the sample the estimate came from. */
  readonly rttMs: number
  readonly sampleCount: number
}

/** How many samples to keep. Eight covers ~30 s of a 4 s keepalive. */
const SAMPLE_WINDOW = 8

/**
 * Estimates the client-to-server clock offset from timed round trips.
 * Standalone so the reconnect path and the keepalive path share one estimator.
 */
export class ServerTimeSync {
  #samples: RoundTripSample[] = []
  #best: OffsetEstimate = { offsetMs: 0, rttMs: Number.POSITIVE_INFINITY, sampleCount: 0 }

  addSample(sample: RoundTripSample): OffsetEstimate {
    this.#samples.push(sample)
    if (this.#samples.length > SAMPLE_WINDOW) this.#samples.shift()

    // Recompute over the window rather than keeping a running best: an old
    // best from before a network change must be able to age out.
    let best: OffsetEstimate = {
      offsetMs: this.#best.offsetMs,
      rttMs: Number.POSITIVE_INFINITY,
      sampleCount: this.#samples.length,
    }
    for (const candidate of this.#samples) {
      const candidateRtt = Math.max(0, candidate.receivedAtMs - candidate.requestedAtMs)
      if (candidateRtt < best.rttMs) {
        best = {
          offsetMs: candidate.serverTimeMs + candidateRtt / 2 - candidate.receivedAtMs,
          rttMs: candidateRtt,
          sampleCount: this.#samples.length,
        }
      }
    }
    this.#best = best
    return this.#best
  }

  get estimate(): OffsetEstimate {
    return this.#best
  }

  /** The server's clock, as best this client can tell, at `clientNowMs`. */
  serverNow(clientNowMs: number): number {
    return clientNowMs + this.#best.offsetMs
  }

  /** True before any sample has landed — the UI should show clocks as stale. */
  get isUnsynced(): boolean {
    return this.#best.sampleCount === 0
  }
}

/** Exactly the SDK's `TimerView`, rebuilt client-side. */
export interface ClientTimerView {
  readonly timerId: string
  readonly seatId: SeatId | null
  readonly kind: TimerKind
  readonly remainingMs: number
  readonly isRunning: boolean
}

export interface TimerSyncTrackerOptions {
  /** Monotonic client clock. Defaults to the real one. */
  readonly clock?: Clock
}

/**
 * Holds the last `timer:sync` and turns it into renderable views on demand.
 *
 * The render loop calls `views()` every animation frame; that is a pure
 * subtraction against the stored deadlines, not a countdown, so a dropped
 * frame or a backgrounded tab costs nothing.
 */
export class TimerSyncTracker {
  #clock: Clock
  #sync = new ServerTimeSync()
  #message: TimerSyncMessage | null = null

  constructor(options: TimerSyncTrackerOptions = {}) {
    this.#clock = options.clock ?? createSystemClock()
  }

  get serverTimeSync(): ServerTimeSync {
    return this.#sync
  }

  /**
   * Feeds in a frame off the socket.
   *
   * `raw` is parsed, not trusted: this is a client parsing bytes it did not
   * create, and a clock is exactly the kind of field where a `NaN` renders as
   * `NaN:NaN` for the rest of the match.
   *
   * `requestedAtMs` is the client stamp from just before the request that
   * produced this frame. Omit it for an unsolicited push — the frame still
   * updates the timers, it just does not contribute a new offset sample,
   * because an unsolicited frame has no measured round trip.
   */
  applySync(
    raw: unknown,
    arrival: { requestedAtMs?: number; receivedAtMs?: number } = {},
  ): TimerSyncMessage {
    const message = timerSyncMessageSchema.parse(raw)
    const receivedAtMs = arrival.receivedAtMs ?? this.#clock.now()

    if (arrival.requestedAtMs !== undefined) {
      this.#sync.addSample({
        requestedAtMs: arrival.requestedAtMs,
        receivedAtMs,
        serverTimeMs: message.serverTime,
      })
    }

    // A sync frame is a complete picture, so a newer one replaces the previous
    // wholesale — that is how a cleared timer actually disappears from the HUD.
    // An overtaken frame is dropped for state but its round trip is still a
    // valid offset sample, which is why the ordering check comes after it.
    if (this.#message === null || message.serverTime >= this.#message.serverTime) {
      this.#message = message
    }
    return this.#message
  }

  /** True until the first `applySync`. */
  get isEmpty(): boolean {
    return this.#message === null
  }

  /**
   * Remaining time for one timer, corrected for clock offset. Zero for an
   * unknown timer, so a UI that asks for a timer this game does not have gets
   * a stopped clock rather than a crash.
   */
  remainingMs(timerId: string, clientNowMs?: number): number {
    const view = this.views(clientNowMs).find((entry) => entry.timerId === timerId)
    return view?.remainingMs ?? 0
  }

  /**
   * Every timer, as the SDK's `TimerView`.
   *
   * ## Why the deadline alone is not the answer for a delay clock
   *
   * `deadlineAtMs` is `startedAt + unspentDelay + remaining`, because a US-delay
   * clock does not expire until the delay *and* the budget are gone. So for a
   * `simple`-delay clock the deadline has the unspent delay baked into it, and
   * rendering `deadline - now` shows the player budget + delay — up to `delayMs`
   * too much, on every clock, for the first seconds of every turn.
   *
   * The frame carries `delayRemainingMs` as of `serverTime` for exactly this. Age
   * it forward to the instant we are rendering, then take it back out of the
   * deadline. Both terms are absolute, so this stays a subtraction and nothing
   * counts down locally.
   */
  views(clientNowMs?: number): readonly ClientTimerView[] {
    const message = this.#message
    if (message === null) return []
    const serverNow = this.#sync.serverNow(clientNowMs ?? this.#clock.now())
    const sinceFrameMs = Math.max(0, serverNow - message.serverTime)
    return message.timers.map((timer) => {
      const running = timer.state === 'running' && timer.deadlineAtMs !== null
      if (!running) {
        return {
          timerId: timer.timerId,
          seatId: (timer.seatId as SeatId | null) ?? null,
          kind: timer.kind,
          remainingMs: timer.remainingMs,
          isRunning: false,
        }
      }
      const unspentDelayMs = Math.max(0, timer.delayRemainingMs - sinceFrameMs)
      return {
        timerId: timer.timerId,
        seatId: (timer.seatId as SeatId | null) ?? null,
        kind: timer.kind,
        remainingMs: Math.max(
          0,
          Math.round((timer.deadlineAtMs as number) - serverNow - unspentDelayMs),
        ),
        isRunning: true,
      }
    })
  }
}
