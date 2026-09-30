/**
 * Scenario expansion.
 *
 * A game is not one thing: it is the cross product of its settings presets
 * and the player counts its manifest allows. A bug that only shows up at
 * `maxPlayers`, or only under the `blitz` preset, is exactly the kind of bug
 * conformance exists to find, so the suite expands that cross product once and
 * every check runs against all of it.
 *
 * Playouts are generated here as well, because they are the expensive part and
 * five of the nine checks need the same ones.
 */

import {
  type GameEvent,
  type GameManifest,
  type SeatRoster,
  type Viewer,
  REPLAY,
  SPECTATOR,
  seatViewer,
} from '@playhall/game-sdk'
import { withoutAmbientSources } from './ambient.js'
import {
  type ActionChooser,
  type ContextOptions,
  type Playout,
  buildDefaultRoster,
  defaultChooseAction,
  outsiderSeatId,
  playout,
  seedFor,
} from './driver.js'
import type {
  SettingsVariant,
  TurnBasedConformanceOptions,
  TurnBasedConformanceSubject,
} from '../subject.js'

export const DEFAULTS = {
  playoutsPerVariant: 24,
  maxStepsPerPlayout: 500,
  seed: 'atrium-conformance-v1',
  startNow: 1_700_000_000_000,
  nowStepMs: 1_000,
} as const

export interface Scenario<TSettings> {
  readonly label: string
  readonly settings: TSettings
  readonly playerCount: number
  readonly roster: SeatRoster
  /** Contexts for this scenario differ only by `seed`, which the run supplies. */
  readonly baseContext: Omit<ContextOptions, 'seed'>
}

export interface PlayoutRun<TState, TAction, TSettings, TEvent extends GameEvent> {
  readonly scenario: Scenario<TSettings>
  readonly context: ContextOptions
  readonly playout: Playout<TState, TAction, TEvent>
  /** Non-null when the game threw where the contract says to return a value. */
  readonly crash: Error | null
}

export interface Prepared<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
> {
  readonly subject: TurnBasedConformanceSubject<
    TState,
    TAction,
    TView,
    TSettings,
    TEvent,
    TErrorCode
  >
  readonly scenarios: readonly Scenario<TSettings>[]
  readonly runs: readonly PlayoutRun<TState, TAction, TSettings, TEvent>[]
  readonly seeds: readonly string[]
  readonly maxSteps: number
  readonly trapAmbient: boolean
  readonly chooseAction: ActionChooser<TState, TAction>
  /** Runs game code with the ambient clock and RNG trapped, if enabled. */
  guard<T>(body: () => T): T
  /** Every viewer kind the fuzzer sweeps, for one roster. */
  viewersFor(roster: SeatRoster): readonly { readonly label: string; readonly viewer: Viewer }[]
}

function settingsVariantsOf<TSettings>(
  manifest: GameManifest<TSettings>,
  declared: readonly SettingsVariant<TSettings>[] | undefined,
): readonly SettingsVariant<TSettings>[] {
  if (declared !== undefined && declared.length > 0) return declared
  return [
    { label: 'defaults', settings: manifest.defaultSettings },
    ...manifest.presets.map((preset) => ({
      label: `preset:${preset.id}`,
      settings: preset.settings,
    })),
  ]
}

function playerCountsOf(
  minPlayers: number,
  maxPlayers: number,
  requested: readonly number[] | undefined,
): readonly number[] {
  if (requested !== undefined && requested.length > 0) return requested
  return minPlayers === maxPlayers ? [minPlayers] : [minPlayers, maxPlayers]
}

export function prepare<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(
  subject: TurnBasedConformanceSubject<TState, TAction, TView, TSettings, TEvent, TErrorCode>,
  options: TurnBasedConformanceOptions = {},
): Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode> {
  const manifest = subject.manifest
  const trapAmbient = options.trapAmbientSources ?? true
  const maxSteps = options.maxStepsPerPlayout ?? DEFAULTS.maxStepsPerPlayout
  const playoutsPerVariant = options.playoutsPerVariant ?? DEFAULTS.playoutsPerVariant
  const baseSeed = options.seed ?? DEFAULTS.seed
  const guard = <T>(body: () => T): T => (trapAmbient ? withoutAmbientSources(body) : body())
  const chooseAction: ActionChooser<TState, TAction> =
    subject.chooseAction?.bind(subject) ?? defaultChooseAction

  const variants = settingsVariantsOf(manifest, subject.settingsVariants)
  const counts = playerCountsOf(manifest.minPlayers, manifest.maxPlayers, subject.playerCounts)

  const scenarios: Scenario<TSettings>[] = []
  for (const variant of variants) {
    for (const playerCount of counts) {
      scenarios.push({
        label: `${variant.label} × ${playerCount}p`,
        settings: variant.settings,
        playerCount,
        roster:
          subject.buildRoster?.(playerCount) ??
          buildDefaultRoster(playerCount, manifest.teams !== 'none'),
        baseContext: {
          gameId: manifest.id,
          gameVersion: manifest.version,
          sdkContractVersion: manifest.sdkContractVersion,
          startNow: options.startNow ?? DEFAULTS.startNow,
          nowStepMs: options.nowStepMs ?? DEFAULTS.nowStepMs,
        },
      })
    }
  }

  const runs: PlayoutRun<TState, TAction, TSettings, TEvent>[] = []
  const seeds: string[] = []

  for (const scenario of scenarios) {
    for (let index = 0; index < playoutsPerVariant; index += 1) {
      const seed = seedFor(baseSeed, scenario.label, index)
      const context: ContextOptions = { ...scenario.baseContext, seed }
      seeds.push(String(seed))
      try {
        runs.push({
          scenario,
          context,
          playout: playout<TState, TAction, TSettings, TEvent>({
            server: subject.server,
            settings: scenario.settings,
            variantLabel: scenario.label,
            roster: scenario.roster,
            context,
            maxSteps,
            chooseAction,
            trapAmbient,
          }),
          crash: null,
        })
      } catch (error) {
        // A throw is itself a conformance failure; record it and let the
        // checks report it rather than aborting the whole run.
        runs.push({
          scenario,
          context,
          playout: {
            seed,
            variantLabel: scenario.label,
            playerCount: scenario.playerCount,
            roster: scenario.roster,
            initial: { state: undefined as unknown as TState, events: [] },
            steps: [],
            finalState: undefined as unknown as TState,
            result: null,
            truncated: false,
            stalledAt: 0,
          },
          crash: error instanceof Error ? error : new Error(String(error)),
        })
      }
    }
  }

  return {
    subject,
    scenarios,
    runs,
    seeds,
    maxSteps,
    trapAmbient,
    chooseAction,
    guard,
    viewersFor: (roster) => [
      ...roster.map((seat) => ({
        label: `seat ${String(seat.seatId)}`,
        viewer: seatViewer(seat.seatId),
      })),
      { label: 'spectator', viewer: SPECTATOR },
      // A seat id that is not in this match. The platform should never build
      // one, so a game that trusts it blindly is a bug worth finding.
      { label: 'outsider seat', viewer: seatViewer(outsiderSeatId(roster)) },
      { label: 'replay', viewer: REPLAY },
    ],
  }
}

/** The runs that produced a usable match. Crashed runs are reported separately. */
export function healthyRuns<TState, TAction, TSettings, TEvent extends GameEvent>(
  runs: readonly PlayoutRun<TState, TAction, TSettings, TEvent>[],
): readonly PlayoutRun<TState, TAction, TSettings, TEvent>[] {
  return runs.filter((run) => run.crash === null)
}
