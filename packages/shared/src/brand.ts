/**
 * The single source of truth for user-visible product naming.
 *
 * ADR-0001 §10 (rev 3). The board approved the product **name**; the domain and logo
 * are still open (tracked on PER-2). This file is the one place the approved name may
 * appear — everywhere else imports `BRAND`. Pushing the value out into per-environment
 * env vars would replace one reviewable place with four, each able to be missing, so
 * missing configuration degrades to the correct name rather than to a codename.
 */

/** Approved product name. The only literal brand string permitted in the codebase. */
export const APPROVED_NAME = 'Playhall'

/**
 * Pre-approval internal codename. No longer a fallback — it survives only as the value
 * the `isProvisional` guard compares against, so a reverted or mis-set override is caught.
 */
export const INTERNAL_CODENAME = 'Atrium'

export interface Brand {
  /** Display name used in UI copy, titles and link previews. */
  readonly name: string
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
const domain = readEnv('NEXT_PUBLIC_BRAND_DOMAIN') ?? ''

export const BRAND: Brand = {
  name,
  domain,
  isProvisional: name !== APPROVED_NAME || domain === '',
}
