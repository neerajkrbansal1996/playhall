import { describe, expect, it } from 'vitest'
import { absoluteUrl, parseRoute, routes } from '../src/routing/routes.js'
import { buildRobotsTxt, buildSitemap } from '../src/routing/sitemap.js'
import { createGameRegistry } from '../src/registry/registry.js'
import { createFeatureFlags } from '../src/flags.js'
import { makeGame, registrationFor } from './fixtures/games.js'

describe('builders', () => {
  it('produce the agreed shapes', () => {
    expect(routes.home()).toBe('/')
    expect(routes.games()).toBe('/games')
    expect(routes.game('tic-tac-toe')).toBe('/play/tic-tac-toe')
    expect(routes.newRoom('tic-tac-toe')).toBe('/play/tic-tac-toe/new')
    expect(routes.room('ABC234')).toBe('/r/ABC234')
    expect(routes.match('m-1')).toBe('/match/m-1')
    expect(routes.roomNotFound()).toBe('/r/not-found')
    expect(routes.roomNotFound('expired')).toBe('/r/not-found?reason=expired')
  })

  it('always emit the canonical upper-case code', () => {
    expect(routes.room('abc234')).toBe('/r/ABC234')
  })

  it('build an absolute share URL without a double slash', () => {
    expect(absoluteUrl('https://example.test', '/r/ABC234')).toBe('https://example.test/r/ABC234')
    expect(absoluteUrl('https://example.test/', '/r/ABC234')).toBe('https://example.test/r/ABC234')
  })
})

describe('parsing', () => {
  it('round-trips every builder', () => {
    expect(parseRoute(routes.home())).toEqual({ name: 'home' })
    expect(parseRoute(routes.games())).toEqual({ name: 'games' })
    expect(parseRoute(routes.game('chess'))).toEqual({ name: 'game', slug: 'chess' })
    expect(parseRoute(routes.newRoom('chess'))).toEqual({ name: 'newRoom', slug: 'chess' })
    expect(parseRoute(routes.match('m-1'))).toEqual({ name: 'match', matchId: 'm-1' })
    expect(parseRoute(routes.room('ABC234'))).toEqual({
      name: 'room',
      code: 'ABC234',
      redirectTo: null,
    })
  })

  it('tolerates a trailing slash and a query string', () => {
    expect(parseRoute('/games/')).toEqual({ name: 'games' })
    expect(parseRoute('/play/chess/?utm_source=whatsapp')).toEqual({ name: 'game', slug: 'chess' })
  })

  it('accepts a shared link in any case and asks for a canonical redirect', () => {
    expect(parseRoute('/r/abc234')).toEqual({
      name: 'room',
      code: 'ABC234',
      redirectTo: '/r/ABC234',
    })
    expect(parseRoute('/r/abc-234')).toEqual({
      name: 'room',
      code: 'ABC234',
      redirectTo: '/r/ABC234',
    })
  })

  it('sends an unusable code to the friendly not-found path', () => {
    expect(parseRoute('/r/nope')).toEqual({ name: 'roomNotFound' })
    expect(parseRoute('/r/ABCO34')).toEqual({ name: 'roomNotFound' })
    expect(parseRoute('/r/not-found')).toEqual({ name: 'roomNotFound' })
  })

  it('is strict about slugs, because we generate them', () => {
    expect(parseRoute('/play/Chess')).toEqual({ name: 'unknown' })
    expect(parseRoute('/play/chess/start')).toEqual({ name: 'unknown' })
    expect(parseRoute('/play')).toEqual({ name: 'unknown' })
  })

  it('rejects anything it does not recognise', () => {
    expect(parseRoute('/nope')).toEqual({ name: 'unknown' })
    expect(parseRoute('/match')).toEqual({ name: 'unknown' })
    expect(parseRoute('/games/extra')).toEqual({ name: 'unknown' })
  })

  it('handles a percent-encoded segment', () => {
    expect(parseRoute('/match/m%2F1')).toEqual({ name: 'match', matchId: 'm/1' })
  })
})

describe('sitemap', () => {
  const flags = createFeatureFlags()

  it('lists the shell and one page per indexable game, and no rooms', async () => {
    const registry = await createGameRegistry({
      registrations: [
        makeGame({ slug: 'alpha' }),
        makeGame({ slug: 'soon', status: 'coming-soon' }),
        makeGame({ slug: 'secret', status: 'hidden' }),
      ].map(registrationFor),
      flags,
    })
    const urls = buildSitemap(registry, 'https://example.test').map((entry) => entry.url)
    expect(urls).toEqual([
      'https://example.test/',
      'https://example.test/games',
      'https://example.test/play/alpha',
    ])
    expect(urls.some((url) => url.includes('/r/'))).toBe(false)
    expect(urls.some((url) => url.includes('/match/'))).toBe(false)
  })

  it('drops a game the moment its flag turns off, same as the grid', async () => {
    const registrations = [makeGame({ slug: 'alpha' }), makeGame({ slug: 'beta' })].map(
      registrationFor,
    )
    const on = await createGameRegistry({ registrations, flags })
    const off = await createGameRegistry({
      registrations,
      flags: createFeatureFlags({ games: { beta: false } }),
    })
    expect(buildSitemap(on, 'https://x.test')).toHaveLength(4)
    expect(buildSitemap(off, 'https://x.test')).toHaveLength(3)
  })
})

describe('robots.txt', () => {
  it('keeps crawlers out of rooms and matches', () => {
    const body = buildRobotsTxt('https://example.test')
    expect(body).toContain('Disallow: /r/')
    expect(body).toContain('Disallow: /match/')
    expect(body).toContain('Sitemap: https://example.test/sitemap.xml')
  })
})
