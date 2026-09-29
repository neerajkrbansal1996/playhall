'use client'

import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'

import { featuredPresets, settingsFromPreset } from './presets'
import type { SettingsFormPreset, SettingsValues } from './types'

export interface PresetQuickStartProps {
  readonly presets: readonly SettingsFormPreset[]
  /**
   * Creates the lobby. Called with the preset's settings merged over the game's
   * defaults, which is the complete payload — there is no second step.
   */
  readonly onQuickStart: (settings: SettingsValues, preset: SettingsFormPreset) => void
  /** `GameCatalogEntry.defaultSettings`, as a scalar map. */
  readonly defaults: SettingsValues
  /** The preset a create request is in flight for, so the row can show progress. */
  readonly pendingPresetId?: string | null
  readonly disabled?: boolean
  readonly className?: string
  /** Rendered above the row. Product Designer owns the final copy. */
  readonly heading?: string
}

/**
 * The quick-start row: one tap from here to a created lobby.
 *
 * This is the "<= 2 taps, < 10 s" principle made concrete — tapping the game on
 * the landing page is tap one, tapping a featured preset here is tap two, and
 * the form is never opened. The settings are complete before the tap because
 * a preset's `settings` are canonical against the game's schema (ADR-0004 §7),
 * so there is nothing left to fill in.
 *
 * Renders nothing when no preset is featured — a game with no quick start should
 * cost no vertical space, not show an empty row.
 */
export function PresetQuickStart({
  presets,
  onQuickStart,
  defaults,
  pendingPresetId = null,
  disabled = false,
  className,
  heading = 'Quick start',
}: PresetQuickStartProps) {
  const featured = featuredPresets(presets)
  if (featured.length === 0) return null

  const headingId = 'settings-form-quick-start-heading'

  return (
    <section aria-labelledby={headingId} className={cn('flex flex-col gap-2', className)}>
      <h2
        id={headingId}
        className="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
      >
        {heading}
      </h2>
      {/*
        A grid rather than a horizontal scroller: a scroller hides options off the
        right edge on a 375px viewport, and the whole point of this row is that
        every quick start is visible without discovery. Two columns keeps each
        button inside the thumb zone.
      */}
      <div className="grid grid-cols-2 gap-2">
        {featured.map((preset) => {
          const pending = pendingPresetId === preset.id
          return (
            <button
              key={preset.id}
              type="button"
              disabled={disabled || pendingPresetId !== null}
              aria-busy={pending || undefined}
              onClick={() => onQuickStart({ ...defaults, ...settingsFromPreset(preset) }, preset)}
              className={cn(
                'flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-md border',
                'bg-background px-3.5 py-2 text-left transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <span className="flex w-full items-center gap-1.5 text-sm font-semibold">
                {pending ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : null}
                {preset.label}
              </span>
              {preset.description === null || preset.description === undefined ? null : (
                <span className="text-muted-foreground line-clamp-2 text-xs">
                  {preset.description}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}
