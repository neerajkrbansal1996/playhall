/**
 * The room store port, plus the in-memory implementation used by tests and by
 * a single-process dev server.
 *
 * The port is shaped for Redis, not for a `Map`, because the `Map` is the
 * throwaway and Redis is the real target:
 *
 * - `reserveCode` is **atomic** — one round trip that both checks and claims.
 *   A `has()` followed by a `set()` gives two concurrent room creations the
 *   same code, and the window is exactly as wide as an `await`. In Redis this
 *   is `SET room:code:<CODE> <roomId> NX PX <ttl>`.
 * - `save` is **compare-and-set** on the previous snapshot. Two players
 *   joining the same last seat in the same tick must not both succeed; the
 *   loser retries against fresh state. In Redis this is a `WATCH`/`MULTI` or
 *   a small Lua script.
 * - `dueForSweep` is a range query over the next-deadline of every live room.
 *   In Redis this is a sorted set scored by `nextRoomDeadline`, which is why
 *   the lifecycle rules are pure functions of `(room, now)` rather than
 *   in-process timers.
 *
 * Every key this port implies has a TTL derived from `roomKeyTtlMs`. A room
 * that leaks is a scaling bug.
 */

import { nextRoomDeadline } from './lifecycle.js'
import type { Room } from './types.js'

export interface RoomStore {
  /** Atomically claims `code` for `roomId`. False if already taken. */
  reserveCode(code: string, roomId: string): Promise<boolean>
  releaseCode(code: string): Promise<void>

  get(roomId: string): Promise<Room | null>
  getByCode(code: string): Promise<Room | null>

  /** Unconditional write. Used at creation, when there is no prior snapshot. */
  insert(room: Room): Promise<void>
  /** Compare-and-set. False when `previous` is stale; the caller re-reads. */
  save(previous: Room, next: Room): Promise<boolean>
  /** Removes the room and frees its code. Match records are untouched. */
  remove(roomId: string): Promise<void>

  /** Public, joinable rooms. Callers must still check the flag. */
  listPublic(limit: number): Promise<readonly Room[]>
  /** Rooms whose next lifecycle deadline is at or before `now`. */
  dueForSweep(now: number, limit: number): Promise<readonly Room[]>

  readonly size: number
}

export function createInMemoryRoomStore(): RoomStore {
  const rooms = new Map<string, Room>()
  const codes = new Map<string, string>()

  return {
    async reserveCode(code, roomId) {
      if (codes.has(code)) return false
      codes.set(code, roomId)
      return true
    },
    async releaseCode(code) {
      codes.delete(code)
    },
    async get(roomId) {
      return rooms.get(roomId) ?? null
    },
    async getByCode(code) {
      const roomId = codes.get(code)
      return roomId === undefined ? null : (rooms.get(roomId) ?? null)
    },
    async insert(room) {
      rooms.set(room.id, room)
    },
    async save(previous, next) {
      const current = rooms.get(previous.id)
      // `updatedAt` is the version token. Every mutation bumps it, and the
      // service never writes without having just read.
      if (current === undefined || current.updatedAt !== previous.updatedAt) return false
      rooms.set(next.id, next)
      return true
    },
    async remove(roomId) {
      const room = rooms.get(roomId)
      if (room) codes.delete(room.code)
      rooms.delete(roomId)
    },
    async listPublic(limit) {
      return [...rooms.values()]
        .filter((room) => room.visibility === 'public' && room.status === 'lobby')
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
    },
    async dueForSweep(now, limit) {
      return [...rooms.values()]
        .filter((room) => {
          const deadline = nextRoomDeadline(room)
          return deadline !== null && deadline <= now
        })
        .slice(0, limit)
    },
    get size() {
      return rooms.size
    },
  }
}
