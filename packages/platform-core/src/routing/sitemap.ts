/**
 * The sitemap, built from the registry.
 *
 * Only two things are ever indexable: the static shell and one page per
 * listed game. Rooms are **never** in the sitemap — a room URL is a private
 * invitation, and a crawler that finds it burns a code, pollutes presence and
 * hands the room to a stranger. Match pages are excluded for the same reason
 * until there is a deliberate public-replay feature.
 *
 * Because it reads the registry, a game that is flag-disabled or `hidden`
 * drops out of the sitemap at the same moment it drops out of the landing
 * grid and `/games`. That single source is the point.
 */

import type { GameRegistry } from '../registry/registry.js'
import { absoluteUrl, routes } from './routes.js'

export interface SitemapEntry {
  readonly url: string
  readonly changeFrequency: 'daily' | 'weekly' | 'monthly'
  readonly priority: number
}

export function buildSitemap(registry: GameRegistry, origin: string): readonly SitemapEntry[] {
  const entries: SitemapEntry[] = [
    { url: absoluteUrl(origin, routes.home()), changeFrequency: 'weekly', priority: 1 },
    { url: absoluteUrl(origin, routes.games()), changeFrequency: 'weekly', priority: 0.8 },
  ]

  for (const game of registry.list()) {
    // `coming-soon` games are listed on /games but must not be indexed as a
    // playable page — an indexed dead end is worse than no result at all.
    if (game.status === 'coming-soon') continue
    entries.push({
      url: absoluteUrl(origin, routes.game(game.slug)),
      changeFrequency: 'monthly',
      priority: 0.7,
    })
  }

  return entries
}

/** `robots.txt` body. Keeps crawlers out of every room and match URL. */
export function buildRobotsTxt(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /$',
    'Allow: /games',
    'Allow: /play/',
    'Disallow: /r/',
    'Disallow: /match/',
    `Sitemap: ${absoluteUrl(origin, '/sitemap.xml')}`,
    '',
  ].join('\n')
}
