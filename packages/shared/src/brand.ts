/**
 * The single source of truth for user-visible product naming.
 *
 * The final product name, domain and logo are a board decision and are still
 * open (tracked on PER-2). Nothing in this repo may hard-code a brand string —
 * import from here instead, so the rename is one edit plus an env override.
 */

/** Internal codename. Not a product name; safe to ship only as a fallback. */
export const INTERNAL_CODENAME = 'Atrium'

export interface Brand {
  /** Display name used in UI copy, titles and link previews. */
  readonly name: string
  /** Primary domain, without scheme. Empty until the board decides. */
  readonly domain: string
  /** True while `name` is still the internal codename, not an approved brand. */
  readonly isProvisional: boolean
}

function readEnv(key: string): string | undefined {
  // Works in Node and in bundlers that statically inline process.env.
  const value = typeof process === 'undefined' ? undefined : process.env?.[key]
  return value && value.length > 0 ? value : undefined
}

const name = readEnv('NEXT_PUBLIC_BRAND_NAME') ?? INTERNAL_CODENAME
const domain = readEnv('NEXT_PUBLIC_BRAND_DOMAIN') ?? ''

export const BRAND: Brand = {
  name,
  domain,
  isProvisional: name === INTERNAL_CODENAME,
}
