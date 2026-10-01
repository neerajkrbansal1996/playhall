'use client'

import { useSearchParams } from 'next/navigation'
import { Menu, Moon } from 'lucide-react'

import { Wordmark } from '@playhall/ui'

export interface WordmarkPreviewProps {
  /** `BRAND.name`, passed down from the server component. */
  readonly defaultName: string
}

/**
 * The app bar, standing alone. Two controls on the right, because the failure this is
 * built to catch is the wordmark *winning* the flex row: a long name with
 * `min-width: auto` pushes the controls off the edge instead of ellipsising itself, and
 * a screenshot of a bar with nothing in it to push would show that as fine.
 *
 * The bar is `h-14` — 56px — and the controls are fixed-size, so the only thing in the
 * row that can give way is the wordmark.
 */
function AppBar({ name }: { readonly name: string }) {
  return (
    <header
      data-testid="wordmark-app-bar"
      className="flex h-14 items-center gap-3 border-b px-4"
    >
      <Wordmark name={name} size="sm" />

      {/* Pushes the controls to the right edge, so any overflow shows up there. */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label="Switch to light theme"
          className="grid size-9 place-items-center rounded-md border"
        >
          <Moon aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Open menu"
          className="grid size-9 place-items-center rounded-md border"
        >
          <Menu aria-hidden="true" className="size-4" />
        </button>
      </div>
    </header>
  )
}

export function WordmarkPreview({ defaultName }: WordmarkPreviewProps) {
  const name = useSearchParams().get('name') ?? defaultName

  return (
    <main className="flex min-h-dvh flex-col">
      {/*
        `data-name` and `data-length` are the "assert the state applied before measuring"
        hook: a screenshot or an overflow check that silently fell back to the default
        name would otherwise look like a pass for a name it never rendered.
      */}
      <div data-testid="wordmark-case" data-name={name} data-length={name.length}>
        <AppBar name={name} />
      </div>

      <div className="flex flex-col gap-8 p-4">
        <section className="flex flex-col gap-2">
          <h2 className="text-muted-foreground text-xs uppercase tracking-wide">
            md — landing, footer, OG
          </h2>
          <Wordmark name={name} size="md" />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-muted-foreground text-xs uppercase tracking-wide">
            sm — app bar
          </h2>
          <Wordmark name={name} size="sm" />
        </section>

        <p className="text-muted-foreground text-sm">
          Rendering <code>?name=</code> — {name.length} characters. The bar above is 56px
          tall; the controls must stay fully on screen.
        </p>
      </div>
    </main>
  )
}
