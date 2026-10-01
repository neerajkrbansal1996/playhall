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
 * - **Ligatures off.** `font-variant-ligatures: none` is a guard for the name the board
 *   has not picked yet: today's candidates have no ligating pair, so nothing about this
 *   line is visible until the rename the component exists for. That is exactly why it is
 *   written now rather than when a surprising glyph pair shows up in a screenshot. `none`
 *   is required rather than `normal`, which keeps the common ligatures the font enables by
 *   default — the distinction the whole guard rests on:
 *   @see https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant-ligatures
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
   * `sm` fits the 56px app bar; `md` is the landing **header bar**, the footer and the
   * OG template; `lg` is the landing **hero** and nothing else — one per app. All three
   * are 700 weight, but only `lg` carries tight tracking (design tokens §3 allows
   * `--tracking-tight` at `--text-3xl` and above and prohibits it at body size, which is
   * what `sm` is).
   */
  readonly size?: 'sm' | 'md' | 'lg'
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

type Size = NonNullable<WordmarkProps['size']>

// Tracking lives here, not on the root, because it is per size: design tokens §3 allows
// `--tracking-tight` only at `--text-3xl` and above and prohibits it at body size. `sm`
// *is* body size, so a root-level `tracking-tight` violated the token rule at `sm` and
// `md` to buy nothing — the sizes that are allowed to carry it are `lg` alone.
const SIZE_CLASS: Record<Size, string> = {
  sm: 'text-base',
  md: 'text-xl',
  lg: 'text-5xl tracking-tight md:text-6xl',
}

// Overflow is per size because the two contexts want opposite things.
//
// `sm`/`md` shrink, never clip or wrap: the app bar ellipsises the name long before it
// pushes the toggles off the right edge. `truncate` is nowrap + overflow-hidden +
// ellipsis, and it sits on the **name** rather than the row so a logo is never the thing
// clipped first.
//
// `lg` wraps, never truncates. Ellipsising the product's own name in the hero is a
// defect, not graceful degradation — unlike the app bar there is nothing to the right
// competing for the space, so the name is allowed the second line. `text-balance` keeps
// the two lines even and `wrap-anywhere` is what stops a single unbroken long name from
// overflowing the column anyway (`text-wrap: balance` alone will not break a word).
const NAME_CLASS: Record<Size, string> = {
  sm: 'truncate',
  md: 'truncate',
  lg: 'text-balance wrap-anywhere',
}

export function Wordmark({ name, size = 'sm', logo, as: Tag = 'span', className }: WordmarkProps) {
  return (
    <Tag
      // `min-w-0` is the half of the overflow behaviour that is easy to forget, and it is
      // needed at every size: a flex item's default `min-width: auto` refuses to shrink
      // below its content, so without it a long name pushes the app bar's toggles off the
      // right edge instead of ellipsising, and in the hero it overflows the column instead
      // of wrapping. `[font-variant-ligatures:none]` has no Tailwind utility; the
      // arbitrary property is the whole implementation of that spec line.
      className={cn(
        'inline-flex min-w-0 items-center gap-2 font-bold text-foreground [font-variant-ligatures:none]',
        SIZE_CLASS[size],
        className,
      )}
    >
      {logo}
      <span className={cn('min-w-0', NAME_CLASS[size])}>{name}</span>
    </Tag>
  )
}
