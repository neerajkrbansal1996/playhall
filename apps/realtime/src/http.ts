/**
 * Small HTTP helpers, kept out of `index.ts` so they are importable by a test
 * without booting a server as a side effect.
 */

/**
 * Path without the query string or fragment. `undefined` and empty urls become
 * `/`.
 *
 * Routing on `req.url` instead treats `/health?x=1` as a different route from
 * `/health` and 404s it — and something always appends a query string: a share
 * link, an analytics tag, a cache buster.
 */
export function pathOf(url: string | undefined): string {
  if (!url) return '/'
  const queryAt = url.indexOf('?')
  const hashAt = url.indexOf('#')
  const end = Math.min(queryAt === -1 ? url.length : queryAt, hashAt === -1 ? url.length : hashAt)
  return url.slice(0, end) || '/'
}
