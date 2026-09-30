/**
 * Contract-level tests: errors, events, timers, results, seats, viewers,
 * versioning and `defineTurnBasedGame` / `defineRealtimeGame`.
 */

import { describe, expect, it } from 'vitest'
import {
  STANDARD_ACTION_ERROR_CODES,
  VALID,
  err,
  invalid,
  isStandardActionErrorCode,
  ok,
} from '../src/errors.js'
import {
  PUBLIC,
  SERVER_ONLY,
  SPECTATORS_ONLY,
  audienceIncludesSeat,
  audienceIncludesSpectators,
  toSeats,
} from '../src/events.js'
import { asGameId, asSeatId, asTeamId, asTimerId } from '../src/ids.js'
import { findSeat, seatIds, teamSeats } from '../src/seats.js'
import type { Seat } from '../src/seats.js'
import { clearTimer, pauseTimer, resumeTimer, setTimer } from '../src/timers.js'
import { REPLAY, SPECTATOR, seatViewer, viewerSeatId } from '../src/viewer.js'
import { RESULT_REASONS, drawStandings, standingsFromWinners } from '../src/result.js'
import {
  SDK_CONTRACT_VERSION,
  SDK_VERSION,
  checkVersionPin,
  compareSemver,
  isContractSupported,
  isSemver,
  parseSemver,
} from '../src/versioning.js'
import {
  GameDefinitionError,
  defineRealtimeGame,
  isRealtimeModule,
  isTurnBasedModule,
} from '../src/define.js'
import { ticTacToeModule } from './fixtures/tic-tac-toe.module.js'
import { manifest as tagArenaManifest, server as tagArenaServer } from './fixtures/tag-arena.js'

const seatA = asSeatId('seat-a')
const seatB = asSeatId('seat-b')

describe('results and errors', () => {
  it('ok/err wrap values on the expected branch', () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 })
    expect(err('boom')).toEqual({ ok: false, error: 'boom' })
  })

  it('VALID is the shared success value', () => {
    expect(VALID.ok).toBe(true)
    expect(Object.isFrozen(VALID)).toBe(true)
  })

  it('invalid carries a code, a developer message and params', () => {
    const rejection = invalid('illegal_action', 'cell taken', { cell: 4 })
    expect(rejection.ok).toBe(false)
    expect(rejection.error).toEqual({
      code: 'illegal_action',
      message: 'cell taken',
      params: { cell: 4 },
    })
  })

  it('recognises standard codes and rejects invented ones', () => {
    for (const code of STANDARD_ACTION_ERROR_CODES) {
      expect(isStandardActionErrorCode(code)).toBe(true)
    }
    expect(isStandardActionErrorCode('en_passant_impossible')).toBe(false)
  })
})

describe('event audiences', () => {
  it('public reaches seats and spectators', () => {
    expect(audienceIncludesSeat(PUBLIC, seatA)).toBe(true)
    expect(audienceIncludesSpectators(PUBLIC)).toBe(true)
  })

  it('a seat audience excludes other seats and all spectators', () => {
    const audience = toSeats(seatA)
    expect(audienceIncludesSeat(audience, seatA)).toBe(true)
    expect(audienceIncludesSeat(audience, seatB)).toBe(false)
    // The important one: a private event must not leak through the spectator
    // stream, which a player can open in a second tab.
    expect(audienceIncludesSpectators(audience)).toBe(false)
  })

  it('a spectators audience excludes every seat', () => {
    expect(audienceIncludesSeat(SPECTATORS_ONLY, seatA)).toBe(false)
    expect(audienceIncludesSpectators(SPECTATORS_ONLY)).toBe(true)
  })

  it('server-only reaches nobody', () => {
    expect(audienceIncludesSeat(SERVER_ONLY, seatA)).toBe(false)
    expect(audienceIncludesSpectators(SERVER_ONLY)).toBe(false)
  })
})

describe('timer commands', () => {
  const timer = asTimerId('turn')

  it('builds set/clear/pause/resume commands', () => {
    expect(setTimer(timer, 5_000, seatA)).toEqual({
      op: 'set',
      timerId: timer,
      seatId: seatA,
      delayMs: 5_000,
    })
    expect(setTimer(timer, 1_000).seatId).toBeNull()
    expect(clearTimer(timer)).toEqual({ op: 'clear', timerId: timer })
    expect(pauseTimer(timer)).toEqual({ op: 'pause', timerId: timer })
    expect(resumeTimer(timer)).toEqual({ op: 'resume', timerId: timer })
  })
})

describe('seats', () => {
  const roster: Seat[] = [
    { seatId: seatA, index: 0, teamId: asTeamId('red'), occupant: null },
    { seatId: seatB, index: 1, teamId: asTeamId('blue'), occupant: null },
  ]

  it('finds, lists and groups seats', () => {
    expect(findSeat(roster, seatA)?.index).toBe(0)
    expect(findSeat(roster, asSeatId('nope'))).toBeUndefined()
    expect(seatIds(roster)).toEqual([seatA, seatB])
    expect(teamSeats(roster, asTeamId('red'))).toHaveLength(1)
  })
})

describe('viewers', () => {
  it('only a seat viewer has a seat id', () => {
    expect(viewerSeatId(seatViewer(seatA))).toBe(seatA)
    expect(viewerSeatId(SPECTATOR)).toBeNull()
    expect(viewerSeatId(REPLAY)).toBeNull()
  })
})

describe('standings helpers', () => {
  it('ranks winners first and losers second', () => {
    expect(standingsFromWinners([seatA, seatB], [seatA])).toEqual([
      { seatId: seatA, rank: 1, outcome: 'win' },
      { seatId: seatB, rank: 2, outcome: 'loss' },
    ])
  })

  it('gives every seat rank 1 in a draw', () => {
    expect(drawStandings([seatA, seatB]).every((s) => s.rank === 1 && s.outcome === 'draw')).toBe(
      true,
    )
  })

  it('exposes the reason vocabulary', () => {
    expect(RESULT_REASONS).toContain('disconnect_forfeit')
    expect(RESULT_REASONS).toContain('aborted')
  })
})

describe('versioning', () => {
  it('parses and rejects semver', () => {
    expect(parseSemver('1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3 })
    expect(parseSemver('1.2.3-rc.1')).toMatchObject({ prerelease: 'rc.1' })
    expect(parseSemver('1.2.3+build.5')).toMatchObject({ build: 'build.5' })
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('01.2.3')).toBeNull()
    expect(isSemver(SDK_VERSION)).toBe(true)
  })

  it('orders versions, with a prerelease below its release', () => {
    const v = (value: string) => parseSemver(value)!
    expect(compareSemver(v('1.0.0'), v('2.0.0'))).toBeLessThan(0)
    expect(compareSemver(v('1.2.0'), v('1.1.9'))).toBeGreaterThan(0)
    expect(compareSemver(v('1.0.1'), v('1.0.0'))).toBeGreaterThan(0)
    expect(compareSemver(v('1.0.0-rc.1'), v('1.0.0'))).toBeLessThan(0)
    expect(compareSemver(v('1.0.0'), v('1.0.0-rc.1'))).toBeGreaterThan(0)
    expect(compareSemver(v('1.0.0-rc.1'), v('1.0.0-rc.2'))).toBeLessThan(0)
    expect(compareSemver(v('1.0.0-rc.2'), v('1.0.0-rc.1'))).toBeGreaterThan(0)
    expect(compareSemver(v('1.0.0'), v('1.0.0'))).toBe(0)
    expect(compareSemver(v('1.0.0-rc.1'), v('1.0.0-rc.1'))).toBe(0)
  })

  it('pins a match to an exact version', () => {
    const pin = { gameId: 'chess', version: '1.2.0', sdkContractVersion: 1 }
    expect(
      checkVersionPin(pin, { gameId: 'chess', version: '1.2.0', sdkContractVersion: 1 }).ok,
    ).toBe(true)

    // A patch bump must not silently take over a live match.
    const patched = checkVersionPin(pin, {
      gameId: 'chess',
      version: '1.2.1',
      sdkContractVersion: 1,
    })
    expect(patched.ok).toBe(false)
    expect(patched.ok === false && patched.error.code).toBe('version_mismatch')
  })

  it('reports contract and game mismatches distinctly', () => {
    const pin = { gameId: 'chess', version: '1.2.0', sdkContractVersion: 1 }
    const contract = checkVersionPin(pin, {
      gameId: 'chess',
      version: '1.2.0',
      sdkContractVersion: 2,
    })
    expect(contract.ok === false && contract.error.code).toBe('contract_mismatch')

    const game = checkVersionPin(pin, {
      gameId: 'checkers',
      version: '1.2.0',
      sdkContractVersion: 1,
    })
    expect(game.ok === false && game.error.code).toBe('game_mismatch')
  })

  it('supports only the current contract major', () => {
    expect(isContractSupported(SDK_CONTRACT_VERSION)).toBe(true)
    expect(isContractSupported(SDK_CONTRACT_VERSION + 1)).toBe(false)
  })
})

describe('defineTurnBasedGame / defineRealtimeGame', () => {
  it('tags the module kind and narrows it', () => {
    expect(ticTacToeModule.kind).toBe('turn-based')
    expect(isTurnBasedModule(ticTacToeModule)).toBe(true)
    expect(isRealtimeModule(ticTacToeModule)).toBe(false)
  })

  it('keeps the client component lazy', async () => {
    expect(typeof ticTacToeModule.client.GameView).toBe('function')
    const loaded = await ticTacToeModule.client.GameView()
    expect(typeof loaded.default).toBe('function')
  })

  it('accepts a real-time module', () => {
    const module = defineRealtimeGame({
      manifest: tagArenaManifest,
      server: tagArenaServer,
      client: {
        GameScene: () => Promise.resolve({ default: () => 'scene' }),
        HUD: () => Promise.resolve({ default: () => 'hud' }),
      },
    })
    expect(isRealtimeModule(module)).toBe(true)
  })

  it('throws at import time on an invalid manifest', () => {
    expect(() =>
      defineRealtimeGame({
        // A realtime turnModel with no realtime profile.
        manifest: { ...tagArenaManifest, realtime: undefined },
        server: tagArenaServer,
        client: {
          GameScene: () => Promise.resolve({ default: () => 'scene' }),
          HUD: () => Promise.resolve({ default: () => 'hud' }),
        },
      }),
    ).toThrow(GameDefinitionError)
  })

  it('refuses to register a turn model against the wrong runner', () => {
    expect(() =>
      defineRealtimeGame({
        manifest: { ...tagArenaManifest, turnModel: 'sequential', realtime: undefined },
        server: tagArenaServer,
        client: {
          GameScene: () => Promise.resolve({ default: () => 'scene' }),
          HUD: () => Promise.resolve({ default: () => 'hud' }),
        },
      }),
    ).toThrow(/cannot be registered as a realtime module/)
  })

  it('refuses a substitute_bot policy on a game without bots', () => {
    // Manifest and server each look fine alone; only the pair is wrong, which
    // is why this check lives in define() and not in validateManifest().
    expect(() =>
      defineRealtimeGame({
        manifest: { ...tagArenaManifest, supportsBots: false },
        server: {
          ...tagArenaServer,
          disconnectPolicy: {
            ...tagArenaServer.disconnectPolicy,
            onGraceExpired: 'substitute_bot',
          },
        },
        client: {
          GameScene: () => Promise.resolve({ default: () => 'scene' }),
          HUD: () => Promise.resolve({ default: () => 'hud' }),
        },
      }),
    ).toThrow(/does not set supportsBots/)
  })

  it('refuses a negative grace window', () => {
    expect(() =>
      defineRealtimeGame({
        manifest: tagArenaManifest,
        server: {
          ...tagArenaServer,
          disconnectPolicy: { ...tagArenaServer.disconnectPolicy, graceMs: -1 },
        },
        client: {
          GameScene: () => Promise.resolve({ default: () => 'scene' }),
          HUD: () => Promise.resolve({ default: () => 'hud' }),
        },
      }),
    ).toThrow(/graceMs must not be negative/)
  })

  it('lists every problem at once, not just the first', () => {
    try {
      defineRealtimeGame({
        manifest: { ...tagArenaManifest, sdkContractVersion: 99, slug: 'Bad Slug' },
        server: tagArenaServer,
        client: {
          GameScene: () => Promise.resolve({ default: () => 'scene' }),
          HUD: () => Promise.resolve({ default: () => 'hud' }),
        },
      })
      expect.unreachable('expected a GameDefinitionError')
    } catch (error) {
      expect(error).toBeInstanceOf(GameDefinitionError)
      expect((error as GameDefinitionError).problems.length).toBeGreaterThan(1)
      expect((error as GameDefinitionError).gameId).toBe('tag-arena')
    }
  })

  it('refuses an unsupported SDK contract version', () => {
    expect(() =>
      defineRealtimeGame({
        manifest: { ...tagArenaManifest, sdkContractVersion: 99 },
        server: tagArenaServer,
        client: {
          GameScene: () => Promise.resolve({ default: () => 'scene' }),
          HUD: () => Promise.resolve({ default: () => 'hud' }),
        },
      }),
    ).toThrow(/sdkContractVersion 99 is not supported/)
  })
})

describe('id brands', () => {
  it('are strings at runtime', () => {
    expect(asGameId('chess')).toBe('chess')
    expect(asSeatId('s1')).toBe('s1')
  })
})
