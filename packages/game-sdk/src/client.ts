/**
 * Client contracts.
 *
 * A game ships components; the platform renders the chrome around them. The
 * game never mounts a router, opens a socket, reads a cookie or knows what a
 * room code is — it receives a view and a `dispatch`, and that is the whole
 * surface.
 *
 * ## No React dependency
 *
 * These are plain TypeScript types. `GameComponent<P>` is `(props: P) =>
 * unknown`, which every React function component satisfies. The alternative —
 * `ComponentType<P>` from `@types/react` — would drag React types into
 * `platform-core` and `apps/realtime`, which have no business knowing about
 * React, purely so a type could be erased at build time. Games write ordinary
 * React function components; nothing about this file stops that.
 *
 * ## Lazy by construction
 *
 * Every component slot is a `LazyComponent` — a thunk returning a dynamic
 * import. Adding a game must add zero bytes to other bundles, and the only way
 * to guarantee that structurally is to make the registry hold import functions
 * rather than components.
 */

import type { ActionError } from './errors.js'
import type { SeatId, TeamId } from './ids.js'
import type { GameCatalogEntry, SettingsPreset } from './manifest.js'
import type { MatchResult } from './result.js'
import type { TimerKind } from './timers.js'

/** Any React function component satisfies this. Class components do not. */
export type GameComponent<TProps> = (props: TProps) => unknown

export type LazyComponent<TProps> = () => Promise<{ default: GameComponent<TProps> }>

/**
 * A seat as the client sees it. Richer than the server-side `Seat` because it
 * carries platform presence, which never enters game state.
 */
export interface SeatView {
  readonly seatId: SeatId
  readonly index: number
  readonly displayName: string
  readonly teamId: TeamId | null
  readonly isBot: boolean
  readonly isConnected: boolean
  readonly isYou: boolean
  readonly isHost: boolean
}

/**
 * A running timer. `remainingMs` is already corrected for clock skew and
 * latency by the platform's timer sync, so a game renders it directly and does
 * not run its own countdown against the local clock.
 */
export interface TimerView {
  readonly timerId: string
  readonly seatId: SeatId | null
  readonly kind: TimerKind
  readonly remainingMs: number
  readonly isRunning: boolean
}

/** Post-match review: scrubbing back through the match log. */
export interface ReviewMode {
  readonly enabled: boolean
  /** The sequence currently being shown. */
  readonly sequence: number
  readonly maxSequence: number
  readonly goToSequence: (sequence: number) => void
}

export interface GameViewProps<TView, TAction> {
  /** Exactly what `getViewFor` returned for this viewer. */
  readonly view: TView
  /** Null for a spectator or in review mode. */
  readonly mySeat: SeatId | null
  readonly seats: readonly SeatView[]
  /**
   * Sends an action to the server. Fire-and-forget: the server is authoritative,
   * so the next `view` is the answer. A rejection arrives as `lastError`.
   */
  readonly dispatch: (action: TAction) => void
  readonly timers: readonly TimerView[]
  readonly isSpectator: boolean
  /** Null during live play. */
  readonly reviewMode: ReviewMode | null
  /** The most recent rejection for this seat, or null. Cleared on the next view. */
  readonly lastError: ActionError<string> | null
  /** Populated from `getLegalActions` when the game implements it. */
  readonly legalActions: readonly TAction[] | null
}

export interface GameSceneProps<TSnapshot, TInput> {
  /** The most recent decoded snapshot from `getSnapshotFor`. */
  readonly snapshot: TSnapshot
  readonly mySeat: SeatId | null
  readonly seats: readonly SeatView[]
  readonly sendInput: (input: TInput) => void
  /** Client render tick, for interpolation. Not the server tick. */
  readonly renderTick: number
  /** How far behind the server the renderer is deliberately running. */
  readonly interpolationDelayMs: number
  readonly isSpectator: boolean
}

export interface HUDProps<TSnapshot> {
  readonly snapshot: TSnapshot
  readonly mySeat: SeatId | null
  readonly seats: readonly SeatView[]
  readonly timers: readonly TimerView[]
  readonly isSpectator: boolean
}

export interface SettingsFormProps<TSettings> {
  readonly value: TSettings
  readonly onChange: (next: TSettings) => void
  readonly presets: readonly SettingsPreset<TSettings>[]
  /** True for a non-host, or once the match has started. */
  readonly disabled: boolean
  /** Field-path-keyed messages from `settingsSchema`. */
  readonly errors: Readonly<Record<string, string>>
}

export interface ResultPanelProps {
  readonly result: MatchResult
  readonly seats: readonly SeatView[]
  readonly mySeat: SeatId | null
  /** Provided by the platform when a rematch is possible. */
  readonly onRematch: (() => void) | null
  readonly onExitToLobby: () => void
  /** Present when the game implements `exportRecord`. */
  readonly onDownloadRecord: (() => void) | null
}

export interface HowToPlayProps {
  readonly game: GameCatalogEntry
  readonly playerCount: number
}

export interface SoundAsset {
  /** Path relative to the game package. Resolved by the registry. */
  readonly src: string
  readonly volume?: number
  readonly preload?: boolean
  /** Alternate encodings; the platform picks what the browser supports. */
  readonly alternates?: readonly string[]
}

/**
 * Named sounds the platform preloads and plays, so muting, ducking and the
 * accessibility "reduce audio" setting are handled once for every game.
 */
export type SoundMap = Readonly<Record<string, SoundAsset>>

export interface TurnBasedClientModule<TView, TAction, TSettings> {
  readonly GameView: LazyComponent<GameViewProps<TView, TAction>>
  readonly SettingsForm?: LazyComponent<SettingsFormProps<TSettings>>
  readonly ResultPanel?: LazyComponent<ResultPanelProps>
  readonly HowToPlay?: LazyComponent<HowToPlayProps>
  readonly sounds?: SoundMap
}

export interface RealtimeClientModule<TSnapshot, TInput, TSettings> {
  readonly GameScene: LazyComponent<GameSceneProps<TSnapshot, TInput>>
  readonly HUD: LazyComponent<HUDProps<TSnapshot>>
  readonly SettingsForm?: LazyComponent<SettingsFormProps<TSettings>>
  readonly ResultPanel?: LazyComponent<ResultPanelProps>
  readonly HowToPlay?: LazyComponent<HowToPlayProps>
  readonly sounds?: SoundMap
}

export type AnyTurnBasedClientModule = TurnBasedClientModule<unknown, unknown, unknown>
export type AnyRealtimeClientModule = RealtimeClientModule<unknown, unknown, unknown>
