import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type GameManifest,
  gameManifestSchema,
  supportsPlayerCount,
  toCatalogEntry,
  validateManifest,
} from '../src/manifest.js'
import { manifest as ticTacToe } from './fixtures/tic-tac-toe.js'
import { manifest as tagArena } from './fixtures/tag-arena.js'

const settingsSchema = z.object({ rounds: z.number().int().min(1).max(10) })
type Settings = z.infer<typeof settingsSchema>

function baseManifest(overrides: Partial<GameManifest<Settings>> = {}): GameManifest<Settings> {
  return {
    id: 'sample',
    slug: 'sample',
    name: 'Sample',
    shortDescription: 'A sample game.',
    thumbnail: 'assets/thumb.png',
    category: 'board',
    minPlayers: 2,
    maxPlayers: 4,
    teams: 'none',
    turnModel: 'sequential',
    hasHiddenInformation: false,
    usesRandomness: false,
    supportsSpectators: true,
    supportsBots: false,
    settingsSchema,
    defaultSettings: { rounds: 3 },
    presets: [{ id: 'quick', label: 'Quick', settings: { rounds: 1 }, isDefault: true }],
    timers: [{ id: 'turn', kind: 'turn', description: 'Turn clock.', pausesOnDisconnect: true }],
    status: 'live',
    version: '1.0.0',
    sdkContractVersion: 1,
    ...overrides,
  }
}

function problemPaths(manifest: GameManifest<Settings>): string[] {
  const result = validateManifest(manifest)
  return result.ok ? [] : result.error.map((problem) => problem.path)
}

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    const result = validateManifest(baseManifest())
    expect(result.ok).toBe(true)
  })

  it('accepts both shipped fixtures', () => {
    expect(validateManifest(ticTacToe).ok).toBe(true)
    expect(validateManifest(tagArena).ok).toBe(true)
  })

  it('rejects maxPlayers below minPlayers', () => {
    expect(problemPaths(baseManifest({ minPlayers: 4, maxPlayers: 2 }))).toContain('maxPlayers')
  })

  it('rejects a non-kebab-case slug', () => {
    expect(problemPaths(baseManifest({ slug: 'Not Kebab' }))).toContain('slug')
  })

  it('rejects a non-semver version', () => {
    expect(problemPaths(baseManifest({ version: '1.0' }))).toContain('version')
  })

  it("requires a realtime profile when turnModel is 'realtime'", () => {
    expect(problemPaths(baseManifest({ turnModel: 'realtime' }))).toContain('realtime')
  })

  it('rejects a realtime profile on a turn-based game', () => {
    const manifest = baseManifest({
      realtime: {
        tickRate: 30,
        snapshotRate: 15,
        requires3D: false,
        assetBundleSizeKb: 10,
        supportedInputs: ['pointer'],
        minClientSpec: { webgl2: false },
      },
    })
    expect(problemPaths(manifest)).toContain('realtime')
  })

  it('rejects snapshotRate above tickRate', () => {
    const result = realtimeProfileResult(60, 30)
    expect(result.success).toBe(true)
    expect(realtimeProfileResult(30, 60).success).toBe(false)
  })

  it('requires teamCount for fixed teams, and rejects it otherwise', () => {
    expect(problemPaths(baseManifest({ teams: 'fixed' }))).toContain('teamCount')
    expect(problemPaths(baseManifest({ teams: 'none', teamCount: 2 }))).toContain('teamCount')
    expect(validateManifest(baseManifest({ teams: 'fixed', teamCount: 2 })).ok).toBe(true)
  })

  it('rejects a team count that does not divide the seat count', () => {
    expect(problemPaths(baseManifest({ teams: 'fixed', teamCount: 3, maxPlayers: 4 }))).toContain(
      'teamCount',
    )
  })

  it('rejects duplicate timer ids', () => {
    const timers = [
      { id: 'turn', kind: 'turn' as const, description: 'a', pausesOnDisconnect: true },
      { id: 'turn', kind: 'phase' as const, description: 'b', pausesOnDisconnect: true },
    ]
    expect(problemPaths(baseManifest({ timers }))).toContain('timers.1.id')
  })

  it('rejects defaultSettings that fail settingsSchema', () => {
    const manifest = baseManifest({ defaultSettings: { rounds: 99 } as Settings })
    expect(problemPaths(manifest)).toContain('defaultSettings')
  })

  it('rejects a preset that fails settingsSchema', () => {
    const manifest = baseManifest({
      presets: [{ id: 'broken', label: 'Broken', settings: { rounds: 0 } as Settings }],
    })
    expect(problemPaths(manifest)).toContain('presets.0.settings')
  })

  it('rejects duplicate preset ids and more than one default preset', () => {
    const manifest = baseManifest({
      presets: [
        { id: 'a', label: 'A', settings: { rounds: 1 }, isDefault: true },
        { id: 'a', label: 'B', settings: { rounds: 2 }, isDefault: true },
      ],
    })
    const paths = problemPaths(manifest)
    expect(paths).toContain('presets.1.id')
    expect(paths).toContain('presets')
  })

  it('reports structural problems from the zod schema', () => {
    const manifest = baseManifest({ shortDescription: '' })
    expect(problemPaths(manifest)).toContain('shortDescription')
  })
})

function realtimeProfileResult(tickRate: number, snapshotRate: number) {
  return gameManifestSchema.shape.realtime.safeParse({
    tickRate,
    snapshotRate,
    requires3D: false,
    assetBundleSizeKb: 0,
    supportedInputs: ['pointer'],
    minClientSpec: { webgl2: false },
  })
}

describe('toCatalogEntry', () => {
  it('drops the zod schema and survives a JSON round trip', () => {
    const entry = toCatalogEntry(ticTacToe)
    expect(entry).not.toHaveProperty('settingsSchema')
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry)
  })

  it('normalises optionals to null/false rather than omitting them', () => {
    const entry = toCatalogEntry(baseManifest())
    expect(entry.teamCount).toBeNull()
    expect(entry.realtime).toBeNull()
    expect(entry.presets[0]?.description).toBeNull()
    expect(entry.presets[0]?.isDefault).toBe(true)
  })

  it('carries the realtime profile through for a real-time game', () => {
    const entry = toCatalogEntry(tagArena)
    expect(entry.realtime?.tickRate).toBe(30)
    expect(entry.realtime?.requires3D).toBe(true)
  })
})

describe('supportsPlayerCount', () => {
  it('is inclusive of both bounds', () => {
    const manifest = baseManifest() as unknown as GameManifest<never>
    expect(supportsPlayerCount(manifest, 1)).toBe(false)
    expect(supportsPlayerCount(manifest, 2)).toBe(true)
    expect(supportsPlayerCount(manifest, 4)).toBe(true)
    expect(supportsPlayerCount(manifest, 5)).toBe(false)
  })
})
