/**
 * Game modules: what a game package default-exports, and what the registry
 * loads.
 *
 * A `GameModule` is the complete plugin: manifest + server + lazily-imported
 * client. The platform never imports a game package directly — it holds
 * modules the registry gave it, and it only ever reads manifest fields and
 * calls contract methods. A game, symmetrically, imports only
 * `@atrium/game-sdk`. CI fails the build on a violation in either direction.
 */

import type {
  AnyRealtimeClientModule,
  AnyTurnBasedClientModule,
  RealtimeClientModule,
  TurnBasedClientModule,
} from './client.js'
import type { DisconnectPolicy } from './disconnect.js'
import type { GameEvent } from './events.js'
import type { StandardActionErrorCode } from './errors.js'
import { type GameManifest, validateManifest } from './manifest.js'
import type { AnyRealtimeGameServer, RealtimeGameServer } from './realtime.js'
import type { AnyTurnBasedGameServer, TurnBasedGameServer } from './turn-based.js'
import { SDK_CONTRACT_VERSION, isContractSupported } from './versioning.js'

export interface TurnBasedGameModule<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent = GameEvent,
  TErrorCode extends string = StandardActionErrorCode,
> {
  readonly kind: 'turn-based'
  readonly manifest: GameManifest<TSettings>
  readonly server: TurnBasedGameServer<TState, TAction, TView, TSettings, TEvent, TErrorCode>
  readonly client: TurnBasedClientModule<TView, TAction, TSettings>
}

export interface RealtimeGameModule<
  TWorld,
  TInput,
  TSnapshot,
  TSettings,
  TEvent extends GameEvent = GameEvent,
> {
  readonly kind: 'realtime'
  readonly manifest: GameManifest<TSettings>
  readonly server: RealtimeGameServer<TWorld, TInput, TSnapshot, TSettings, TEvent>
  readonly client: RealtimeClientModule<TSnapshot, TInput, TSettings>
}

/** Either kind, generics erased. This is what the registry stores. */
export type AnyGameModule =
  | {
      readonly kind: 'turn-based'
      readonly manifest: GameManifest<unknown>
      readonly server: AnyTurnBasedGameServer
      readonly client: AnyTurnBasedClientModule
    }
  | {
      readonly kind: 'realtime'
      readonly manifest: GameManifest<unknown>
      readonly server: AnyRealtimeGameServer
      readonly client: AnyRealtimeClientModule
    }

export function isTurnBasedModule(
  module: AnyGameModule,
): module is Extract<AnyGameModule, { kind: 'turn-based' }> {
  return module.kind === 'turn-based'
}

export function isRealtimeModule(
  module: AnyGameModule,
): module is Extract<AnyGameModule, { kind: 'realtime' }> {
  return module.kind === 'realtime'
}

export class GameDefinitionError extends Error {
  constructor(
    readonly gameId: string,
    readonly problems: readonly string[],
  ) {
    super(`Invalid game module '${gameId}':\n- ${problems.join('\n- ')}`)
    this.name = 'GameDefinitionError'
  }
}

function assertModule(
  manifest: GameManifest<never>,
  server: { readonly disconnectPolicy: DisconnectPolicy },
  kind: 'turn-based' | 'realtime',
  expectedTurnModels: readonly string[],
): void {
  const problems: string[] = []

  // Cross-checks that span manifest and server, so neither can validate alone.
  // A policy of `substitute_bot` on a game with no bots strands the seat: the
  // grace window expires and the platform has nothing to put in it.
  if (server.disconnectPolicy.onGraceExpired === 'substitute_bot' && !manifest.supportsBots) {
    problems.push(
      "disconnectPolicy.onGraceExpired is 'substitute_bot' but the manifest does not set supportsBots",
    )
  }
  if (server.disconnectPolicy.graceMs < 0) {
    problems.push('disconnectPolicy.graceMs must not be negative')
  }

  if (!isContractSupported(manifest.sdkContractVersion)) {
    problems.push(
      `sdkContractVersion ${manifest.sdkContractVersion} is not supported by this SDK (expected ${SDK_CONTRACT_VERSION})`,
    )
  }
  if (!expectedTurnModels.includes(manifest.turnModel)) {
    problems.push(
      `turnModel '${manifest.turnModel}' cannot be registered as a ${kind} module (expected one of ${expectedTurnModels.join(', ')})`,
    )
  }

  const validated = validateManifest(manifest)
  if (!validated.ok) {
    for (const problem of validated.error) {
      problems.push(`${problem.path}: ${problem.message}`)
    }
  }

  if (problems.length > 0) throw new GameDefinitionError(manifest.id, problems)
}

/**
 * Declares a turn-based game.
 *
 * Validates the manifest eagerly, at import time. A bad preset or an
 * undeclared timer should break the build and CI, not the first player who
 * opens the settings dropdown.
 */
export function defineTurnBasedGame<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent = GameEvent,
  TErrorCode extends string = StandardActionErrorCode,
>(
  module: Omit<TurnBasedGameModule<TState, TAction, TView, TSettings, TEvent, TErrorCode>, 'kind'>,
): TurnBasedGameModule<TState, TAction, TView, TSettings, TEvent, TErrorCode> {
  assertModule(module.manifest as GameManifest<never>, module.server, 'turn-based', [
    'sequential',
    'simultaneous',
  ])
  return { kind: 'turn-based', ...module }
}

/**
 * Declares a real-time game. The contract is fixed in M1; the room runner that
 * drives it is M6 and board-gated.
 */
export function defineRealtimeGame<
  TWorld,
  TInput,
  TSnapshot,
  TSettings,
  TEvent extends GameEvent = GameEvent,
>(
  module: Omit<RealtimeGameModule<TWorld, TInput, TSnapshot, TSettings, TEvent>, 'kind'>,
): RealtimeGameModule<TWorld, TInput, TSnapshot, TSettings, TEvent> {
  assertModule(module.manifest as GameManifest<never>, module.server, 'realtime', ['realtime'])
  return { kind: 'realtime', ...module }
}
