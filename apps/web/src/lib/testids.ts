/**
 * The platform half of the M2 E2E observable contract's `data-testid` registry.
 *
 * The contract's own first rule is that a `data-testid` is **a test contract,
 * not a styling hook** — renaming one is a breaking change. A string typed by
 * hand in a page and again in a spec has no such property: the two drift, and
 * the spec goes green matching nothing. So the names live here once, both sides
 * import them, and a rename is a compile error on every use.
 *
 * Scope. This file covers the **platform** surfaces — create-lobby, room, join,
 * seats, presence. It deliberately does not name a single game's selector:
 * `games/chess` owns `chess-board`, `sq-*` and the rest inside its own package
 * ([PER-26](/PER/issues/PER-26)), and a game id in `apps/web` would break
 * principle 1 and the dependency boundary alike.
 *
 * Settings fields are **not** here either, and that is the point. They are
 * derived from the descriptor key by `fieldTestAttributes` in
 * `@/components/settings-form` — `setting-<formFieldKey>` — so a new setting
 * cannot be added without a testid. Rev 2 of the contract hand-named four of
 * chess's six settings in this same table and lost `takebacks` and `autoQueen`
 * exactly because the names were written down rather than derived. Anything
 * that *can* be derived should be; this file is only for the fixed surfaces
 * that have no key to derive from.
 *
 * Reconciliation note for whoever next edits the contract: rev 4's lobby table
 * still carries rev 2's hand-named settings ids (`time-control-select`,
 * `custom-initial-minutes`, `custom-increment-seconds`, `color-preference`)
 * alongside the `setting-<formFieldKey>` rule. They are superseded — and
 * `color-preference` never matched the landed key, which is `color`. Only the
 * derived form is implementable without teaching `apps/web` what a time control
 * is.
 */

/** Fixed platform testids, keyed by the name a page or spec refers to them by. */
export const testIds = {
  /** The create-lobby form element. Setup step of every E2E scenario. */
  createLobbyForm: 'create-lobby-form',
  /** The primary action that creates the lobby. */
  createLobbySubmit: 'create-lobby-submit',

  /** The room's 6-character code, as text. Share-first. */
  roomCode: 'room-code',
  /** The full invite URL, as text. */
  roomLink: 'room-link',
  /** Copy-to-clipboard control for the invite URL. */
  copyRoomLink: 'copy-room-link',

  /** Join-by-code input. Case-insensitive, trims spaces. */
  joinCodeInput: 'join-code-input',
  /** Join-by-code submit. */
  joinSubmit: 'join-submit',

  /** Count of spectators currently watching. */
  spectatorCount: 'spectator-count',
} as const

export type TestId = (typeof testIds)[keyof typeof testIds]

/**
 * A seat's testid, derived from the seat id the platform assigned.
 *
 * Chess's seats happen to be `w` and `b`, which is why the contract writes the
 * row as `seat-<w|b>`; the seat ids come from the game's player descriptor, so
 * this takes whatever the platform hands it rather than a colour union. A
 * four-seat game gets working selectors from the same helper with no change
 * here — the same reason settings ids are derived.
 *
 * The element carries `data-connected="true"|"false"` for presence, which is
 * what the disconnect and reconnect scenarios assert against.
 */
export function seatTestId(seatId: string): string {
  return `seat-${seatId}`
}

/**
 * Attributes for a seat, so presence cannot be emitted without the testid.
 *
 * `data-connected` is always written, never omitted-when-false: an absent
 * attribute and a disconnected player would be indistinguishable to a spec, and
 * "never measure a surface without first proving which state it is in" is the
 * contract's standing rule.
 */
export function seatTestAttributes(
  seatId: string,
  connected: boolean,
): Record<`data-${string}`, string> {
  return {
    'data-testid': seatTestId(seatId),
    'data-connected': connected ? 'true' : 'false',
  }
}
