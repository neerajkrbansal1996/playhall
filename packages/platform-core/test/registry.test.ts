import { describe, expect, it } from 'vitest'
import { RegistryLoadError, createGameRegistry } from '../src/registry/registry.js'
import { createFeatureFlags } from '../src/flags.js'
import { brokenRegistration, makeGame, registrationFor } from './fixtures/games.js'

const flags = createFeatureFlags()

async function registryOf(...modules: ReturnType<typeof makeGame>[]) {
  return createGameRegistry({ registrations: modules.map(registrationFor), flags })
}

describe('loading', () => {
  it('builds a catalogue from dynamic-import thunks, never from a game import', async () => {
    const registry = await registryOf(makeGame({ slug: 'zeta' }), makeGame({ slug: 'alpha' }))
    expect(registry.list().map((entry) => entry.slug)).toEqual(['alpha', 'zeta'])
    expect(registry.problems).toEqual([])
  })

  it('exposes the JSON-safe catalogue entry, with no live zod schema on it', async () => {
    const registry = await registryOf(makeGame({ slug: 'alpha' }))
    const entry = registry.entry('alpha')
    expect(entry).not.toBeNull()
    expect(entry).not.toHaveProperty('settingsSchema')
    expect(() => JSON.stringify(entry)).not.toThrow()
  })

  it('keeps the live module available server-side', async () => {
    const registry = await registryOf(makeGame({ slug: 'alpha' }))
    expect(registry.module('alpha')?.manifest.slug).toBe('alpha')
    expect(registry.module('nope')).toBeNull()
  })

  it('resolves a game by id, which is how a room code finds its game', async () => {
    const registry = await registryOf(makeGame({ slug: 'alpha', id: 'game-alpha' }))
    expect(registry.entryById('game-alpha')?.slug).toBe('alpha')
    expect(registry.entryById('missing')).toBeNull()
  })
})

describe('bad registrations', () => {
  it('fails startup when a game cannot be imported', async () => {
    await expect(
      createGameRegistry({ registrations: [brokenRegistration('alpha')], flags }),
    ).rejects.toBeInstanceOf(RegistryLoadError)
  })

  it('boots without the broken game when strict is off', async () => {
    const registry = await createGameRegistry({
      registrations: [
        brokenRegistration('alpha', 'syntax error'),
        registrationFor(makeGame({ slug: 'beta' })),
      ],
      flags,
      strict: false,
    })
    expect(registry.list().map((entry) => entry.slug)).toEqual(['beta'])
    expect(registry.problems).toHaveLength(1)
    expect(registry.problems[0]).toMatchObject({ slug: 'alpha' })
    expect(registry.problems[0]?.message).toContain('syntax error')
  })

  it('rejects a registration whose slug disagrees with its manifest', async () => {
    const registry = await createGameRegistry({
      registrations: [
        { slug: 'wrong', load: async () => ({ default: makeGame({ slug: 'alpha' }) }) },
      ],
      flags,
      strict: false,
    })
    expect(registry.problems[0]?.message).toMatch(/does not match manifest slug/)
    expect(registry.list()).toEqual([])
  })

  it('rejects a duplicate slug', async () => {
    const registry = await createGameRegistry({
      registrations: [
        registrationFor(makeGame({ slug: 'alpha' })),
        registrationFor(makeGame({ slug: 'alpha', id: 'other' })),
      ],
      flags,
      strict: false,
    })
    expect(registry.problems[0]?.message).toMatch(/duplicate slug/)
    expect(registry.list()).toHaveLength(1)
  })

  it('rejects a duplicate game id under a different slug', async () => {
    const registry = await createGameRegistry({
      registrations: [
        registrationFor(makeGame({ slug: 'alpha', id: 'shared' })),
        registrationFor(makeGame({ slug: 'beta', id: 'shared' })),
      ],
      flags,
      strict: false,
    })
    expect(registry.problems[0]?.message).toMatch(/already registered by 'alpha'/)
  })

  it('re-validates the manifest even though define() already did', async () => {
    const module = makeGame({ slug: 'alpha' })
    // Simulates a module built against a different SDK copy, or hand-rolled.
    const tampered = { ...module, manifest: { ...module.manifest, maxPlayers: 1, minPlayers: 4 } }
    const registry = await createGameRegistry({
      registrations: [{ slug: 'alpha', load: async () => ({ default: tampered }) }],
      flags,
      strict: false,
    })
    expect(registry.problems[0]?.message).toMatch(/invalid manifest/)
  })
})

describe('visibility — one source for the grid, /games, the sitemap and flags', () => {
  it('hides a game whose feature flag is off', async () => {
    const registry = await createGameRegistry({
      registrations: [makeGame({ slug: 'alpha' }), makeGame({ slug: 'beta' })].map(registrationFor),
      flags: createFeatureFlags({ games: { beta: false } }),
    })
    expect(registry.list().map((entry) => entry.slug)).toEqual(['alpha'])
    expect(registry.isPlayable('beta')).toBe(false)
    // Still resolvable by id, so an existing room does not become unjoinable
    // the moment a flag flips — that is the sweeper's job, not the grid's.
    expect(registry.entry('beta')).not.toBeNull()
  })

  it('can include flagged-off games for an admin surface', async () => {
    const registry = await createGameRegistry({
      registrations: [registrationFor(makeGame({ slug: 'beta' }))],
      flags: createFeatureFlags({ games: { beta: false } }),
    })
    expect(registry.list({ includeFlagged: true }).map((entry) => entry.slug)).toEqual(['beta'])
  })

  it('never lists a hidden game, but does list a coming-soon one', async () => {
    const registry = await registryOf(
      makeGame({ slug: 'secret', status: 'hidden' }),
      makeGame({ slug: 'soon', status: 'coming-soon' }),
      makeGame({ slug: 'live-one', status: 'live' }),
    )
    expect(registry.list().map((entry) => entry.slug)).toEqual(['live-one', 'soon'])
    expect(registry.list({ includeHidden: true }).map((entry) => entry.slug)).toEqual([
      'live-one',
      'secret',
      'soon',
    ])
  })

  it('treats only live and beta as playable', async () => {
    const registry = await registryOf(
      makeGame({ slug: 'a', status: 'live' }),
      makeGame({ slug: 'b', status: 'beta' }),
      makeGame({ slug: 'c', status: 'coming-soon' }),
      makeGame({ slug: 'd', status: 'hidden' }),
    )
    expect(['a', 'b', 'c', 'd', 'missing'].map((slug) => registry.isPlayable(slug))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ])
  })
})
