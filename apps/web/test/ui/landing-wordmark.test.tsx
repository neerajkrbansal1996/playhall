import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BRAND } from '@playhall/shared'

import HomePage from '@/app/page'

/**
 * The hero's *size* is a decision of the landing page, not of `Wordmark` — the component
 * only offers `lg`, it cannot make the page ask for it. `wordmark.test.tsx` proves `lg`
 * is wired correctly and would stay green if this page reverted to `md`, so the call
 * site needs its own case.
 *
 * Why it matters enough to pin: at `md` the product name rendered at 20px in a 1280px
 * viewport, the same size as a card title, on the first screen someone sees after
 * tapping a stranger's invite. That is the regression this case exists to catch.
 */
describe('landing hero wordmark', () => {
  it('renders the product name as the h1 at lg, the landing-headline size', () => {
    render(<HomePage />)

    const hero = screen.getByRole('heading', { level: 1 })

    expect(hero).toHaveTextContent(BRAND.name)
    // --text-5xl on mobile, --text-6xl from 768px — design tokens §3's landing headline.
    expect(hero.className).toContain('text-5xl')
    expect(hero.className).toContain('md:text-6xl')
    // `md` is the landing *header bar*, not the hero. Catching the revert means
    // asserting the old value is gone, not only that the new one is present.
    expect(hero.className).not.toContain('text-xl')
  })

  it('lets the hero wrap rather than ellipsise the product name', () => {
    render(<HomePage />)

    const hero = screen.getByRole('heading', { level: 1 })
    const label = hero.lastElementChild as HTMLElement

    expect(label.textContent).toBe(BRAND.name)
    expect(label.className).not.toContain('truncate')
    expect(label.className).toContain('wrap-anywhere')
  })
})
