/**
 * The single source of truth for user-visible product naming.
 *
 * ADR-0001 §10 (rev 3). The board approved the product **name**; the domain and logo
 * are still open (tracked on PER-2). This file is the one place the approved name may
 * appear — everywhere else imports `BRAND`. Pushing the value out into per-environment
 * env vars would replace one reviewable place with four, each able to be missing, so
 * missing configuration degrades to the correct name rather than to a codename.
 */

/**
 * Approved product name. The only literal brand string permitted in the codebase.
 *
 * Provisionally settled by the board. Trademark clearance is deferred to M5
 * ([PER-44]), so treat a rename as expected rather than exceptional — `Wordmark`
 * in `@playhall/ui` takes the name as a prop so a rename stays a one-constant change.
 */
export const APPROVED_NAME = 'Playhall'

/**
 * The one-line pitch. Lives here rather than in a component because it names nothing
 * else and a second copy of it is a second thing to forget at rename time. It is a
 * complete two-sentence string on purpose: copy that must be split across a layout
 * belongs in the layout, not stitched back together from fragments.
 */
export const TAGLINE = 'Play with friends. No downloads.'

/**
 * Pre-approval internal codename. No longer a fallback — it survives only as the value
 * the `isProvisional` guard compares against, so a reverted or mis-set override is caught.
 */
export const INTERNAL_CODENAME = 'Atrium'

export interface Brand {
  /** Display name used in UI copy, titles and link previews. */
  readonly name: string
  /** One-line pitch for the hero, the footer and link previews. */
  readonly tagline: string
  /** Primary domain, without scheme. Empty until the board decides. */
  readonly domain: string
  /** True while the brand is not fully settled: name overridden away from the approved
   * name, or the domain still undecided. */
  readonly isProvisional: boolean
}

function readEnv(key: string): string | undefined {
  // Works in Node and in bundlers that statically inline process.env.
  const value = typeof process === 'undefined' ? undefined : process.env?.[key]
  return value && value.length > 0 ? value : undefined
}

/**
 * `NEXT_PUBLIC_BRAND_NAME` is an override for environment labelling only (e.g.
 * "Playhall (staging)"). Unset is the normal case and must ship the approved name.
 */
const name = readEnv('NEXT_PUBLIC_BRAND_NAME') ?? APPROVED_NAME

/**
 * `domain` is a **label**, not an origin, and it defaults to empty for that reason.
 *
 * The planned host is not registered yet (M5, [PER-44]) and its TLD is on the browser
 * HSTS preload list, so a request to a host that is not live fails as a hard TLS error
 * with no `http` fallback and no way for the page to recover. Never build a URL from
 * this field. Derive an origin at request time from the incoming request or the platform
 * env (`http://localhost:3000` locally), and make share copy carry the link the player
 * already has rather than a reconstructed one.
 */
const domain = readEnv('NEXT_PUBLIC_BRAND_DOMAIN') ?? ''

export const BRAND: Brand = {
  name,
  tagline: TAGLINE,
  domain,
  isProvisional: name !== APPROVED_NAME || domain === '',
}
