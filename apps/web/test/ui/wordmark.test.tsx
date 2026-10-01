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

  it('carries no gradient or brand-only hue, so it survives forced-colors', () => {
    const { container } = render(<Wordmark name={BRAND.name} />)
    const root = container.firstElementChild as HTMLElement

    expect(root.className).toContain('text-foreground')
    expect(root.className).not.toMatch(/gradient|bg-clip-text/)
  })

  it('uses --text-base at sm and --text-xl at md, both 700 and tight', () => {
    const { container: sm } = render(<Wordmark name={BRAND.name} size="sm" />)
    const { container: md } = render(<Wordmark name={BRAND.name} size="md" />)

    for (const c of [sm, md]) {
      const root = c.firstElementChild as HTMLElement
      expect(root.className).toContain('font-bold')
      expect(root.className).toContain('tracking-tight')
    }
    expect((sm.firstElementChild as HTMLElement).className).toContain('text-base')
    expect((md.firstElementChild as HTMLElement).className).toContain('text-xl')
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
