import { describe, expect, it, vi } from 'vitest'
import {
  ALWAYS_LOGGED_EVENTS,
  createJsonLineSink,
  createLevelFilterSink,
  createLogger,
  createMemorySink,
  createMultiSink,
  createSampler,
  createServiceLogger,
  createReleaseIdentity,
  LOG_LEVEL_VALUES,
  nullSink,
  REDACTED,
  serializeLogRecord,
  withScope,
} from '../src/index'

const FIXED_TIME = Date.parse('2026-09-30T12:00:00.000Z')
const clock = () => FIXED_TIME

describe('createLogger', () => {
  it('emits a record with the injected clock and bound base fields', () => {
    const sink = createMemorySink()
    const log = createLogger({ sink, clock, base: { service: 'playhall-realtime' } })

    log.info('room created', { event: 'room.created', roomId: 'room_1' })

    expect(sink.records).toHaveLength(1)
    const record = sink.records[0]!
    expect(record.level).toBe('info')
    expect(record.levelValue).toBe(30)
    expect(record.time).toBe('2026-09-30T12:00:00.000Z')
    expect(record.msg).toBe('room created')
    expect(record.fields).toEqual({
      service: 'playhall-realtime',
      event: 'room.created',
      roomId: 'room_1',
    })
  })

  it('drops records below the configured level', () => {
    const sink = createMemorySink()
    const log = createLogger({ sink, clock, level: 'warn' })

    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    log.fatal('f')

    expect(sink.records.map((r) => r.level)).toEqual(['warn', 'error', 'fatal'])
    expect(log.isLevelEnabled('info')).toBe(false)
    expect(log.isLevelEnabled('error')).toBe(true)
    expect(log.level).toBe('warn')
  })

  it('child() accumulates fields without mutating the parent', () => {
    const sink = createMemorySink()
    const root = createLogger({ sink, clock, base: { service: 'playhall-realtime' } })
    const room = root.child({ roomId: 'room_1' })
    const seat = room.child({ seat: 2 })

    seat.info('seated')
    root.info('unrelated')

    expect(sink.records[0]!.fields).toEqual({
      service: 'playhall-realtime',
      roomId: 'room_1',
      seat: 2,
    })
    expect(sink.records[1]!.fields).toEqual({ service: 'playhall-realtime' })
  })

  it('scrubs the message and the fields', () => {
    const sink = createMemorySink()
    const log = createLogger({ sink, clock })

    log.info('joining https://playhall.example/j/TCQ4MN', { roomCode: 'TCQ4MN', roomId: 'room_1' })

    const record = sink.records[0]!
    expect(record.msg).toBe(`joining https://playhall.example/j/${REDACTED}`)
    expect(record.fields).toEqual({ roomCode: REDACTED, roomId: 'room_1' })
  })

  it('honours extraRedactKeys', () => {
    const sink = createMemorySink()
    const log = createLogger({ sink, clock, extraRedactKeys: ['seatSecret'] })
    log.info('x', { seatSecret: 'abc' })
    expect(sink.records[0]!.fields).toEqual({ seatSecret: REDACTED })
  })
})

describe('sampling', () => {
  it('keeps one in N per event and never samples errors away', () => {
    const sink = createMemorySink()
    const log = createLogger({
      sink,
      clock,
      level: 'debug',
      sampler: createSampler({ always: ['room.created'], rate: 0.25 }),
    })

    for (let i = 0; i < 8; i += 1) log.debug('action', { event: 'game.action', i })
    for (let i = 0; i < 3; i += 1) log.info('created', { event: 'room.created' })
    log.error('boom', { event: 'game.action' })

    const actions = sink.records.filter((r) => r.fields['event'] === 'game.action')
    expect(actions.filter((r) => r.level === 'debug')).toHaveLength(2) // 8 * 0.25
    expect(actions.filter((r) => r.level === 'error')).toHaveLength(1) // never sampled
    expect(sink.records.filter((r) => r.fields['event'] === 'room.created')).toHaveLength(3)
  })

  it('rate >= 1 keeps everything and rate <= 0 keeps only errors', () => {
    const keepAll = createSampler({ rate: 1 })
    const dropAll = createSampler({ rate: 0, always: ['room.closed'] })
    const record = {
      level: 'info' as const,
      levelValue: LOG_LEVEL_VALUES.info,
      time: '2026-09-30T12:00:00.000Z',
      msg: 'x',
      fields: { event: 'game.action' },
    }
    expect(keepAll(record)).toBe(true)
    expect(dropAll(record)).toBe(false)
    expect(dropAll({ ...record, fields: { event: 'room.closed' } })).toBe(true)
  })

  it('counts unlabelled records as one bucket', () => {
    const sampler = createSampler({ rate: 0.5 })
    const base = {
      level: 'info' as const,
      levelValue: LOG_LEVEL_VALUES.info,
      time: '2026-09-30T12:00:00.000Z',
      msg: 'x',
      fields: {},
    }
    expect([sampler(base), sampler(base), sampler(base), sampler(base)]).toEqual([
      true,
      false,
      true,
      false,
    ])
  })
})

describe('sinks', () => {
  it('serialises newline-delimited JSON with pino-compatible levels', () => {
    const lines: string[] = []
    const log = createLogger({
      sink: createJsonLineSink({ write: (line) => lines.push(line) }),
      clock,
      base: { service: 'playhall-realtime' },
    })

    log.warn('slow redis op', { event: 'redis.slow', durationMs: 42 })

    expect(JSON.parse(lines[0]!)).toEqual({
      level: 40,
      levelName: 'warn',
      time: '2026-09-30T12:00:00.000Z',
      msg: 'slow redis op',
      service: 'playhall-realtime',
      event: 'redis.slow',
      durationMs: 42,
    })
  })

  it('defaults to console.log so it works on Node and on workerd', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      createLogger({ sink: createJsonLineSink(), clock }).info('hello')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(spy.mock.calls[0]?.[0])).msg).toBe('hello')
    } finally {
      spy.mockRestore()
    }
  })

  it('fans out, filters by level, and discards', () => {
    const all = createMemorySink()
    const errorsOnly = createMemorySink()
    const log = createLogger({
      sink: createMultiSink(all, createLevelFilterSink('error', errorsOnly), nullSink),
      clock,
    })

    log.info('fine')
    log.error('bad')

    expect(all.records).toHaveLength(2)
    expect(errorsOnly.records.map((r) => r.msg)).toEqual(['bad'])
    expect(all.lines()).toHaveLength(2)
    all.clear()
    expect(all.records).toHaveLength(0)
  })

  it('serializeLogRecord is reusable by a pino adapter', () => {
    const line = serializeLogRecord({
      level: 'info',
      levelValue: 30,
      time: '2026-09-30T12:00:00.000Z',
      msg: 'x',
      fields: { roomId: 'room_1' },
    })
    expect(JSON.parse(line)).toMatchObject({ level: 30, roomId: 'room_1' })
  })
})

describe('createServiceLogger / withScope', () => {
  const release = createReleaseIdentity({
    service: 'playhall-realtime',
    gitSha: 'a1b2c3d',
    environment: 'staging',
  })

  it('stamps service, release and environment on every line', () => {
    const sink = createMemorySink()
    const log = createServiceLogger({ release, sink, clock })
    log.info('server started', { event: 'server.started' })

    expect(sink.records[0]!.fields).toMatchObject({
      service: 'playhall-realtime',
      release: 'playhall-realtime@a1b2c3d',
      environment: 'staging',
    })
  })

  it('puts correlationId and roomId on every scoped line, and they are distinct', () => {
    const sink = createMemorySink()
    const scoped = withScope(createServiceLogger({ release, sink, clock }), {
      correlationId: 'abcdefghijklmnopqrstuvwxyz',
      roomId: 'room_1',
      guestId: 'g_1',
    })

    scoped.info('seat taken', { event: 'room.seat_changed' })
    scoped.child({ seat: 3 }).info('moved', { event: 'game.action' })

    for (const record of sink.records) {
      expect(record.fields['correlationId']).toBe('abcdefghijklmnopqrstuvwxyz')
      expect(record.fields['roomId']).toBe('room_1')
    }
    expect(sink.records[0]!.fields['correlationId']).not.toBe(sink.records[0]!.fields['roomId'])
    expect(sink.records[1]!.fields['seat']).toBe(3)
  })

  it('omits optional scope fields rather than writing undefined', () => {
    const sink = createMemorySink()
    withScope(createServiceLogger({ release, sink, clock }), {
      correlationId: 'abcdefghijklmnopqrstuvwxyz',
    }).info('landing')

    expect(Object.keys(sink.records[0]!.fields)).not.toContain('roomId')
  })

  it('samples the hot path but never a room lifecycle event', () => {
    const sink = createMemorySink()
    const log = createServiceLogger({ release, sink, clock, hotPathSampleRate: 0.25 })

    for (let i = 0; i < 8; i += 1) log.info('action', { event: 'game.action' })
    for (const event of ALWAYS_LOGGED_EVENTS) log.info('lifecycle', { event })

    expect(sink.records.filter((r) => r.fields['event'] === 'game.action')).toHaveLength(2)
    expect(sink.records.filter((r) => r.msg === 'lifecycle')).toHaveLength(
      ALWAYS_LOGGED_EVENTS.length,
    )
  })

  it('defaults to info in production and debug elsewhere', () => {
    const prod = createReleaseIdentity({ ...release, environment: 'production' })
    expect(createServiceLogger({ release: prod, sink: nullSink, clock }).level).toBe('info')
    expect(createServiceLogger({ release, sink: nullSink, clock }).level).toBe('debug')
  })
})
