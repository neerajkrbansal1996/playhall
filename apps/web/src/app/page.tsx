import { BRAND } from '@atrium/shared'

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
        <h1 className="text-3xl font-semibold tracking-tight">{BRAND.name}</h1>
        <p className="text-muted-foreground text-sm">
          Multiplayer in the browser. Open a lobby, share a link or a 6-character code, play.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <Button disabled>Create a lobby</Button>
        <Button variant="outline" disabled>
          Join with a code
        </Button>
      </div>

      <p className="text-muted-foreground text-xs">
        M0 skeleton — lobby flows land in M1.
        {BRAND.isProvisional ? ' Product name is provisional (internal codename).' : null}
      </p>
    </main>
  )
}
