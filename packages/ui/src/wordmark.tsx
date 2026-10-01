import type { ReactNode } from 'react'

import { cn } from './cn'

/**
 * The product wordmark — the only component allowed to render the product name.
 *
 * Component specs §17 ([PER-19]). The name arrives as a prop and is never imported
 * here: `@playhall/ui` must not depend on `@playhall/shared`, and keeping the name on
 * the boundary is what makes a rename cost exactly one constant in the app layer. The
 * acceptance test for that is a 4-character and a 14-character name rendering correctly
 * in the same 56px app bar at 390px.
 *
 * Deliberate omissions:
 *
 * - **No logo, and the text state is the shipping state.** No logo is board-approved, so
 *   `logo` renders nothing by default and the type sizes are chosen to read as finished
 *   on their own rather than as a caption waiting for art above it.
 * - **Not a link.** In a game screen's app bar a stray tap must not leave the match, so
 *   the component never renders an anchor. A caller that genuinely wants navigation —
 *   the landing header, the footer — wraps it in its own `Link`.
 * - **No image.** The landing LCP element has to stay server-rendered text; an `<img>`
 *   or inline SVG title would add a request or a paint dependency to the one element
 *   that must be fast.
 * - **No gradient and no brand-only hue.** `text-foreground` is the single colour,
 *   because it is the token already guaranteed AA against every surface token and it is
 *   the only one that survives `forced-colors: active` — a gradient clip vanishes there
 *   and leaves the name invisible.
 */
export interface WordmarkProps {
  /** The product name. Comes from `BRAND.name` in the app layer, never from here. */
  readonly name: string
  /**
   * `sm` fits the 56px app bar; `md` is the landing hero, the footer and the OG
   * template. Both are 700 weight with tight tracking.
   */
  readonly size?: 'sm' | 'md'
  /**
   * The logo slot. Empty by default and expected to stay that way until the board
   * approves a logo; a caller passing art gets it inline before the name.
   */
  readonly logo?: ReactNode
  /**
   * The element to render. A heading only where the wordmark genuinely *is* the page
   * heading (the landing hero); an app bar is a landmark, not a heading, and an `h1`
   * there would give a game screen two competing document titles.
   */
  readonly as?: 'span' | 'div' | 'h1' | 'p'
  readonly className?: string
}

const SIZE_CLASS: Record<NonNullable<WordmarkProps['size']>, string> = {
  sm: 'text-base',
  md: 'text-xl',
}

export function Wordmark({
  name,
  size = 'sm',
  logo,
  as: Tag = 'span',
  className,
}: WordmarkProps) {
  return (
    <Tag
      // `min-w-0` is the half of "shrink, never clip or wrap" that is easy to forget:
      // a flex item's default `min-width: auto` refuses to shrink below its content, so
      // without it a long name pushes the app bar's toggles off the right edge instead
      // of ellipsising itself. `truncate` supplies the other half (nowrap + ellipsis).
      className={cn(
        'inline-flex min-w-0 items-center gap-2 font-bold tracking-tight text-foreground',
        SIZE_CLASS[size],
        className,
      )}
    >
      {logo}
      {/*
        The name is its own truncating box rather than letting the flex row truncate.
        With the ellipsis on the row, a present logo would be the thing clipped first;
        with it here, the logo is always whole and the name is what gives way.
      */}
      <span className="min-w-0 truncate">{name}</span>
    </Tag>
  )
}
