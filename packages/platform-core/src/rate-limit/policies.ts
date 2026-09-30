/**
 * The limits themselves, in one place so they are reviewable as a set.
 *
 * Numbers are chosen against the product shape — "landing page to playable
 * lobby in two taps", most players on a phone over mobile data, several
 * friends often behind one NAT — not against an abstract idea of abuse. Each
 * one states what it is defending.
 */

import type { TokenBucketPolicy } from './token-bucket.js'

export interface RateLimitPolicies {
  /**
   * Room creation, per guest. Defends the code space and the room-count
   * budget (2,000 concurrent rooms per instance). A person opening a lobby,
   * mistyping the settings and reopening it twice is normal; 20 in a burst is
   * not.
   */
  readonly roomCreate: TokenBucketPolicy
  /**
   * Joins, per guest. Generous, because reconnection on mobile data is a
   * *join* and a train tunnel produces a legitimate burst of them.
   */
  readonly roomJoin: TokenBucketPolicy
  /**
   * Failed room-code joins, per IP. This is the enumeration defence: the code
   * space is 887,503,681, so guessing is only interesting at high rates.
   * Ten failures per ten minutes is far above the two or three a person makes
   * typing a code off a phone screen, and far below anything that could walk
   * the space. Keyed per IP rather than per guest because a guest identity is
   * free to mint; successful joins clear the budget so a shared NAT with
   * genuinely arriving friends is never punished.
   */
  readonly failedCodeJoinPerIp: TokenBucketPolicy
}

export const DEFAULT_RATE_LIMITS: RateLimitPolicies = Object.freeze({
  roomCreate: Object.freeze({ capacity: 5, refillTokens: 5, refillIntervalMs: 10 * 60_000 }),
  roomJoin: Object.freeze({ capacity: 20, refillTokens: 20, refillIntervalMs: 60_000 }),
  failedCodeJoinPerIp: Object.freeze({
    capacity: 10,
    refillTokens: 10,
    refillIntervalMs: 10 * 60_000,
  }),
})

/** Namespaced so one Redis keyspace can hold every limiter without collision. */
export const rateLimitKey = {
  roomCreate: (guestId: string) => `rl:room:create:${guestId}`,
  roomJoin: (guestId: string) => `rl:room:join:${guestId}`,
  failedCodeJoin: (ip: string) => `rl:room:join:fail:${ip}`,
} as const
