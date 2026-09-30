import { describe, expect, it } from 'vitest'
import {
  canCloseLobby,
  canKick,
  canTransferHost,
  hostSuccessionRevision,
  isHost,
  resolveAbsentHostTransfer,
  resolveHostSuccession,
} from '../src/seats/host.js'
import { makeRoom } from './fixtures/rooms.js'

describe('resolveHostSuccession', () => {
  it('prefers a present, seated player, lowest seat first', () => {
    const room = makeRoom({
      seats: ['host', 'b', 'c'],
      presentPlayerIds: ['host', 'b', 'c'],
    })
    expect(resolveHostSuccession(room, 'host')).toBe('b')
  })

  it('skips the leaver even when they hold the lowest seat', () => {
    const room = makeRoom({ seats: ['a', 'host'], presentPlayerIds: ['a', 'host'] })
    expect(resolveHostSuccession(room, 'a')).toBe('host')
  })

  it('prefers a present player over an absent one in an earlier seat', () => {
    const room = makeRoom({ seats: ['host', 'absent', 'here'], presentPlayerIds: ['here'] })
    expect(resolveHostSuccession(room, 'host')).toBe('here')
  })

  it('falls back to an absent seated player rather than losing the crown', () => {
    // A lobby of one disconnected player still has an owner; the crown must not
    // evaporate during a tunnel.
    const room = makeRoom({ seats: ['host', 'absent'], presentPlayerIds: [] })
    expect(resolveHostSuccession(room, 'host')).toBe('absent')
  })

  it('falls back to a present spectator when no seat is held', () => {
    // Otherwise a room of watchers with a dead host can never be closed by
    // anyone — an immortal zombie lobby.
    const room = makeRoom({
      seats: ['host', null],
      spectatorPlayerIds: ['watcher'],
      presentPlayerIds: ['host', 'watcher'],
    })
    expect(resolveHostSuccession(room, 'host')).toBe('watcher')
  })

  it('ignores an absent spectator', () => {
    const room = makeRoom({
      seats: ['host', null],
      spectatorPlayerIds: ['gone'],
      presentPlayerIds: ['host'],
    })
    expect(resolveHostSuccession(room, 'host')).toBeNull()
  })

  it('never re-elects the leaver from the spectator list', () => {
    const room = makeRoom({
      seats: [null, null],
      spectatorPlayerIds: ['host'],
      presentPlayerIds: ['host'],
    })
    expect(resolveHostSuccession(room, 'host')).toBeNull()
  })

  it('returns null for a room with nobody left', () => {
    expect(resolveHostSuccession(makeRoom({ seats: ['host', null] }), 'host')).toBeNull()
  })
})

describe('resolveAbsentHostTransfer', () => {
  it('does nothing while the host is present', () => {
    const room = makeRoom({ seats: ['host', 'b'], presentPlayerIds: ['host', 'b'] })
    expect(resolveAbsentHostTransfer(room)).toBeNull()
  })

  it('promotes a present player once the host goes quiet', () => {
    const room = makeRoom({ seats: ['host', 'b'], presentPlayerIds: ['b'] })
    expect(resolveAbsentHostTransfer(room)).toBe('b')
  })

  it('does nothing when everybody is offline', () => {
    // The empty timer owns that room; moving the crown is noise.
    const room = makeRoom({ seats: ['host', 'b'], presentPlayerIds: [] })
    expect(resolveAbsentHostTransfer(room)).toBeNull()
  })

  it('is idempotent once the crown has moved', () => {
    const moved = makeRoom({
      seats: ['old', 'new'],
      hostPlayerId: 'new',
      presentPlayerIds: ['new'],
    })
    expect(resolveAbsentHostTransfer(moved)).toBeNull()
  })

  it('does not hand the crown back when the old host reconnects', () => {
    // A flapping mobile connection would otherwise pass the crown back and forth
    // several times a minute, and every hand-off is a delta for every client.
    const reconnected = makeRoom({
      seats: ['old', 'new'],
      hostPlayerId: 'new',
      presentPlayerIds: ['new', 'old'],
    })
    expect(resolveAbsentHostTransfer(reconnected)).toBeNull()
  })
})

describe('hostSuccessionRevision', () => {
  it('names the heir when the host is gone', () => {
    const room = makeRoom({ seats: ['host', 'b'], presentPlayerIds: ['b'] })
    expect(hostSuccessionRevision(room)).toEqual({ hostPlayerId: 'b' })
  })

  it('is empty when the host is still here', () => {
    const room = makeRoom({ seats: ['host', 'b'], presentPlayerIds: ['host', 'b'] })
    expect(hostSuccessionRevision(room)).toEqual({})
  })

  it('leaves the crown with the departed host when there is no heir', () => {
    // `hostPlayerId` is not nullable, and a hostless room state would be a case
    // every reader has to handle for the few minutes before the sweep.
    const room = makeRoom({ seats: ['host', null], presentPlayerIds: [] })
    expect(hostSuccessionRevision(room)).toEqual({})
  })
})

describe('isHost', () => {
  it('follows the room role, not the seat', () => {
    // The host is a room role. A seat swap must not hand the kick button over.
    const room = makeRoom({ seats: ['b', 'host'], hostPlayerId: 'host' })
    expect(isHost(room, 'host')).toBe(true)
    expect(isHost(room, 'b')).toBe(false)
  })
})

describe('canTransferHost', () => {
  const room = makeRoom({
    seats: ['host', 'b'],
    spectatorPlayerIds: ['watcher', 'absent-watcher'],
    presentPlayerIds: ['host', 'b', 'watcher'],
  })

  it('allows a present seated player', () => {
    expect(canTransferHost(room, 'host', 'b')).toBeNull()
  })

  it('allows a present spectator', () => {
    expect(canTransferHost(room, 'host', 'watcher')).toBeNull()
  })

  it('refuses a non-host actor', () => {
    expect(canTransferHost(room, 'b', 'watcher')).toBe('not_host')
  })

  it('refuses a self-transfer', () => {
    expect(canTransferHost(room, 'host', 'host')).toBe('invalid_host')
  })

  it('refuses a stranger', () => {
    expect(canTransferHost(room, 'host', 'nobody')).toBe('not_a_member')
  })

  it('refuses an absent member', () => {
    // Handing the crown to a closed tab recreates the problem succession exists
    // to fix, one step removed.
    expect(canTransferHost(room, 'host', 'absent-watcher')).toBe('invalid_host')
  })
})

describe('canKick', () => {
  const lobby = makeRoom({
    seats: ['host', 'b'],
    spectatorPlayerIds: ['watcher'],
    presentPlayerIds: ['host', 'b', 'watcher'],
  })

  it('allows the host to remove a seated player', () => {
    expect(canKick(lobby, 'host', 'b')).toBeNull()
  })

  it('allows the host to remove a spectator', () => {
    expect(canKick(lobby, 'host', 'watcher')).toBeNull()
  })

  it('refuses a non-host actor', () => {
    expect(canKick(lobby, 'b', 'host')).toBe('not_host')
  })

  it('refuses a self-kick', () => {
    expect(canKick(lobby, 'host', 'host')).toBe('cannot_kick_self')
  })

  it('refuses a stranger', () => {
    expect(canKick(lobby, 'host', 'nobody')).toBe('not_a_member')
  })

  it('refuses mid-match', () => {
    // Vacating a seat during a match is a forfeit, which belongs to the match.
    const playing = makeRoom({ seats: ['host', 'b'], status: 'in_progress' })
    expect(canKick(playing, 'host', 'b')).toBe('match_in_progress')
  })

  it('allows it in a finished room, which is where a substitute comes in', () => {
    const finished = makeRoom({
      seats: ['host', 'b'],
      status: 'finished',
      presentPlayerIds: ['host'],
    })
    expect(canKick(finished, 'host', 'b')).toBeNull()
  })

  it('refuses in a closed room', () => {
    const closed = makeRoom({ seats: ['host', 'b'], status: 'closed' })
    expect(canKick(closed, 'host', 'b')).toBe('room_not_open')
  })
})

describe('canCloseLobby', () => {
  it('allows the host from a lobby', () => {
    expect(canCloseLobby(makeRoom(), 'host')).toBeNull()
  })

  it('allows the host mid-match', () => {
    expect(canCloseLobby(makeRoom({ status: 'in_progress' }), 'host')).toBeNull()
  })

  it('allows the host from a finished room', () => {
    expect(canCloseLobby(makeRoom({ status: 'finished' }), 'host')).toBeNull()
  })

  it('refuses a non-host', () => {
    expect(canCloseLobby(makeRoom({ seats: ['host', 'b'] }), 'b')).toBe('not_host')
  })

  it('refuses an already-closed room', () => {
    expect(canCloseLobby(makeRoom({ status: 'closed' }), 'host')).toBe('room_not_open')
  })
})
