/**
 * Turning the host's colour preference into an actual seat assignment.
 *
 * Determinism lens: `random` resolves through the seeded `ctx.rng` the platform
 * hands the game module, never `Math.random()`. The same match seed must always
 * produce the same colours, or a replay diverges from the game it replays.
 *
 * The colour vocabulary here is chess.js's (`'w'` / `'b'`) so the settings layer
 * and the rules layer never disagree. `'white' | 'black' | 'random'` stays on
 * the settings side only, because that is what the form shows a human.
 */

import type { SeatId } from '../sdk/contract.js'
import { BLACK, WHITE, type Color, type ColorAssignment } from '../rules/types.js'
import type { ColorPreference } from './schema.js'

/** Signature of the seeded generator the SDK exposes as `ctx.rng`. */
export type Rng = () => number

/** Which colour the player who opened the lobby ends up with. */
export function resolveHostColor(preference: ColorPreference, rng: Rng): Color {
  switch (preference) {
    case 'white':
      return WHITE
    case 'black':
      return BLACK
    case 'random':
      // Called only for `random`, so an explicit choice never consumes a draw
      // from the match's rng stream.
      return rng() < 0.5 ? WHITE : BLACK
  }
}

/**
 * Map the two seats onto the two colours.
 *
 * `hostSeatId` is the player who created the lobby; `guestSeatId` is whoever
 * joined through the link or code.
 */
export function assignColors(
  preference: ColorPreference,
  hostSeatId: SeatId,
  guestSeatId: SeatId,
  rng: Rng,
): ColorAssignment {
  const host = resolveHostColor(preference, rng)
  return host === WHITE
    ? { w: hostSeatId, b: guestSeatId }
    : { w: guestSeatId, b: hostSeatId }
}
