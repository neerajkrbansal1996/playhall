/**
 * Client sync: offset estimation, and the acceptance criterion that a
 * reconnecting client resolves to the correct remaining time.
 *
 * Both sides use manual clocks, so "latency" is exact rather than sampled.
 * That makes the assertions exact too: the client either lands on the server's
 * number or it does not.
 */
import { asMatchId, asSeatId, asTimerId } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { type ManualClock, createManualClock } from '../src/timers/clock.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { TimerService } from '../src/timers/service.js'
import { ServerTimeSync, TimerSyncTracker } from '../src/timers/sync.js'
import { timerSyncMessageSchema } from '../src/timers/wire.js'

const MATCH = asMatchId('m1')
const WHITE = asSeatId('white')
const BLACK = asSeatId('black')
const WHITE_CLOCK = asTimerId('clock:white')
const BLACK_CLOCK = asTimerId('clock:black')
const TURN = asTimerId('turn')

/**
 * A server and a client whose clocks share no anchor at all. `clientSkewMs` is
 * how far the client's hardware clock is from the server's — nothing may
 * depend on it being small.
 */
function pair(options: { clientSkewMs?: number; upMs?: number; downMs?: number } = {}) {
  const serverClock = createManualClock(1_700_000_000_000)
  const clientClock = createManualClock(1_700_000_000_000 + (options.clientSkewMs ?? 0))
  const upMs = options.upMs ?? 40
  const downMs = options.downMs ?? 40

  const service = new TimerService({
    matchId: MATCH,
    clock: serverClock,
    scheduler: createManualScheduler(),
  })
  const tracker = new TimerSyncTracker({ clock: clientClock })

  /** One full round trip, with both clocks advancing for real. */
  function exchange(): void {
    const requestedAtMs = clientClock.now()
    serverClock.advance(upMs)
    clientClock.advance(upMs)
    const frame = service.sync()
    serverClock.advance(downMs)
    clientClock.advance(downMs)
    tracker.applySync(frame, { requestedAtMs, receivedAtMs: clientClock.now() })
  }

  /** Both clocks move together; only the *offset* between them is the test. */
  function elapse(ms: number): void {
    serverClock.advance(ms)
    clientClock.advance(ms)
  }

  return { serverClock, clientClock, service, tracker, exchange, elapse }
}

function clientRemaining(tracker: TimerSyncTracker, timerId: string): number {
  return tracker.views().find((view) => view.timerId === timerId)?.remainingMs ?? 0
}

describe('ServerTimeSync', () => {
  it('splits a symmetric round trip down the middle', () => {
    const sync = new ServerTimeSync()
    // Client clock is 10 s behind. Request at 1000, reply at 1100 (100 ms rtt),
    // server stamped the midpoint at 11_050.
    const estimate = sync.addSample({
      requestedAtMs: 1_000,
      receivedAtMs: 1_100,
      serverTimeMs: 11_050,
    })
    expect(estimate.offsetMs).toBe(10_000)
    expect(estimate.rttMs).toBe(100)
    expect(sync.serverNow(2_000)).toBe(12_000)
  })

  it('reports itself unsynced until the first sample', () => {
    const sync = new ServerTimeSync()
    expect(sync.isUnsynced).toBe(true)
    expect(sync.estimate.offsetMs).toBe(0)
    sync.addSample({ requestedAtMs: 0, receivedAtMs: 10, serverTimeMs: 5 })
    expect(sync.isUnsynced).toBe(false)
  })

  it('keeps the shortest round trip rather than averaging in the bad ones', () => {
    const sync = new ServerTimeSync()
    // A 600 ms sample (radio wake-up) and a 40 ms one. True offset is 0.
    sync.addSample({ requestedAtMs: 0, receivedAtMs: 600, serverTimeMs: 300 })
    sync.addSample({ requestedAtMs: 1_000, receivedAtMs: 1_040, serverTimeMs: 1_020 })
    sync.addSample({ requestedAtMs: 2_000, receivedAtMs: 2_800, serverTimeMs: 2_400 })

    expect(sync.estimate.rttMs).toBe(40)
    expect(sync.estimate.offsetMs).toBe(0)
  })

  it('lets an old best age out of the window', () => {
    const sync = new ServerTimeSync()
    // One excellent sample, then nine mediocre ones on a slower path.
    sync.addSample({ requestedAtMs: 0, receivedAtMs: 10, serverTimeMs: 5 })
    for (let i = 1; i <= 9; i += 1) {
      const requestedAtMs = i * 1_000
      sync.addSample({
        requestedAtMs,
        receivedAtMs: requestedAtMs + 200,
        serverTimeMs: requestedAtMs + 100,
      })
    }
    expect(sync.estimate.rttMs).toBe(200)
    expect(sync.estimate.sampleCount).toBe(8)
  })

  it('treats a reply that appears to arrive before it was sent as zero round trip', () => {
    const sync = new ServerTimeSync()
    const estimate = sync.addSample({ requestedAtMs: 100, receivedAtMs: 50, serverTimeMs: 50 })
    expect(estimate.rttMs).toBe(0)
  })
})

describe('a joining client resolves the server’s remaining time', () => {
  it('lands within a few ms of the server across a huge clock skew', () => {
    const p = pair({ clientSkewMs: 86_400_000 }) // a day out
    p.service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 300_000 })
    p.service.switchTurnTo(WHITE)

    p.exchange()
    p.elapse(30_000)

    const server = p.service.remainingMs(WHITE_CLOCK)
    const client = clientRemaining(p.tracker, WHITE_CLOCK)
    expect(server).toBe(300_000 - 30_000 - 80) // the round trip counted too
    // Symmetric path, so the half-rtt estimate is exact.
    expect(client).toBe(server)
  })

  it('is wrong by only the path asymmetry, not by the whole round trip', () => {
    // 90 ms up, 10 ms down. The midpoint estimate assumes 50/50, so the client
    // believes the server's clock is 40 ms behind where it is.
    const p = pair({ clientSkewMs: 0, upMs: 90, downMs: 10 })
    p.service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 300_000 })
    p.service.switchTurnTo(WHITE)

    p.exchange()
    p.elapse(120_000)

    const error = clientRemaining(p.tracker, WHITE_CLOCK) - p.service.remainingMs(WHITE_CLOCK)
    expect(Math.abs(error)).toBe(40)
    expect(Math.abs(error)).toBeLessThan(100)
  })

  it('does not accumulate error: five minutes later it is off by the same amount', () => {
    const p = pair({ clientSkewMs: 0, upMs: 90, downMs: 10 })
    p.service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 1_800_000 })
    p.service.switchTurnTo(WHITE)
    p.exchange()

    const errors: number[] = []
    for (let second = 0; second < 300; second += 1) {
      p.elapse(1_000)
      errors.push(clientRemaining(p.tracker, WHITE_CLOCK) - p.service.remainingMs(WHITE_CLOCK))
    }

    // Constant, not growing. This is the property that makes the drift budget
    // achievable at all: an absolute deadline has no accumulating term.
    expect(new Set(errors).size).toBe(1)
    expect(Math.abs(errors[errors.length - 1] as number)).toBeLessThan(100)
  })

  it('shows a paused clock’s frozen value, not a countdown', () => {
    const p = pair()
    p.service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 300_000 })
    p.service.declarePlayerClock(BLACK_CLOCK, BLACK, { initialMs: 300_000 })
    p.service.switchTurnTo(WHITE)
    p.elapse(10_000)
    p.exchange()

    p.elapse(600_000)
    expect(clientRemaining(p.tracker, BLACK_CLOCK)).toBe(300_000)
    expect(p.tracker.views().find((view) => view.timerId === BLACK_CLOCK)?.isRunning).toBe(false)
  })

  it('shows an expired clock as zero and stopped', () => {
    const p = pair()
    p.service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 1_000 })
    p.service.switchTurnTo(WHITE)
    p.elapse(2_000)
    p.service.poll()
    p.exchange()

    const view = p.tracker.views().find((entry) => entry.timerId === WHITE_CLOCK)
    expect(view?.remainingMs).toBe(0)
    expect(view?.isRunning).toBe(false)
  })
})

describe('reconnection', () => {
  it('a fresh client mid-match resolves to the same remaining time as the server', () => {
    const p = pair({ clientSkewMs: -450_000 })
    p.service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 600_000, incrementMs: 5_000 })
    p.service.declarePlayerClock(BLACK_CLOCK, BLACK, { initialMs: 600_000, incrementMs: 5_000 })

    // Four moves happen while the player is connected.
    p.service.switchTurnTo(WHITE)
    p.elapse(12_000)
    p.service.switchTurnTo(BLACK)
    p.elapse(8_000)
    p.service.switchTurnTo(WHITE)
    p.elapse(31_000)
    p.service.switchTurnTo(BLACK)

    // The phone goes through a tunnel for two minutes, then reconnects with a
    // brand-new tracker — no memory of anything.
    p.elapse(120_000)
    const reconnected = new TimerSyncTracker({ clock: p.clientClock })
    const requestedAtMs = p.clientClock.now()
    p.elapse(40)
    const frame = p.service.sync({ replyTo: 'msg-1' })
    p.elapse(40)
    reconnected.applySync(frame, { requestedAtMs, receivedAtMs: p.clientClock.now() })

    expect(frame.replyTo).toBe('msg-1')
    expect(clientRemaining(reconnected, WHITE_CLOCK)).toBe(p.service.remainingMs(WHITE_CLOCK))
    expect(clientRemaining(reconnected, BLACK_CLOCK)).toBe(p.service.remainingMs(BLACK_CLOCK))
    // Black has been on move through the whole tunnel; that time is theirs.
    expect(p.service.remainingMs(BLACK_CLOCK)).toBe(600_000 - 8_000 + 5_000 - 120_080)
  })

  it('a clock paused for the disconnect resolves to the value it was frozen at', () => {
    const p = pair()
    p.service.declarePlayerClock(WHITE_CLOCK, WHITE, { initialMs: 300_000 })
    p.service.switchTurnTo(WHITE)
    p.elapse(20_000)
    p.service.pauseForSeat(WHITE)

    p.elapse(300_000) // five minutes away
    p.service.resumeForSeat(WHITE)
    p.exchange()

    expect(clientRemaining(p.tracker, WHITE_CLOCK)).toBe(p.service.remainingMs(WHITE_CLOCK))
    expect(p.service.remainingMs(WHITE_CLOCK)).toBe(280_000 - 80)
  })

  it('renders nothing before the first sync rather than guessing', () => {
    const tracker = new TimerSyncTracker({ clock: createManualClock(0) })
    expect(tracker.isEmpty).toBe(true)
    expect(tracker.views()).toEqual([])
    expect(tracker.remainingMs('anything')).toBe(0)
  })
})

describe('the tracker is defensive about what comes off the socket', () => {
  it('parses rather than trusts', () => {
    const tracker = new TimerSyncTracker({ clock: createManualClock(0) })
    expect(() => tracker.applySync({ type: 'timer:sync' })).toThrow()
    expect(() =>
      tracker.applySync({ type: 'nope', matchId: 'm', serverTime: 0, timers: [] }),
    ).toThrow()
    expect(() =>
      tracker.applySync({
        type: 'timer:sync',
        matchId: 'm',
        serverTime: 0,
        timers: [
          {
            timerId: 't',
            seatId: null,
            kind: 'turn',
            state: 'running',
            remainingMs: -5,
            deadlineAtMs: 1,
            delayRemainingMs: 0,
            version: 1,
          },
        ],
      }),
    ).toThrow()
  })

  it('drops a frame that was overtaken, but still uses its round trip', () => {
    const p = pair()
    p.service.set(TURN, { delayMs: 30_000 })

    const older = p.service.sync()
    p.elapse(5_000)
    p.service.set(TURN, { delayMs: 10_000 })
    const newer = p.service.sync()

    p.tracker.applySync(newer, {
      requestedAtMs: p.clientClock.now(),
      receivedAtMs: p.clientClock.now(),
    })
    expect(clientRemaining(p.tracker, TURN)).toBe(10_000)

    // The stale frame arrives second. It must not roll the clock back.
    p.tracker.applySync(older, {
      requestedAtMs: p.clientClock.now() - 20,
      receivedAtMs: p.clientClock.now(),
    })
    expect(clientRemaining(p.tracker, TURN)).toBe(10_000)
    expect(p.tracker.serverTimeSync.estimate.rttMs).toBe(0)
  })

  it('accepts an unsolicited push without inventing a round-trip sample', () => {
    const p = pair()
    p.service.set(TURN, { delayMs: 30_000 })
    p.tracker.applySync(p.service.sync())
    expect(p.tracker.serverTimeSync.isUnsynced).toBe(true)
    expect(p.tracker.isEmpty).toBe(false)
  })

  it('drops a timer that the server cleared', () => {
    const p = pair()
    p.service.set(TURN, { delayMs: 30_000 })
    p.exchange()
    expect(p.tracker.views()).toHaveLength(1)

    p.service.clear(TURN)
    p.exchange()
    expect(p.tracker.views()).toHaveLength(0)
  })

  it('asks for a timer that does not exist and gets a stopped clock, not a crash', () => {
    const p = pair()
    p.service.set(TURN, { delayMs: 30_000 })
    p.exchange()
    expect(p.tracker.remainingMs('not-a-timer')).toBe(0)
    expect(p.tracker.remainingMs(TURN)).toBe(p.service.remainingMs(TURN))
  })
})

describe('the wire frame', () => {
  it('validates against its own schema', () => {
    const p = pair()
    p.service.declarePlayerClock(WHITE_CLOCK, WHITE, {
      initialMs: 300_000,
      delayMs: 3_000,
      delayMode: 'simple',
    })
    p.service.switchTurnTo(WHITE)
    p.service.set(TURN, { delayMs: 30_000, kind: 'turn' })
    p.elapse(1_000)

    const frame = p.service.sync()
    expect(() => timerSyncMessageSchema.parse(frame)).not.toThrow()
    expect(frame.type).toBe('timer:sync')
    expect(frame.matchId).toBe(MATCH)
    expect(frame.serverTime).toBe(p.serverClock.now())

    const white = frame.timers.find((timer) => timer.timerId === WHITE_CLOCK)
    expect(white).toMatchObject({
      seatId: WHITE,
      kind: 'chess-clock',
      state: 'running',
      remainingMs: 300_000,
      delayRemainingMs: 2_000,
    })
    // An absolute deadline, in server time: 300 s of budget behind 3 s of delay.
    expect(white?.deadlineAtMs).toBe(p.serverClock.now() - 1_000 + 303_000)
  })

  it('carries integers only, so no client has to decide how to round', () => {
    const clock: ManualClock = createManualClock(0)
    const service = new TimerService({ matchId: MATCH, clock, scheduler: createManualScheduler() })
    service.set(TURN, { delayMs: 1_500 })
    clock.advance(333)

    for (const timer of service.sync().timers) {
      expect(Number.isInteger(timer.remainingMs)).toBe(true)
      expect(Number.isInteger(timer.delayRemainingMs)).toBe(true)
      expect(timer.deadlineAtMs === null || Number.isInteger(timer.deadlineAtMs)).toBe(true)
    }
  })
})
