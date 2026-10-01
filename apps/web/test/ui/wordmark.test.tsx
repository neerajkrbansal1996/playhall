import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BRAND } from '@playhall/shared'
import { Wordmark } from '@playhall/ui'

/**
 * `Wordmark` lives in `@playhall/ui`, but its contract is only interesting from the
 * consumer side — the whole point of the component is that the name crosses the package
 * boundary as a prop — so the cases live with the consumer that has React, jsdom and
 * Testing Library already wired.
 *
 * jsdom does no layout, so nothing here can prove "shrinks, never clips or wraps". That
 * claim is proven by `/dev/wordmark` shot at 390px with a 4-character and a
 * 14-character name; these cases pin the parts a screenshot cannot re-check on every
 * run: that the name is text from the prop, that no brand literal leaked into the
 * component, and that the shrink classes are still present.
 */
/**
 * Render at one size and hand back the root's class list.
 *
 * A function per size rather than an array of roots: `noUncheckedIndexedAccess` is on, so
 * destructuring a mapped array hands back `HTMLElement | undefined` and the cases would
 * have to assert away a `possibly undefined` that cannot happen. It also keeps each
 * expectation pinned to its own size, which is the thing being tested.
 */
function rootClassAt(size: 'sm' | 'md' | 'lg'): string {
  const { container } = render(<Wordmark name={BRAND.name} size={size} />)
  return (container.firstElementChild as HTMLElement).className
}

describe('Wordmark', () => {
  it('renders an arbitrary name — the component holds no brand string of its own', () => {
    // If `Wordmark` ever imported BRAND or hard-coded a name, this case is what fails.
    render(<Wordmark name="Rename Me 14ch" />)

    expect(screen.getByText('Rename Me 14ch')).toBeInTheDocument()
    expect(screen.queryByText(BRAND.name)).not.toBeInTheDocument()
  })

  it('renders a 4-character name whole', () => {
    render(<Wordmark name="Yard" />)

    expect(screen.getByText('Yard')).toBeInTheDocument()
  })

  it('escapes a name that is not plain text', () => {
    const hostile = '<img src=x onerror="alert(1)">'
    const { container } = render(<Wordmark name={hostile} />)

    expect(screen.getByText(hostile)).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })

  it('never renders a link — a stray tap mid-match must not leave the match', () => {
    const { container } = render(<Wordmark name={BRAND.name} />)

    expect(container.querySelector('a')).toBeNull()
  })

  it('renders no image — the landing LCP element stays server-rendered text', () => {
    const { container } = render(<Wordmark name={BRAND.name} size="md" />)

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
  })

  it('renders nothing for the logo slot by default', () => {
    const { container } = render(<Wordmark name={BRAND.name} />)
    const root = container.firstElementChild

    // One child only: the name. An empty slot that still emitted a wrapper would show
    // up as a stray gap in the app bar.
    expect(root?.childElementCount).toBe(1)
    expect(root?.textContent).toBe(BRAND.name)
  })

  it('places a supplied logo before the name', () => {
    const { container } = render(
      <Wordmark name={BRAND.name} logo={<span data-testid="logo-slot" />} />,
    )
    const root = container.firstElementChild

    expect(root?.firstElementChild).toBe(screen.getByTestId('logo-slot'))
  })

  it('keeps the shrink classes on both the row and the name', () => {
    const { container } = render(<Wordmark name="Fourteen Chars" />)
    const root = container.firstElementChild as HTMLElement
    const label = screen.getByText('Fourteen Chars')

    // `min-w-0` on the row is what lets the wordmark give way instead of pushing the
    // app bar's controls off the right edge; `truncate` is nowrap + ellipsis on the
    // name. Dropping either turns the 14-character case into a clipped or wrapped bar,
    // and jsdom would not notice.
    expect(root.className).toContain('min-w-0')
    expect(label.className).toContain('min-w-0')
    expect(label.className).toContain('truncate')
  })

  it('truncates the name at sm and md but wraps it at lg', () => {
    // The overflow rule is per size and the two halves are opposites, so each size is
    // asserted at its own call site: a shared helper that regressed to one behaviour
    // would still satisfy a test that only ever rendered the default size. `min-w-0`
    // stays on the row at every size — at lg it is what makes the hero wrap inside the
    // column instead of overflowing it.
    const overlong = 'A Product Name Nobody Would Ever Pick Yet'

    for (const size of ['sm', 'md'] as const) {
      const { container } = render(<Wordmark name={overlong} size={size} />)
      const root = container.firstElementChild as HTMLElement
      const label = root.lastElementChild as HTMLElement

      expect(root.className).toContain('min-w-0')
      expect(label.className).toContain('truncate')
      expect(label.className).not.toContain('text-balance')
      expect(label.className).not.toContain('wrap-anywhere')
    }

    const { container: lg } = render(<Wordmark name={overlong} size="lg" />)
    const lgRoot = lg.firstElementChild as HTMLElement
    const lgLabel = lgRoot.lastElementChild as HTMLElement

    expect(lgRoot.className).toContain('min-w-0')
    // Ellipsising the product's own name in the hero is a defect, not graceful
    // degradation — there is nothing to the right of it competing for the space.
    expect(lgLabel.className).not.toContain('truncate')
    expect(lgLabel.className).toContain('text-balance')
    // `text-wrap: balance` will not break an unbroken word; this is what stops a single
    // very long name overflowing the column anyway.
    expect(lgLabel.className).toContain('wrap-anywhere')
  })

  it('disables ligatures, so an unlucky board-chosen name cannot render a surprising pair', () => {
    // Unprovable by screenshot: no candidate name has a ligating pair, so this line's
    // absence stays invisible until the rename the component exists for. There is no
    // Tailwind utility for it, which is why the assertion is on the arbitrary property.
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(<Wordmark name={BRAND.name} size={size} />)
      const root = container.firstElementChild as HTMLElement

      expect(root.className).toContain('[font-variant-ligatures:none]')
    }
  })

  it('carries no gradient or brand-only hue, so it survives forced-colors', () => {
    const { container } = render(<Wordmark name={BRAND.name} />)
    const root = container.firstElementChild as HTMLElement

    expect(root.className).toContain('text-foreground')
    expect(root.className).not.toMatch(/gradient|bg-clip-text/)
  })

  it('uses --text-base at sm, --text-xl at md and --text-5xl/6xl at lg, all 700', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      expect(rootClassAt(size)).toContain('font-bold')
    }

    expect(rootClassAt('sm')).toContain('text-base')
    expect(rootClassAt('md')).toContain('text-xl')
    // Design tokens §3 allocates --text-5xl to the landing headline on mobile and
    // --text-6xl to it on desktop. The hero wordmark *is* that headline.
    expect(rootClassAt('lg')).toContain('text-5xl')
    expect(rootClassAt('lg')).toContain('md:text-6xl')
  })

  it('carries tracking-tight only at lg, because tokens forbid it at body size', () => {
    // Design tokens §3: --tracking-tight only at --text-3xl and above, never at body
    // size. `sm` is --text-base, i.e. body size, so a root-level tracking-tight — which
    // is what this was — violated the token rule outright.
    expect(rootClassAt('sm')).not.toContain('tracking-tight')
    expect(rootClassAt('md')).not.toContain('tracking-tight')
    expect(rootClassAt('lg')).toContain('tracking-tight')
  })

  it('defaults to a span and is a heading only when asked', () => {
    const { container } = render(<Wordmark name={BRAND.name} />)
    expect(container.firstElementChild?.tagName).toBe('SPAN')

    render(<Wordmark name={BRAND.name} as="h1" />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(BRAND.name)
  })

  it('accepts the real brand name from the app layer', () => {
    render(<Wordmark name={BRAND.name} />)

    expect(screen.getByText(BRAND.name)).toBeInTheDocument()
  })
})
