/**
 * @playhall/platform-core — guest identity, game registry, rooms, seats, ready
 * checks, chat, presence, spectating, reconnection, timers, match log.
 *
 * Hard rule: nothing here may know about a specific game. Games are loaded
 * through the registry; the platform never imports a game package.
 *
 * Landing through M1, one concern at a time. Shipped so far: guest identity
 * (M1.2). Rooms, seats, chat, presence and the timer service follow.
 */
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@playhall/shared'

export * from './identity/index.js'

export const PLATFORM_CORE_VERSION = '0.0.0'

/** Total distinct room codes. Reported so the collision budget stays visible. */
export const ROOM_CODE_SPACE = ROOM_CODE_ALPHABET.length ** ROOM_CODE_LENGTH

export function platformBuildInfo(): { platformCore: string; roomCodeSpace: number } {
  return { platformCore: PLATFORM_CORE_VERSION, roomCodeSpace: ROOM_CODE_SPACE }
}
