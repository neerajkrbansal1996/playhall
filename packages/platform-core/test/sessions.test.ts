import { describe, expect, it } from 'vitest'
import {
  EMPTY_SESSION_REGISTRY,
  type GuestSession,
  SESSION_SUPERSEDED_CODE,
  claimSession,
  currentSession,
  isCurrentSession,
  releaseSession,
} from '../src/identity/sessions.js'

function session(sessionId: string, issuedAt: number, connectionId?: string): GuestSession {
  return { guestId: 'guest-abc', sessionId, issuedAt, connectionId }
}

describe('claimSession', () => {
  it('accepts the first session for a guest without superseding anything', () => {
    const result = claimSession(EMPTY_SESSION_REGISTRY, session('tab-1', 1000))
    expect(result.accepted).toBe(true)
    expect(result.superseded).toBeUndefined()
    expect(currentSession(result.registry, 'guest-abc')?.sessionId).toBe('tab-1')
  })

  it('newest wins, and hands back the old session so it can be told', () => {
    // The issue's requirement: the old tab is told, not silently ignored.
    const first = claimSession(EMPTY_SESSION_REGISTRY, session('tab-1', 1000, 'conn-1'))
    const second = claimSession(first.registry, session('tab-2', 2000, 'conn-2'))

    expect(second.accepted).toBe(true)
    expect(second.superseded?.sessionId).toBe('tab-1')
    expect(second.superseded?.connectionId).toBe('conn-1')
    expect(isCurrentSession(second.registry, 'guest-abc', 'tab-2')).toBe(true)
    expect(isCurrentSession(second.registry, 'guest-abc', 'tab-1')).toBe(false)
  })

  it('rejects a stale claim that arrives late, and supersedes the arrival itself', () => {
    // Two tabs race, or two instances do. Arrival order must not be able to
    // demote the tab the player is actually looking at.
    const current = claimSession(EMPTY_SESSION_REGISTRY, session('tab-2', 2000))
    const late = claimSession(current.registry, session('tab-1', 1000))

    expect(late.accepted).toBe(false)
    expect(late.superseded?.sessionId).toBe('tab-1')
    expect(late.registry).toBe(current.registry)
    expect(isCurrentSession(late.registry, 'guest-abc', 'tab-2')).toBe(true)
  })

  it('lets an equally-timestamped claim win, breaking the tie by arrival', () => {
    const first = claimSession(EMPTY_SESSION_REGISTRY, session('tab-1', 1000))
    const second = claimSession(first.registry, session('tab-2', 1000))
    expect(second.accepted).toBe(true)
    expect(second.superseded?.sessionId).toBe('tab-1')
  })

  it('is idempotent for a repeated claim of the same session', () => {
    // Every client message can arrive twice; a duplicate must not supersede
    // the tab that sent it.
    const first = claimSession(EMPTY_SESSION_REGISTRY, session('tab-1', 1000, 'conn-1'))
    const repeat = claimSession(first.registry, session('tab-1', 1000, 'conn-1'))
    expect(repeat.accepted).toBe(true)
    expect(repeat.superseded).toBeUndefined()
    expect(currentSession(repeat.registry, 'guest-abc')).toEqual(session('tab-1', 1000, 'conn-1'))
  })

  it('refreshes the connection when the same session reconnects', () => {
    const first = claimSession(EMPTY_SESSION_REGISTRY, session('tab-1', 1000, 'conn-1'))
    const again = claimSession(first.registry, session('tab-1', 1500, 'conn-2'))
    expect(again.superseded).toBeUndefined()
    expect(currentSession(again.registry, 'guest-abc')?.connectionId).toBe('conn-2')
    expect(currentSession(again.registry, 'guest-abc')?.issuedAt).toBe(1500)
  })

  it('keeps guests independent', () => {
    const a = claimSession(EMPTY_SESSION_REGISTRY, {
      guestId: 'guest-a',
      sessionId: 'tab-1',
      issuedAt: 1000,
    })
    const b = claimSession(a.registry, { guestId: 'guest-b', sessionId: 'tab-1', issuedAt: 2000 })
    expect(b.superseded).toBeUndefined()
    expect(isCurrentSession(b.registry, 'guest-a', 'tab-1')).toBe(true)
    expect(isCurrentSession(b.registry, 'guest-b', 'tab-1')).toBe(true)
  })

  it('never mutates the registry it was given', () => {
    const before = claimSession(EMPTY_SESSION_REGISTRY, session('tab-1', 1000)).registry
    const snapshot = [...before.entries()]
    claimSession(before, session('tab-2', 2000))
    expect([...before.entries()]).toEqual(snapshot)
    expect(EMPTY_SESSION_REGISTRY.size).toBe(0)
  })
})

describe('releaseSession', () => {
  it('drops the current session on disconnect', () => {
    const claimed = claimSession(EMPTY_SESSION_REGISTRY, session('tab-1', 1000)).registry
    const released = releaseSession(claimed, 'guest-abc', 'tab-1')
    expect(currentSession(released, 'guest-abc')).toBeUndefined()
  })

  it('ignores a superseded tab closing later', () => {
    // Otherwise the old tab's unload event evicts the live tab.
    const first = claimSession(EMPTY_SESSION_REGISTRY, session('tab-1', 1000)).registry
    const second = claimSession(first, session('tab-2', 2000)).registry
    const released = releaseSession(second, 'guest-abc', 'tab-1')
    expect(released).toBe(second)
    expect(isCurrentSession(released, 'guest-abc', 'tab-2')).toBe(true)
  })

  it('is a no-op for an unknown guest', () => {
    expect(releaseSession(EMPTY_SESSION_REGISTRY, 'nobody', 'tab-1')).toBe(EMPTY_SESSION_REGISTRY)
  })
})

describe('isCurrentSession', () => {
  it('is false for an unknown guest', () => {
    expect(isCurrentSession(EMPTY_SESSION_REGISTRY, 'guest-abc', 'tab-1')).toBe(false)
  })
})

describe('SESSION_SUPERSEDED_CODE', () => {
  it('is a stable wire code the transport can map to an error frame', () => {
    expect(SESSION_SUPERSEDED_CODE).toBe('session_superseded')
  })
})
