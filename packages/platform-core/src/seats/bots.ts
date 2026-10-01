/**
 * The bot slot port. **v1 defines this interface and ships no implementation.**
 *
 * That is the whole deliverable, and it is deliberate. The cost of adding bots
 * later is not writing a bot — it is that "a seat can be held by something that
 * is not a person" reaches into the seat record, the start rules, the room
 * service, the wire protocol and the lobby. Declaring the slot now pays that
 * cost once, against a room model that is still cheap to change, and leaves the
 * actual opponent as a self-contained addition behind this port.
 *
 * What already exists because of it:
 *
 * - `RoomSeatSlot.reservedFor` — a seat can be held open for a bot, and
 *   `freeSeatIndex` refuses to hand it to the next person through the link.
 * - `bot_seat_unfilled` in `seats/start.ts` — a room with an unfillable bot seat
 *   does not start. Today that is *every* bot seat, so reserving one is an
 *   explicit "I am waiting for something that does not exist yet" rather than a
 *   match that quietly begins a player short.
 * - `supportsBots` on the manifest — a game declares whether a bot is even
 *   meaningful, so the host UI is driven by the game and not by a platform list.
 *
 * A provider, when one is written, is bound by the same rules as a human seat:
 * it is a `playerId` in a seat, its moves arrive as ordinary actions through
 * `applyAction`, and it sees only what `getViewFor` gives it. A bot that reads
 * game state directly would be a hidden-information leak with a special case
 * around it, and nothing in this port permits one.
 */

import type { SeatingPolicy } from './policy.js'
import type { Room } from '../rooms/types.js'

/** What a provider is asked to fill. Carries no game state and no rules. */
export interface BotSlotRequest {
  readonly roomId: string
  readonly seatIndex: number
  readonly gameId: string
  /** Pinned for the match's life, exactly as a room pins it. */
  readonly gameVersion: string
  /** Null unless the room's game declares teams. */
  readonly teamId: string | null
  /**
   * Opaque to the platform, validated by the provider. Core must never learn
   * what "hard" means for a particular game — that is the plugin boundary, and
   * a difficulty enum here would be a game-specific field in core.
   */
  readonly difficulty: string | null
}

/**
 * The identity a provider hands back: an ordinary occupant.
 *
 * `playerId` goes into the seat unchanged, so every downstream rule — turn
 * order, redaction, the match log, the result — treats a bot as a player
 * without a branch. `isBot` exists for presentation only.
 */
export interface BotIdentity {
  readonly playerId: string
  readonly displayName: string
  readonly isBot: true
}

export interface BotSeatProvider {
  readonly id: string
  /** Whether this provider can play `gameId` at all. */
  supports(gameId: string): boolean
  /** Claims the slot. Rejects rather than resolving a placeholder it cannot drive. */
  claim(request: BotSlotRequest): Promise<BotIdentity>
  /** Releases a claimed bot. Must be idempotent — a room can close under it. */
  release(playerId: string): Promise<void>
}

/**
 * The v1 registry: empty, by design.
 *
 * Typed as a readonly array of the port rather than `never[]`, so the day a
 * provider is added the only change is its entry.
 */
export const BOT_SEAT_PROVIDERS: readonly BotSeatProvider[] = []

export type BotSlotOutcome =
  | { readonly ok: true; readonly provider: BotSeatProvider }
  /** The game's manifest does not declare bot support. */
  | { readonly ok: false; readonly code: 'bots_not_supported' }
  /** No registered provider plays this game. Always the answer in v1. */
  | { readonly ok: false; readonly code: 'no_provider' }

/**
 * Picks a provider for a bot seat.
 *
 * Checks the manifest before the registry, so the refusal a host sees is about
 * their game rather than about the platform's inventory — and so that adding a
 * provider later cannot accidentally enable bots for a game that never declared
 * them.
 */
export function resolveBotProvider(
  room: Room,
  policy: SeatingPolicy,
  providers: readonly BotSeatProvider[] = BOT_SEAT_PROVIDERS,
): BotSlotOutcome {
  if (!policy.supportsBots) return { ok: false, code: 'bots_not_supported' }
  const provider = providers.find((candidate) => candidate.supports(room.gameId))
  return provider === undefined ? { ok: false, code: 'no_provider' } : { ok: true, provider }
}
