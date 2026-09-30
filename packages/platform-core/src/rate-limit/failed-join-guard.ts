/**
 * The per-IP cap on failed room-code joins.
 *
 * Separate from the ordinary join limiter because its accounting is inverted:
 * **only failures cost anything, and a success refunds the whole budget.**
 * That asymmetry is what lets the cap sit low enough to matter without ever
 * touching a real group of friends arriving through one NAT — they succeed,
 * so they never spend.
 *
 * The guard is checked *before* the room lookup, so an exhausted IP learns
 * nothing about whether the code it guessed exists. Leaking that would hand
 * an enumerator the oracle the cap is there to deny.
 */

import type { Clock } from '../runtime.js'
import { DEFAULT_RATE_LIMITS, rateLimitKey } from './policies.js'
import {
  type RateLimiter,
  type TokenBucketPolicy,
  createTokenBucketLimiter,
} from './token-bucket.js'

export interface FailedJoinGuard {
  /** True when this IP may attempt another code. */
  allow(ip: string): boolean
  /** Milliseconds until a blocked IP may try again. 0 when allowed. */
  retryAfterMs(ip: string): number
  /** Charge one failed attempt. Returns the remaining budget. */
  recordFailure(ip: string): number
  /** A genuine join clears the IP's failure budget. */
  recordSuccess(ip: string): void
  /** Drops fully refilled entries. Called by the sweeper. */
  prune(): number
  readonly size: number
}

export function createFailedJoinGuard(
  clock: Clock,
  policy: TokenBucketPolicy = DEFAULT_RATE_LIMITS.failedCodeJoinPerIp,
  limiter: RateLimiter = createTokenBucketLimiter(policy, clock),
): FailedJoinGuard {
  return {
    allow(ip: string): boolean {
      return limiter.peek(rateLimitKey.failedCodeJoin(ip)).allowed
    },
    retryAfterMs(ip: string): number {
      return limiter.peek(rateLimitKey.failedCodeJoin(ip)).retryAfterMs
    },
    recordFailure(ip: string): number {
      return limiter.consume(rateLimitKey.failedCodeJoin(ip)).remaining
    },
    recordSuccess(ip: string): void {
      limiter.reset(rateLimitKey.failedCodeJoin(ip))
    },
    prune(): number {
      return limiter.prune()
    },
    get size(): number {
      return limiter.size
    },
  }
}
