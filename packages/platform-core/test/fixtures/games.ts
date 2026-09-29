/**
 * Fake game modules for platform-core tests.
 *
 * Deliberately *not* tic-tac-toe. The point of these tests is that core
 * branches on manifest fields and never on a game, so the fixtures vary the
 * fields that matter — seat count, spectator support, status — and their
 * rules are a stub. If a test here ever needed a real game to pass, that
 * would itself be the bug.
 */

import {
  DEFAULT_DISCONNECT_POLICY,
  SDK_CONTRACT_VERSION,
  type AnyGameModule,
  type GameManifest,
  type GameStatus,
  type MatchResult,
  defineTurnBasedGame,
} from '@playhall/game-sdk'
import { z } from 'zod'

const settingsSchema = z.object({
  boardSize: z.number().int().min(3).max(5),
  timed: z.boolean(),
})
type Settings = z.infer<typeof settingsSchema>

interface State {
  readonly moves: number
}
const actionSchema = z.object({ kind: z.literal('noop') })
type Action = z.infer<typeof actionSchema>

export interface FakeGameOptions {
  readonly slug: string
  readonly id?: string
  readonly name?: string
  readonly status?: GameStatus
  readonly supportsSpectators?: boolean
  readonly minPlayers?: number
  readonly maxPlayers?: number
  readonly version?: string
}

export function makeGame(options: FakeGameOptions): AnyGameModule {
  const manifest: GameManifest<Settings> = {
    id: options.id ?? options.slug,
    slug: options.slug,
    name: options.name ?? options.slug,
    shortDescription: `test fixture for ${options.slug}`,
    thumbnail: 'thumb.png',
    category: 'board',
    minPlayers: options.minPlayers ?? 2,
    maxPlayers: options.maxPlayers ?? 2,
    teams: 'none',
    turnModel: 'sequential',
    hasHiddenInformation: false,
    usesRandomness: false,
    supportsSpectators: options.supportsSpectators ?? true,
    supportsBots: false,
    settingsSchema,
    defaultSettings: { boardSize: 3, timed: false },
    presets: [
      {
        id: 'classic',
        label: 'Classic',
        settings: { boardSize: 3, timed: false },
        isDefault: true,
      },
      { id: 'big', label: 'Big board', settings: { boardSize: 5, timed: true } },
    ],
    timers: [],
    status: options.status ?? 'live',
    version: options.version ?? '1.0.0',
    sdkContractVersion: SDK_CONTRACT_VERSION,
  }

  return defineTurnBasedGame<State, Action, State, Settings>({
    manifest,
    server: {
      actionSchema,
      createInitialState: () => ({ state: { moves: 0 }, events: [] }),
      validateAction: () => ({ ok: true }),
      applyAction: (_ctx, state) => ({ state: { moves: state.moves + 1 }, events: [] }),
      getViewFor: (state) => state,
      disconnectPolicy: DEFAULT_DISCONNECT_POLICY,
      getResult: (): MatchResult | null => null,
    },
    client: {
      GameView: () => Promise.resolve({ default: () => null }),
    },
  }) as unknown as AnyGameModule
}

/** A registration whose dynamic import resolves to an already-built module. */
export function registrationFor(module: AnyGameModule) {
  return { slug: module.manifest.slug, load: async () => ({ default: module }) }
}

/** A registration whose import throws, to exercise the broken-game path. */
export function brokenRegistration(slug: string, message = 'boom') {
  return {
    slug,
    load: async (): Promise<{ default: AnyGameModule }> => {
      throw new Error(message)
    },
  }
}
