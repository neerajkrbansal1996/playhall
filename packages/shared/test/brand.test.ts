import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APPROVED_NAME, INTERNAL_CODENAME } from '../src/brand.js'

/**
 * `brand.ts` resolves the brand once, at module load, from `process.env`. Every case
 * here therefore sets the environment first and re-imports through a reset module
 * registry rather than mutating an already-resolved `BRAND`.
 */
async function loadBrand(env: Record<string, string | undefined>) {
  for (const key of ['NEXT_PUBLIC_BRAND_NAME', 'NEXT_PUBLIC_BRAND_DOMAIN']) {
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value
  }
  vi.resetModules()
  const mod = await import('../src/brand.js')
  return mod.BRAND
}

describe('BRAND', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  // ADR-0001 §10 rev 3: the regression guard for the fail-open default. Before rev 3 an
  // environment with NEXT_PUBLIC_BRAND_NAME unset shipped the internal codename to a
  // player, and isProvisional flipped to false the moment the name was set correctly.
  it('defaults to the approved name with NEXT_PUBLIC_BRAND_NAME unset', async () => {
    const brand = await loadBrand({})

    expect(process.env.NEXT_PUBLIC_BRAND_NAME).toBeUndefined()
    expect(brand.name).toBe('Playhall')
    expect(brand.name).toBe(APPROVED_NAME)
    expect(brand.name).not.toBe(INTERNAL_CODENAME)
    // Still provisional: the board decided the name only, the domain is open (PER-2).
    expect(brand.domain).toBe('')
    expect(brand.isProvisional).toBe(true)
  })

  it('treats an empty NEXT_PUBLIC_BRAND_NAME as unset', async () => {
    const brand = await loadBrand({ NEXT_PUBLIC_BRAND_NAME: '' })

    expect(brand.name).toBe(APPROVED_NAME)
    expect(brand.isProvisional).toBe(true)
  })

  it('lets the env var override the name for environment labelling', async () => {
    const brand = await loadBrand({ NEXT_PUBLIC_BRAND_NAME: 'Playhall (staging)' })

    expect(brand.name).toBe('Playhall (staging)')
    expect(brand.isProvisional).toBe(true)
  })

  it('stays provisional when the name is reverted to the internal codename', async () => {
    const brand = await loadBrand({
      NEXT_PUBLIC_BRAND_NAME: INTERNAL_CODENAME,
      NEXT_PUBLIC_BRAND_DOMAIN: 'example.test',
    })

    expect(brand.name).toBe(INTERNAL_CODENAME)
    expect(brand.isProvisional).toBe(true)
  })

  it('clears isProvisional only once the name is approved and a domain is set', async () => {
    const brand = await loadBrand({ NEXT_PUBLIC_BRAND_DOMAIN: 'example.test' })

    expect(brand.name).toBe(APPROVED_NAME)
    expect(brand.domain).toBe('example.test')
    expect(brand.isProvisional).toBe(false)
  })
})
