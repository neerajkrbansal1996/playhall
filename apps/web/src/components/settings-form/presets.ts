import { canonicalSettingsKey, type SettingsValue } from '@atrium/game-sdk'

import type { SettingsFormPreset, SettingsValues } from './types'

/** A preset's settings as a scalar map, dropping anything that is not a scalar. */
export function settingsFromPreset(preset: SettingsFormPreset): Record<string, SettingsValue> {
  if (typeof preset.settings !== 'object' || preset.settings === null) return {}
  const out: Record<string, SettingsValue> = {}
  for (const [key, value] of Object.entries(preset.settings as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

/**
 * Which preset, if any, the current values are.
 *
 * Uses the SDK's `canonicalSettingsKey` so the answer never depends on key
 * order — the same function the SDK uses to prove a preset is canonical against
 * its schema, which means "selected in the UI" and "canonical in the manifest"
 * cannot disagree about what equality means.
 *
 * `base` is the defaults a preset is applied over. Comparing against the merge
 * rather than against the preset's own keys is what makes this the exact inverse
 * of applying it: a preset that names only `timeControl` still matches once
 * selected, and two presets that differ only in a key one of them omits still
 * resolve to different settings instead of both claiming the same values.
 */
export function presetMatching(
  presets: readonly SettingsFormPreset[],
  values: SettingsValues,
  base: SettingsValues,
): SettingsFormPreset | undefined {
  const target = canonicalSettingsKey(values)
  return presets.find(
    (preset) => canonicalSettingsKey({ ...base, ...settingsFromPreset(preset) }) === target,
  )
}

/**
 * Presets for the quick-start row (ADR-0004 §7).
 *
 * `featured` is the "<= 2 taps to a playable lobby" affordance: tapping one
 * creates a lobby without the form being opened at all, so the row is rendered
 * above the form and never behind a disclosure.
 */
export function featuredPresets(
  presets: readonly SettingsFormPreset[],
): readonly SettingsFormPreset[] {
  return presets.filter((preset) => preset.featured === true)
}
