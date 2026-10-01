/**
 * The pure clock arithmetic. Everything here is exact — no real time is
 * involved, so an assertion that is off by a millisecond is a bug, not jitter.
 */
import { asSeatId, asTimerId } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAYER_CLOCK,
  type PlayerClockConfig,
  chargeableElapsedMs,
  createTimerRecord,
  deadlineMsAt,
  delayRemainingMsAt,
  endTurnRecord,
  expireRecord,
  isRunning,
  pauseRecord,
  rawElapsedMs,
  remainingMsAt,
  resetRecord,
  resumeRecord,
  startRecord,
} from '../src/timers/record.js'

const TURN = asTimerId('turn')
const CLOCK = asTimerId('clock:white')
const WHITE = asSeatId('white')

function playerClock(overrides: Partial<PlayerClockConfig> = {}) {
  const config: PlayerClockConfig = { ...DEFAULT_PLAYER_CLOCK, initialMs: 300_000, ...overrides }
  return createTimerRecord({
    timerId: CLOCK,
    seatId: WHITE,
    kind: 'chess-clock',
    durationMs: config.initialMs,
    clock: config,
  })
}

describe('a plain one-shot timer', () => {
  it('counts down from its anchor and exposes an absolute deadline', () => {
    const record = createTimerRecord({
      timerId: TURN,
      seatId: null,
      kind: 'turn',
      durationMs: 30_000,
      startedAtMs: 1_000,
    })
    expect(isRunning(record)).toBe(true)
    expect(deadlineMsAt(record)).toBe(31_000)
    expect(remainingMsAt(record, 1_000)).toBe(30_000)
    expect(remainingMsAt(record, 11_000)).toBe(20_000)
    expect(remainingMsAt(record, 31_000)).toBe(0)
  })

  it('clamps at zero rather than going negative', () => {
    const record = createTimerRecord({
      timerId: TURN,
      seatId: null,
      kind: 'turn',
      durationMs: 5,
      startedAtMs: 0,
    })
    expect(remainingMsAt(record, 10_000)).toBe(0)
  })

  it('treats a backwards clock step as zero elapsed, never as a refund', () => {
    const record = createTimerRecord({
      timerId: TURN,
      seatId: null,
      kind: 'turn',
      durationMs: 5_000,
      startedAtMs: 1_000,
    })
    expect(rawElapsedMs(record, 500)).toBe(0)
    expect(remainingMsAt(record, 500)).toBe(5_000)
  })

  it('is stopped until started, and has no deadline while stopped', () => {
    const record = createTimerRecord({
      timerId: TURN,
      seatId: null,
      kind: 'turn',
      durationMs: 5_000,
    })
    expect(isRunning(record)).toBe(false)
    expect(deadlineMsAt(record)).toBeNull()
    expect(remainingMsAt(record, 99_999)).toBe(5_000)

    const started = startRecord(record, 2_000)
    expect(deadlineMsAt(started)).toBe(7_000)
    expect(started.version).toBe(record.version + 1)
  })

  it('ignores a second start, so a duplicated message cannot reset the clock', () => {
    const record = startRecord(
      createTimerRecord({ timerId: TURN, seatId: null, kind: 'turn', durationMs: 5_000 }),
      1_000,
    )
    expect(startRecord(record, 4_000)).toBe(record)
  })
})

describe('pause and resume', () => {
  it('commits the time spent and stops the deadline moving', () => {
    const running = createTimerRecord({
      timerId: TURN,
      seatId: null,
      kind: 'turn',
      durationMs: 30_000,
      startedAtMs: 0,
    })
    const paused = pauseRecord(running, 12_000)

    expect(paused.remainingMs).toBe(18_000)
    expect(isRunning(paused)).toBe(false)
    expect(deadlineMsAt(paused)).toBeNull()
    // A year later it still holds 18 s.
    expect(remainingMsAt(paused, 31_536_000_000)).toBe(18_000)
  })

  it('is idempotent, so a repeated disconnect cannot double-charge', () => {
    const paused = pauseRecord(
      createTimerRecord({
        timerId: TURN,
        seatId: null,
        kind: 'turn',
        durationMs: 30_000,
        startedAtMs: 0,
      }),
      12_000,
    )
    expect(pauseRecord(paused, 20_000)).toBe(paused)
  })

  it('round-trips a pause/resume pair without losing or gaining time', () => {
    let record = createTimerRecord({
      timerId: TURN,
      seatId: null,
      kind: 'turn',
      durationMs: 30_000,
      startedAtMs: 0,
    })
    record = pauseRecord(record, 10_000)
    record = resumeRecord(record, 45_000) // 35 s of downtime, not charged
    expect(remainingMsAt(record, 50_000)).toBe(15_000)
    expect(deadlineMsAt(record)).toBe(65_000)
  })
})

describe('expiry', () => {
  it('zeroes the budget and stops the clock', () => {
    const record = expireRecord(
      createTimerRecord({
        timerId: TURN,
        seatId: null,
        kind: 'turn',
        durationMs: 30_000,
        startedAtMs: 0,
      }),
    )
    expect(record.expired).toBe(true)
    expect(remainingMsAt(record, 0)).toBe(0)
    expect(deadlineMsAt(record)).toBeNull()
    expect(isRunning(record)).toBe(false)
  })

  it('is terminal — expiring twice changes nothing', () => {
    const once = expireRecord(
      createTimerRecord({
        timerId: TURN,
        seatId: null,
        kind: 'turn',
        durationMs: 1,
        startedAtMs: 0,
      }),
    )
    expect(expireRecord(once)).toBe(once)
  })
})

describe('Fischer increment', () => {
  it('credits the increment only when a turn completes', () => {
    let record = playerClock({ initialMs: 60_000, incrementMs: 5_000 })
    record = startRecord(record, 0)
    expect(remainingMsAt(record, 10_000)).toBe(50_000)

    record = endTurnRecord(record, 10_000)
    expect(record.remainingMs).toBe(55_000) // 50 s used-down + 5 s increment
    expect(isRunning(record)).toBe(false)
  })

  it('does not credit a player who flagged, per FIDE ordering', () => {
    let record = playerClock({ initialMs: 1_000, incrementMs: 5_000 })
    record = startRecord(record, 0)
    record = endTurnRecord(record, 9_000) // ran out 8 s ago
    expect(record.remainingMs).toBe(0)
  })

  it('honours a ceiling on accumulated time', () => {
    let record = playerClock({ initialMs: 60_000, incrementMs: 30_000, maxMs: 65_000 })
    record = startRecord(record, 0)
    record = endTurnRecord(record, 1_000)
    expect(record.remainingMs).toBe(65_000) // 59 s + 30 s, capped
  })
})

describe('simple (US) delay', () => {
  const config = { initialMs: 60_000, delayMs: 3_000, delayMode: 'simple' as const }

  it('spends the delay before it touches the budget', () => {
    const record = startRecord(playerClock(config), 0)

    expect(remainingMsAt(record, 0)).toBe(60_000)
    expect(remainingMsAt(record, 1_500)).toBe(60_000) // still inside the delay
    expect(delayRemainingMsAt(record, 1_500)).toBe(1_500)
    expect(remainingMsAt(record, 3_000)).toBe(60_000)
    expect(remainingMsAt(record, 5_000)).toBe(58_000) // 2 s past the delay
    expect(delayRemainingMsAt(record, 5_000)).toBe(0)
  })

  it('pushes the deadline out by the unspent delay', () => {
    const record = startRecord(playerClock(config), 0)
    expect(deadlineMsAt(record)).toBe(63_000)
  })

  it('gives a fresh delay on the next turn', () => {
    let record = startRecord(playerClock(config), 0)
    record = endTurnRecord(record, 5_000) // 3 s free + 2 s charged
    expect(record.remainingMs).toBe(58_000)
    expect(record.delayRemainingMs).toBe(3_000)

    record = startRecord(record, 10_000)
    expect(remainingMsAt(record, 12_000)).toBe(58_000)
  })

  it('carries the unspent delay through a pause', () => {
    let record = startRecord(playerClock(config), 0)
    record = pauseRecord(record, 1_000) // 1 s of the 3 s delay used
    expect(record.delayRemainingMs).toBe(2_000)
    expect(record.remainingMs).toBe(60_000)

    record = resumeRecord(record, 100_000)
    expect(remainingMsAt(record, 101_000)).toBe(60_000) // last 1 s of the delay
    expect(remainingMsAt(record, 104_000)).toBe(58_000)
  })

  it('charges the whole turn once the delay is exhausted', () => {
    const record = startRecord(playerClock(config), 0)
    expect(chargeableElapsedMs(record, 10_000)).toBe(7_000)
  })
})

describe('Bronstein delay', () => {
  const config = { initialMs: 60_000, delayMs: 3_000, delayMode: 'bronstein' as const }

  it('counts down immediately, unlike simple delay', () => {
    const record = startRecord(playerClock(config), 0)
    expect(remainingMsAt(record, 1_000)).toBe(59_000)
    expect(delayRemainingMsAt(record, 1_000)).toBe(0)
    expect(deadlineMsAt(record)).toBe(60_000)
  })

  it('refunds the time used, up to the delay, at the end of the turn', () => {
    let record = startRecord(playerClock(config), 0)
    record = endTurnRecord(record, 1_200) // used 1.2 s, all refundable
    expect(record.remainingMs).toBe(60_000)
  })

  it('refunds only the delay when the turn ran longer', () => {
    let record = startRecord(playerClock(config), 0)
    record = endTurnRecord(record, 10_000) // used 10 s, 3 s back
    expect(record.remainingMs).toBe(53_000)
  })

  it('counts time across a mid-turn pause towards the refund', () => {
    let record = startRecord(playerClock(config), 0)
    record = pauseRecord(record, 1_000)
    record = resumeRecord(record, 50_000)
    record = endTurnRecord(record, 51_000) // 2 s of real thinking, split
    expect(record.remainingMs).toBe(60_000)
  })

  it('stacks with an increment when a time control uses both', () => {
    let record = startRecord(playerClock({ ...config, incrementMs: 2_000 }), 0)
    record = endTurnRecord(record, 10_000)
    expect(record.remainingMs).toBe(55_000) // 50 + 3 refund + 2 increment
  })
})

describe('endTurnRecord on a timer that is not a player clock', () => {
  it('is just a pause — there is nothing to credit', () => {
    const record = createTimerRecord({
      timerId: TURN,
      seatId: null,
      kind: 'turn',
      durationMs: 30_000,
      startedAtMs: 0,
    })
    expect(endTurnRecord(record, 10_000).remainingMs).toBe(20_000)
  })
})

describe('resetRecord', () => {
  it('re-arms an expired timer with a fresh budget and delay', () => {
    const expired = expireRecord(
      startRecord(playerClock({ initialMs: 1_000, delayMs: 3_000, delayMode: 'simple' }), 0),
    )
    const reset = resetRecord(expired, 45_000, 10_000)

    expect(reset.expired).toBe(false)
    expect(reset.remainingMs).toBe(45_000)
    expect(reset.delayRemainingMs).toBe(3_000)
    expect(reset.turnElapsedMs).toBe(0)
    expect(deadlineMsAt(reset)).toBe(58_000)
  })

  it('refuses to store a negative budget', () => {
    const reset = resetRecord(playerClock(), -5, null)
    expect(reset.remainingMs).toBe(0)
  })
})
