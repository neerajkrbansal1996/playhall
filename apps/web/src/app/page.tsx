import { BRAND } from '@playhall/shared'
import { Wordmark } from '@playhall/ui'

import { Button } from '@/components/ui/button'

/**
 * M0 placeholder. The real landing page (2 taps to a playable lobby, link
 * previews, LCP < 2 s on a mid-range Android) is the Frontend Engineer's, in M1.
 * This page exists so `pnpm dev` renders something that proves the toolchain —
 * Tailwind, shadcn/ui and a workspace import — is wired end to end.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12">
      <div className="space-y-2">
        {/*
          `Wordmark` is the only component allowed to render the name, and the name
          reaches it as a prop — the import of `BRAND` stops at this app layer. It is an
          `h1` here because on the landing page the wordmark genuinely *is* the page
          heading; in an app bar it is a `span`.

          `lg`, not `md`: component specs §17 reserves `lg` for the landing hero, and
          design tokens §3 allocates `--text-5xl`/`--text-6xl` to the landing headline —
          which is what this element is. `md` is the landing *header bar*, and rendering
          the hero at it put the product name at card-title size on the first screen a
          stranger sees after tapping an invite.
        */}
        <Wordmark as="h1" size="lg" name={BRAND.name} />
        <p className="text-muted-foreground text-sm">{BRAND.tagline}</p>
      </div>

      <div className="flex flex-col gap-3">
        <Button disabled>Create a lobby</Button>
        <Button variant="outline" disabled>
          Join with a code
        </Button>
      </div>

      <p className="text-muted-foreground text-xs">
        M0 skeleton — lobby flows land in M1.
        {BRAND.isProvisional ? ' Branding is not final yet.' : null}
      </p>
    </main>
  )
}
