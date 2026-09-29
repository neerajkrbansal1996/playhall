'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { SettingsValue } from '@atrium/game-sdk'

import { describeSkippedField, normalizeSettingsForm } from './normalize'
import type { NormalizedSettingsForm } from './normalize'
import type { SettingsFormPreset } from './types'
import { presetMatching, settingsFromPreset } from './presets'

export interface UseSettingsFormOptions {
  /** `GameCatalogEntry.settingsForm`, straight from the catalogue JSON. */
  readonly settingsForm: unknown
  /** `GameCatalogEntry.defaultSettings`. */
  readonly defaultSettings: unknown
  readonly presets?: readonly SettingsFormPreset[]
}

export interface UseSettingsFormResult extends NormalizedSettingsForm {
  /**
   * Every setting, including fields currently hidden by `visibleWhen` and fields
   * whose kind this renderer skipped. ADR-0004 §2 requires the schema to accept
   * every combination reachable through the descriptor, so this is what gets
   * submitted verbatim — nothing is stripped.
   */
  readonly values: Readonly<Record<string, SettingsValue>>
  readonly setValue: (key: string, value: SettingsValue) => void
  readonly applyPreset: (presetId: string) => void
  readonly reset: () => void
  /**
   * The preset whose settings the current values equal, or null once the player
   * has edited away from one. Order-independent, via `canonicalSettingsKey`.
   */
  readonly activePresetId: string | null
}

function toScalarRecord(raw: unknown): Record<string, SettingsValue> {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, SettingsValue> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Settings are a flat map of scalars (ADR-0004 §4). A non-scalar cannot be
    // bound to a control, and `checkSettingsForm` already reports it at registry
    // load, so dropping it here is a belt to that braces.
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

/**
 * Form state for one game's create-lobby settings.
 *
 * Deliberately does **not** own submission, errors, or what a lobby is. Errors
 * are passed in because they come back from the server keyed by field, and the
 * server is the authority on whether a value is legal — a hook that validated
 * locally would be asserting a result the client does not own.
 */
export function useSettingsForm({
  settingsForm,
  defaultSettings,
  presets = [],
}: UseSettingsFormOptions): UseSettingsFormResult {
  const normalized = useMemo(() => normalizeSettingsForm(settingsForm), [settingsForm])

  // `defaultSettings` is the base every preset is applied over, so a preset that
  // names only `timeControl` leaves the rest at their defaults.
  const defaults = useMemo(() => toScalarRecord(defaultSettings), [defaultSettings])

  // The preset the form opens on (ADR-0004 §7). The SDK checker guarantees an
  // `isDefault` preset's settings equal `defaultSettings`, so applying it here
  // only decides which preset renders as selected — it cannot change the values
  // the form starts with.
  const initial = useMemo(() => {
    const fallback = presets.find((preset) => preset.isDefault)
    return fallback === undefined ? defaults : { ...defaults, ...settingsFromPreset(fallback) }
  }, [defaults, presets])

  const [values, setValues] = useState<Readonly<Record<string, SettingsValue>>>(initial)

  // Dev-only, and once per descriptor: a skipped field is a forward-compatibility
  // event worth seeing in a console, not a warning per render.
  const warnedFor = useRef<unknown>(null)
  if (process.env.NODE_ENV !== 'production' && warnedFor.current !== settingsForm) {
    warnedFor.current = settingsForm
    for (const skipped of normalized.skipped) console.warn(describeSkippedField(skipped))
    if (normalized.unsupportedVersion !== null) {
      console.warn(
        `[settings-form] descriptor version ${normalized.unsupportedVersion} is newer than this renderer. ` +
          'Falling back to defaultSettings with no fields shown.',
      )
    }
  }

  const setValue = useCallback((key: string, value: SettingsValue) => {
    setValues((current) => ({ ...current, [key]: value }))
  }, [])

  const applyPreset = useCallback(
    (presetId: string) => {
      const preset = presets.find((candidate) => candidate.id === presetId)
      if (preset === undefined) return
      // Merge over the defaults rather than replacing wholesale: a preset that
      // omits a key should leave that key at its default, not undefined.
      setValues({ ...defaults, ...settingsFromPreset(preset) })
    },
    [defaults, presets],
  )

  const reset = useCallback(() => setValues(initial), [initial])

  const activePresetId = useMemo(
    () => presetMatching(presets, values, defaults)?.id ?? null,
    [defaults, presets, values],
  )

  return { ...normalized, values, setValue, applyPreset, reset, activePresetId }
}
