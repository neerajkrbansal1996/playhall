/**
 * One guest, one live session — newest wins.
 *
 * A guest id lives in a cookie, so it is shared by every tab in the browser.
 * Two tabs on the same lobby would both hold the same seat, both send actions
 * and both receive deltas, and the player would watch two boards disagree.
 * So each browsing context gets a `sessionId` at connect time and the platform
 * keeps exactly one current session per guest; the loser is told, explicitly,
 * rather than silently ignored — a tab that goes quiet with no explanation is
 * indistinguishable from a bug in the netcode.
 *
 * Two design notes:
 *
 * - **Recency is decided by `issuedAt`, not by arrival order.** Messages from
 *   two tabs race, and across instances they race harder. If an older session
 *   arrives late it is the *arrival* that gets superseded, so a stale
 *   reconnect cannot demote the tab the player is actually looking at.
 * - **The registry is an immutable value, not a mutable service.** It is a
 *   reducer over session events, which is what lets the room runner rebuild it
 *   from the match log after a restart and lets the tests drive it directly.
 *
 * Live state ships to Redis under the room's key (PER-12/PER-15 own that); this
 * module stays pure so it can be replayed.
 */

/** Sent to the tab that lost. The transport maps it to an `error` frame. */
export const SESSION_SUPERSEDED_CODE = 'session_superseded'

export interface GuestSession {
  readonly guestId: string
  /** Unique per browsing context. Minted at connect, carried in the token. */
  readonly sessionId: string
  /** Server-authoritative ms since epoch. Never a client-supplied clock. */
  readonly issuedAt: number
  /**
   * Transport handle for the socket, so the runner can address the superseded
   * tab. Opaque here: platform-core does not know what a connection is.
   */
  readonly connectionId?: string
}

/** Immutable map of guest id -> current session. */
export type GuestSessionRegistry = ReadonlyMap<string, GuestSession>

export const EMPTY_SESSION_REGISTRY: GuestSessionRegistry = new Map()

export interface ClaimSessionResult {
  readonly registry: GuestSessionRegistry
  /** True when `session` is now the current one for its guest. */
  readonly accepted: boolean
  /**
   * The session that must be told it lost — the previous holder when the claim
   * was accepted, or `session` itself when it arrived stale. `undefined` when
   * nothing was displaced.
   */
  readonly superseded?: GuestSession
}

/**
 * Registers a session as the current one for its guest.
 *
 * Re-claiming with the same `sessionId` is idempotent: the entry is refreshed
 * (a reconnect brings a new `connectionId`) and nothing is superseded. That
 * matters because every client message can arrive twice.
 */
export function claimSession(
  registry: GuestSessionRegistry,
  session: GuestSession,
): ClaimSessionResult {
  const current = registry.get(session.guestId)

  if (current !== undefined && current.sessionId === session.sessionId) {
    const next = new Map(registry)
    next.set(session.guestId, { ...current, ...session })
    return { registry: next, accepted: true }
  }

  if (current !== undefined && session.issuedAt < current.issuedAt) {
    // Arrived out of order and is genuinely older. Reject it, and tell it.
    return { registry, accepted: false, superseded: session }
  }

  const next = new Map(registry)
  next.set(session.guestId, session)
  return { registry: next, accepted: true, superseded: current }
}

/**
 * Drops a session on disconnect. A no-op unless `sessionId` is the current
 * one, so a superseded tab closing later cannot evict the live tab.
 */
export function releaseSession(
  registry: GuestSessionRegistry,
  guestId: string,
  sessionId: string,
): GuestSessionRegistry {
  const current = registry.get(guestId)
  if (current === undefined || current.sessionId !== sessionId) return registry
  const next = new Map(registry)
  next.delete(guestId)
  return next
}

export function currentSession(
  registry: GuestSessionRegistry,
  guestId: string,
): GuestSession | undefined {
  return registry.get(guestId)
}

/**
 * The authorisation check every action path owes: a message from a superseded
 * tab must be rejected, not applied.
 */
export function isCurrentSession(
  registry: GuestSessionRegistry,
  guestId: string,
  sessionId: string,
): boolean {
  return registry.get(guestId)?.sessionId === sessionId
}
