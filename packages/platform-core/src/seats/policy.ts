/**
 * The seating policy: everything the seats layer is allowed to know about a
 * game.
 *
 * This file is the whole reason `seats/` can be pure. Every function in this
 * directory takes a `SeatingPolicy` rather than a manifest, a module or a game
 * id, so none of them can reach for a rule that is not declared. Reviewing
 * "does core branch on a game?" is reviewing this one type.
 *
 * The policy is *projected* from the game's catalogue entry — the JSON-safe
 * manifest projection — and never from a game id. `seatingPolicyFor` is the
 * only place a manifest field becomes a seating rule.
 */

import type { GameCatalogEntry } from '@playhall/game-sdk'

/**
 * May a newcomer take a free seat after the match has started?
 *
 * The question is only about *seats*. Whether a newcomer may watch is already
 * declared by `supportsSpectators`, and folding the two together would give the
 * platform two flags that disagree about the same arrival.
 *
 * - `spectate_only` — no. A seat vacated mid-match still belongs to the player
 *   who left, and they may reconnect into it. This is the conservative default
 *   and matches what the join matrix did before the rule was declarable.
 * - `fill_empty_seats` — yes. For a game that can absorb a substitute: a party
 *   game where a kicked player's seat should not stay dead for the rest of the
 *   round, or a variable-size game that started below `maxPlayers`.
 */
export const LATE_JOIN_MODES = ['spectate_only', 'fill_empty_seats'] as const
export type LateJoinMode = (typeof LATE_JOIN_MODES)[number]

/**
 * How a match begins.
 *
 * Derived, not declared: a game whose `minPlayers` equals its `maxPlayers` has
 * exactly one playable roster, so "full" and "ready to go" are the same fact
 * and asking the host to confirm it is a tap for nothing. A game with a range
 * cannot be started by the platform, because only the host knows whether the
 * sixth friend is still coming.
 */
export const START_MODES = ['auto_when_full', 'host_starts'] as const
export type StartMode = (typeof START_MODES)[number]

/**
 * What a rematch rotates.
 *
 * - `none` — same seats. "New game, same people", unchanged.
 * - `seats` — every player shifts one seat, so turn order advances. This is
 *   what makes a two-player rematch fair without anyone negotiating colours.
 * - `teams` — seats are kept but teams are re-drawn from scratch, so the same
 *   group does not play the same four-versus-four every round.
 */
export const REMATCH_ROTATIONS = ['none', 'seats', 'teams'] as const
export type RematchRotation = (typeof REMATCH_ROTATIONS)[number]

/** Team layout. `none` means the seat record carries no team at all. */
export type TeamMode = 'none' | 'fixed' | 'auto-balanced'

export interface SeatingPolicy {
  readonly minPlayers: number
  readonly maxPlayers: number
  readonly teams: TeamMode
  /** Null unless `teams` needs a count. */
  readonly teamCount: number | null
  readonly supportsSpectators: boolean
  readonly supportsBots: boolean
  readonly lateJoin: LateJoinMode
  readonly startMode: StartMode
  readonly rematchRotation: RematchRotation
}

/**
 * Manifest fields the seating layer reads that the ratified SDK v1 manifest
 * does not yet carry.
 *
 * Both are optional, so a game written against today's contract projects
 * cleanly and gets the documented default. They are declared here rather than
 * added to `GameManifest` because the manifest is an SDK contract the CTO owns:
 * changing it needs an ADR, not a platform commit. Reading them structurally
 * means the day the ADR lands and the fields become part of the manifest, this
 * projection already honours them and no platform code changes at all.
 *
 * The important property in the meantime is that the *rule* is not hard-coded:
 * a game that declares `lateJoin` is obeyed today, and a game that declares
 * nothing gets a documented fallback rather than a platform opinion buried in
 * the join matrix.
 */
export interface SeatingDeclarations {
  readonly lateJoin?: LateJoinMode
  readonly rematchRotation?: RematchRotation
}

/**
 * The default rotation for a game that does not declare one.
 *
 * `seats` for a seat-asymmetric game (turn order matters and there are no
 * teams), `teams` when the game has auto-balanced teams, `none` for fixed
 * teams — a fixed-team game has declared that its seat-to-team map is part of
 * its rules, so re-drawing it is not the platform's call.
 */
function defaultRotation(teams: TeamMode): RematchRotation {
  if (teams === 'auto-balanced') return 'teams'
  if (teams === 'fixed') return 'none'
  return 'seats'
}

/**
 * Projects a catalogue entry into a seating policy.
 *
 * `entry` is typed as the catalogue entry plus the optional declarations above,
 * so a caller holding a plain `GameCatalogEntry` type-checks unchanged.
 */
export function seatingPolicyFor(entry: GameCatalogEntry & SeatingDeclarations): SeatingPolicy {
  const teams: TeamMode = entry.teams
  return {
    minPlayers: entry.minPlayers,
    maxPlayers: entry.maxPlayers,
    teams,
    // A fixed-team game's count is validated by the manifest. An auto-balanced
    // game that declares no count gets two, because "balance these players"
    // with one team is not a thing anyone meant.
    teamCount: teams === 'none' ? null : (entry.teamCount ?? 2),
    supportsSpectators: entry.supportsSpectators,
    supportsBots: entry.supportsBots,
    lateJoin: entry.lateJoin ?? 'spectate_only',
    startMode: entry.minPlayers === entry.maxPlayers ? 'auto_when_full' : 'host_starts',
    rematchRotation: entry.rematchRotation ?? defaultRotation(teams),
  }
}

/** The team ids for a policy, in canonical order. Empty when teams are off. */
export function teamIdsFor(policy: SeatingPolicy): readonly string[] {
  if (policy.teams === 'none' || policy.teamCount === null) return []
  return Array.from({ length: policy.teamCount }, (_, index) => `team-${index + 1}`)
}

/**
 * The countdown a full fixed-size room waits out before its match starts.
 *
 * Three seconds is the product rule. It exists so that the last player to
 * arrive sees the roster they are joining before the board replaces it, and so
 * that a mistaken tap on a shared link is recoverable — un-readying inside the
 * window cancels it.
 */
export const AUTO_START_COUNTDOWN_MS = 3_000
