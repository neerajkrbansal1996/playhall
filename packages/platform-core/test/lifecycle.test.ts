import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROOM_LIFECYCLE,
  evaluateRoomLifecycle,
  nextRoomDeadline,
  roomDeadlines,
  roomKeyTtlMs,
} from '../src/rooms/lifecycle.js'
import { T0, makeRoom } from './fixtures/rooms.js'

const MINUTE = 60_000
const { noOpponentMs, emptyMs, finishedMs, ttlGraceMs } = DEFAULT_ROOM_LIFECYCLE

describe('the stated windows', () => {
  it('matches the product requirement exactly', () => {
    expect(noOpponentMs).toBe(30 * MINUTE)
    expect(emptyMs).toBe(5 * MINUTE)
    expect(finishedMs).toBe(15 * MINUTE)
  })
})

describe('no second player -> expire after 30 min', () => {
  const room = makeRoom({ presentPlayerIds: ['host'] })

  it('keeps the room one millisecond before the deadline', () => {
    const verdict = evaluateRoomLifecycle(room, T0 + noOpponentMs - 1)
    expect(verdict.action).toBe('keep')
    expect(verdict.deadlineAt).toBe(T0 + noOpponentMs)
  })

  it('expires exactly at the deadline', () => {
    const verdict = evaluateRoomLifecycle(room, T0 + noOpponentMs)
    expect(verdict).toMatchObject({ action: 'expire', reason: 'no_opponent' })
  })

  it('does not expire once a second player has joined', () => {
    const joined = makeRoom({
      seats: ['host', 'guest'],
      secondPlayerJoinedAt: T0 + MINUTE,
    })
    expect(evaluateRoomLifecycle(joined, T0 + 10 * 60 * MINUTE).action).toBe('keep')
  })

  it('does not apply once the match is running, even with one seat filled', () => {
    const playing = makeRoom({ status: 'in_progress', presentPlayerIds: ['host'] })
    expect(evaluateRoomLifecycle(playing, T0 + noOpponentMs + MINUTE).action).toBe('keep')
  })
})

describe('empty -> close after 5 min', () => {
  const emptied = makeRoom({
    seats: ['host', 'guest'],
    secondPlayerJoinedAt: T0,
    presentPlayerIds: [],
    emptySince: T0 + MINUTE,
  })

  it('keeps the room inside the grace window', () => {
    expect(evaluateRoomLifecycle(emptied, T0 + MINUTE + emptyMs - 1).action).toBe('keep')
  })

  it('closes at the deadline', () => {
    const verdict = evaluateRoomLifecycle(emptied, T0 + MINUTE + emptyMs)
    expect(verdict).toMatchObject({ action: 'close', reason: 'empty' })
  })

  it('wins over the 30-minute no-opponent timer when both are armed', () => {
    // A host who opened a lobby and immediately closed the tab is both
    // "never got an opponent" and "empty". Five minutes is the right answer.
    const soloAndGone = makeRoom({ presentPlayerIds: [], emptySince: T0 })
    const deadlines = roomDeadlines(soloAndGone)
    expect(deadlines.map((d) => d.reason)).toEqual(['empty', 'no_opponent'])
    expect(evaluateRoomLifecycle(soloAndGone, T0 + emptyMs)).toMatchObject({
      action: 'close',
      reason: 'empty',
    })
  })
})

describe('finished -> stay open 15 min for rematch and chat', () => {
  const finished = makeRoom({
    status: 'finished',
    seats: ['host', 'guest'],
    secondPlayerJoinedAt: T0,
    finishedAt: T0 + 5 * MINUTE,
  })

  it('stays open for the whole rematch window', () => {
    expect(evaluateRoomLifecycle(finished, T0 + 5 * MINUTE + finishedMs - 1).action).toBe('keep')
  })

  it('closes when the rematch window elapses', () => {
    expect(evaluateRoomLifecycle(finished, T0 + 5 * MINUTE + finishedMs)).toMatchObject({
      action: 'close',
      reason: 'rematch_window_elapsed',
    })
  })

  it('still closes after 5 empty minutes if everyone leaves first', () => {
    const abandoned = { ...finished, presentPlayerIds: [], emptySince: T0 + 6 * MINUTE }
    expect(evaluateRoomLifecycle(abandoned, T0 + 11 * MINUTE)).toMatchObject({
      action: 'close',
      reason: 'empty',
    })
  })
})

describe('already closed', () => {
  it('arms nothing', () => {
    const closed = { ...makeRoom(), status: 'closed' as const }
    expect(roomDeadlines(closed)).toEqual([])
    expect(nextRoomDeadline(closed)).toBeNull()
    expect(evaluateRoomLifecycle(closed, T0 + 10 * noOpponentMs)).toMatchObject({
      action: 'keep',
      deadlineAt: null,
    })
  })
})

describe('TTL hygiene', () => {
  it('gives every room a TTL, including one with no armed deadline', () => {
    const playing = makeRoom({
      status: 'in_progress',
      seats: ['host', 'guest'],
      secondPlayerJoinedAt: T0,
    })
    expect(nextRoomDeadline(playing)).toBeNull()
    expect(roomKeyTtlMs(playing, T0)).toBe(noOpponentMs + ttlGraceMs)
  })

  it('outlives the deadline by the grace window so the sweeper can observe it', () => {
    const room = makeRoom({ presentPlayerIds: ['host'] })
    expect(roomKeyTtlMs(room, T0)).toBe(noOpponentMs + ttlGraceMs)
    expect(roomKeyTtlMs(room, T0 + noOpponentMs - MINUTE)).toBe(MINUTE + ttlGraceMs)
  })

  it('never returns a non-positive TTL for an overdue room', () => {
    const room = makeRoom({ presentPlayerIds: ['host'] })
    expect(roomKeyTtlMs(room, T0 + noOpponentMs + 10 * MINUTE)).toBe(ttlGraceMs)
  })
})

describe('custom policy', () => {
  it('is honoured end to end', () => {
    const policy = { noOpponentMs: 1000, emptyMs: 500, finishedMs: 2000, ttlGraceMs: 10 }
    const room = makeRoom({ presentPlayerIds: ['host'] })
    expect(evaluateRoomLifecycle(room, T0 + 999, policy).action).toBe('keep')
    expect(evaluateRoomLifecycle(room, T0 + 1000, policy).action).toBe('expire')
    expect(roomKeyTtlMs(room, T0, policy)).toBe(1010)
  })
})
