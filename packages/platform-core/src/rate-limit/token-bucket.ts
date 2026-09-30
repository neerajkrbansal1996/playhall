/**
 * Token-bucket rate limiting.
 *
 * Rate limit before trust: create, join, chat and action paths all need a
 * limit, and none of them may believe a client about who it is. Keys are
 * built by the caller from a *server-derived* identity — the guest id off the
 * signed token, or the connecting IP — never from a request body.
 *
 * A bucket is chosen over a fixed window because a fixed window lets a caller
 * spend the whole quota in the last instant of one window and again in the
 * first instant of the next. A bucket also gives a meaningful `retryAfterMs`,
 * which is what the client needs in order to back off politely instead of
 * hammering.
 *
 * This implementation is in-memory and single-instance. The interface is the
 * point: the Redis-backed version behind the same `RateLimiter` type keeps the
 * limit correct across a horizontally scaled fleet.
 */

import type { Clock } from '../runtime.js'

export interface TokenBucketPolicy {
  /** Burst size. The most a caller may spend with a full bucket. */
  readonly capacity: number
  /** Tokens added per `refillIntervalMs`. Sustained rate = this / interval. */
  readonly refillTokens: number
  readonly refillIntervalMs: number
}

export interface RateLimitDecision {
  readonly allowed: boolean
  /** Whole tokens left after this call. */
  readonly remaining: number
  /** 0 when allowed; otherwise how long until the requested cost is affordable. */
  readonly retryAfterMs: number
}

export interface RateLimiter {
  /** Spends `cost` tokens for `key` if they are available. */
  consume(key: string, cost?: number): RateLimitDecision
  /** Reads the bucket without spending. Used by the failed-join guard. */
  peek(key: string): RateLimitDecision
  /** Clears one key, e.g. after a successful join resets an IP's failure budget. */
  reset(key: string): void
  /**
   * Drops buckets that have refilled to capacity. Every keyed structure in
   * this package has a bounded lifetime; an unbounded map is the same bug as
   * an unbounded Redis key.
   */
  prune(): number
  /** Live bucket count. Exposed so the sweeper can emit it as a gauge. */
  readonly size: number
}

interface Bucket {
  tokens: number
  updatedAt: number
}

export function createTokenBucketLimiter(policy: TokenBucketPolicy, clock: Clock): RateLimiter {
  if (policy.capacity <= 0) throw new RangeError('capacity must be > 0')
  if (policy.refillTokens <= 0) throw new RangeError('refillTokens must be > 0')
  if (policy.refillIntervalMs <= 0) throw new RangeError('refillIntervalMs must be > 0')

  const buckets = new Map<string, Bucket>()
  const tokensPerMs = policy.refillTokens / policy.refillIntervalMs

  function current(key: string, now: number): Bucket {
    const existing = buckets.get(key)
    if (!existing) {
      const fresh: Bucket = { tokens: policy.capacity, updatedAt: now }
      buckets.set(key, fresh)
      return fresh
    }
    const elapsed = Math.max(0, now - existing.updatedAt)
    existing.tokens = Math.min(policy.capacity, existing.tokens + elapsed * tokensPerMs)
    existing.updatedAt = now
    return existing
  }

  function decide(bucket: Bucket, cost: number, allowed: boolean): RateLimitDecision {
    if (allowed) {
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 }
    }
    const deficit = cost - bucket.tokens
    return {
      allowed: false,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs: Math.ceil(deficit / tokensPerMs),
    }
  }

  return {
    consume(key: string, cost = 1): RateLimitDecision {
      if (cost <= 0) throw new RangeError('cost must be > 0')
      if (cost > policy.capacity) {
        throw new RangeError(`cost ${cost} can never be satisfied by capacity ${policy.capacity}`)
      }
      const now = clock.now()
      const bucket = current(key, now)
      if (bucket.tokens < cost) return decide(bucket, cost, false)
      bucket.tokens -= cost
      return decide(bucket, cost, true)
    },

    peek(key: string): RateLimitDecision {
      const bucket = current(key, clock.now())
      return decide(bucket, 1, bucket.tokens >= 1)
    },

    reset(key: string): void {
      buckets.delete(key)
    },

    prune(): number {
      const now = clock.now()
      let removed = 0
      for (const [key, bucket] of buckets) {
        const elapsed = Math.max(0, now - bucket.updatedAt)
        if (bucket.tokens + elapsed * tokensPerMs >= policy.capacity) {
          buckets.delete(key)
          removed += 1
        }
      }
      return removed
    },

    get size(): number {
      return buckets.size
    },
  }
}
