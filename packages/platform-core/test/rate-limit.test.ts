import { describe, expect, it } from 'vitest'
import { createTokenBucketLimiter } from '../src/rate-limit/token-bucket.js'
import { createFailedJoinGuard } from '../src/rate-limit/failed-join-guard.js'
import { DEFAULT_RATE_LIMITS, rateLimitKey } from '../src/rate-limit/policies.js'
import { fixedClock } from '../src/runtime.js'
import { T0 } from './fixtures/rooms.js'

const POLICY = { capacity: 3, refillTokens: 3, refillIntervalMs: 3000 }

describe('token bucket', () => {
  it('allows up to the burst, then refuses with a usable retry-after', () => {
    const clock = fixedClock(T0)
    const limiter = createTokenBucketLimiter(POLICY, clock)

    expect(limiter.consume('a')).toMatchObject({ allowed: true, remaining: 2 })
    expect(limiter.consume('a')).toMatchObject({ allowed: true, remaining: 1 })
    expect(limiter.consume('a')).toMatchObject({ allowed: true, remaining: 0 })

    const refused = limiter.consume('a')
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterMs).toBe(1000)

    clock.advance(refused.retryAfterMs)
    expect(limiter.consume('a').allowed).toBe(true)
  })

  it('keys are independent', () => {
    const limiter = createTokenBucketLimiter(POLICY, fixedClock(T0))
    for (let index = 0; index < 3; index += 1) limiter.consume('a')
    expect(limiter.consume('a').allowed).toBe(false)
    expect(limiter.consume('b').allowed).toBe(true)
  })

  it('refills continuously rather than in window steps', () => {
    const clock = fixedClock(T0)
    const limiter = createTokenBucketLimiter(POLICY, clock)
    for (let index = 0; index < 3; index += 1) limiter.consume('a')

    clock.advance(500)
    expect(limiter.consume('a').allowed).toBe(false)
    clock.advance(500)
    expect(limiter.consume('a').allowed).toBe(true)
  })

  it('never refills above capacity', () => {
    const clock = fixedClock(T0)
    const limiter = createTokenBucketLimiter(POLICY, clock)
    limiter.consume('a')
    clock.advance(1_000_000)
    expect(limiter.peek('a').remaining).toBe(3)
  })

  it('peek reports without spending', () => {
    const limiter = createTokenBucketLimiter(POLICY, fixedClock(T0))
    expect(limiter.peek('a').remaining).toBe(3)
    expect(limiter.peek('a').remaining).toBe(3)
    expect(limiter.consume('a').remaining).toBe(2)
  })

  it('reset clears one key', () => {
    const limiter = createTokenBucketLimiter(POLICY, fixedClock(T0))
    for (let index = 0; index < 3; index += 1) limiter.consume('a')
    expect(limiter.consume('a').allowed).toBe(false)
    limiter.reset('a')
    expect(limiter.consume('a').allowed).toBe(true)
  })

  it('prunes refilled buckets so the map cannot grow without bound', () => {
    const clock = fixedClock(T0)
    const limiter = createTokenBucketLimiter(POLICY, clock)
    for (let index = 0; index < 100; index += 1) limiter.consume(`key-${index}`)
    expect(limiter.size).toBe(100)

    expect(limiter.prune()).toBe(0)
    clock.advance(POLICY.refillIntervalMs)
    expect(limiter.prune()).toBe(100)
    expect(limiter.size).toBe(0)
  })

  it('rejects an impossible configuration up front', () => {
    const clock = fixedClock(T0)
    expect(() => createTokenBucketLimiter({ ...POLICY, capacity: 0 }, clock)).toThrow(RangeError)
    expect(() => createTokenBucketLimiter({ ...POLICY, refillTokens: 0 }, clock)).toThrow(
      RangeError,
    )
    expect(() => createTokenBucketLimiter({ ...POLICY, refillIntervalMs: 0 }, clock)).toThrow(
      RangeError,
    )
    const limiter = createTokenBucketLimiter(POLICY, clock)
    expect(() => limiter.consume('a', 0)).toThrow(RangeError)
    expect(() => limiter.consume('a', 99)).toThrow(RangeError)
  })
})

describe('per-IP failed-join cap', () => {
  const policy = DEFAULT_RATE_LIMITS.failedCodeJoinPerIp

  it('is keyed per IP, not per guest', () => {
    expect(rateLimitKey.failedCodeJoin('203.0.113.7')).toBe('rl:room:join:fail:203.0.113.7')
  })

  it('allows the stated number of failures, then blocks', () => {
    const clock = fixedClock(T0)
    const guard = createFailedJoinGuard(clock, policy)

    for (let attempt = 0; attempt < policy.capacity; attempt += 1) {
      expect(guard.allow('ip')).toBe(true)
      guard.recordFailure('ip')
    }
    expect(guard.allow('ip')).toBe(false)
    expect(guard.retryAfterMs('ip')).toBe(policy.refillIntervalMs / policy.refillTokens)
  })

  it('unblocks after the cooldown', () => {
    const clock = fixedClock(T0)
    const guard = createFailedJoinGuard(clock, policy)
    for (let attempt = 0; attempt < policy.capacity; attempt += 1) guard.recordFailure('ip')

    expect(guard.allow('ip')).toBe(false)
    clock.advance(guard.retryAfterMs('ip'))
    expect(guard.allow('ip')).toBe(true)
  })

  it('does not punish other IPs behind a different NAT', () => {
    const guard = createFailedJoinGuard(fixedClock(T0), policy)
    for (let attempt = 0; attempt < policy.capacity; attempt += 1) guard.recordFailure('ip-a')
    expect(guard.allow('ip-a')).toBe(false)
    expect(guard.allow('ip-b')).toBe(true)
  })

  it('refunds the whole budget on a successful join', () => {
    // Several friends behind one NAT mistyping once each must never add up to
    // a block, because each of them eventually succeeds.
    const guard = createFailedJoinGuard(fixedClock(T0), policy)
    for (let round = 0; round < 50; round += 1) {
      guard.recordFailure('shared-nat')
      guard.recordSuccess('shared-nat')
      expect(guard.allow('shared-nat')).toBe(true)
    }
  })

  it('reports the remaining budget as it is spent', () => {
    const guard = createFailedJoinGuard(fixedClock(T0), policy)
    expect(guard.recordFailure('ip')).toBe(policy.capacity - 1)
    expect(guard.recordFailure('ip')).toBe(policy.capacity - 2)
  })

  it('prunes recovered IPs', () => {
    const clock = fixedClock(T0)
    const guard = createFailedJoinGuard(clock, policy)
    guard.recordFailure('ip')
    expect(guard.size).toBe(1)
    clock.advance(policy.refillIntervalMs)
    expect(guard.prune()).toBe(1)
    expect(guard.size).toBe(0)
  })
})

describe('the default policies', () => {
  it('are the reviewed numbers', () => {
    expect(DEFAULT_RATE_LIMITS.roomCreate).toEqual({
      capacity: 5,
      refillTokens: 5,
      refillIntervalMs: 600_000,
    })
    expect(DEFAULT_RATE_LIMITS.roomJoin).toEqual({
      capacity: 20,
      refillTokens: 20,
      refillIntervalMs: 60_000,
    })
    expect(DEFAULT_RATE_LIMITS.failedCodeJoinPerIp).toEqual({
      capacity: 10,
      refillTokens: 10,
      refillIntervalMs: 600_000,
    })
  })

  it('namespaces every limiter key', () => {
    expect(rateLimitKey.roomCreate('g1')).toBe('rl:room:create:g1')
    expect(rateLimitKey.roomJoin('g1')).toBe('rl:room:join:g1')
  })
})
