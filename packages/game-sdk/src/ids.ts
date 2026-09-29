/**
 * Branded identifier types.
 *
 * These are strings at runtime and distinct types at compile time, so a
 * `PlayerId` can never be passed where a `SeatId` is expected. Seat identity
 * and player identity are deliberately separate: a seat outlives the player
 * sitting in it (reconnection, substitution, spectator promotion), and games
 * must key their state on the seat, never on the player.
 */

declare const brand: unique symbol

export type Branded<T, B extends string> = T & { readonly [brand]: B }

/** Stable identifier of a game module, e.g. `chess`. */
export type GameId = Branded<string, 'GameId'>

/** A seat at a match. Stable for the whole match; games key state on this. */
export type SeatId = Branded<string, 'SeatId'>

/** A team within a match. Only meaningful when the manifest declares teams. */
export type TeamId = Branded<string, 'TeamId'>

/**
 * A player (guest in v1). Platform-owned identity. Games see it only through
 * `Seat.occupant` and must not use it as a state key — it changes when a
 * player is substituted, and it is the same across concurrent matches.
 */
export type PlayerId = Branded<string, 'PlayerId'>

/** A single match of a game inside a room. */
export type MatchId = Branded<string, 'MatchId'>

/** A timer instance. Must correspond to a `TimerSpec.id` in the manifest. */
export type TimerId = Branded<string, 'TimerId'>

/**
 * The per-match random seed. Stored on the match so a match can be replayed
 * byte-for-byte from its log.
 */
export type MatchSeed = Branded<string, 'MatchSeed'>

export const asGameId = (value: string): GameId => value as GameId
export const asSeatId = (value: string): SeatId => value as SeatId
export const asTeamId = (value: string): TeamId => value as TeamId
export const asPlayerId = (value: string): PlayerId => value as PlayerId
export const asMatchId = (value: string): MatchId => value as MatchId
export const asTimerId = (value: string): TimerId => value as TimerId
export const asMatchSeed = (value: string): MatchSeed => value as MatchSeed
