/**
 * Chess time controls.
 *
 * Pure data + pure functions. No I/O, no `Date.now()`, no `Math.random()`.
 * The platform clock is the only thing that actually counts down; this module
 * only says how much time each side starts with and how much each move adds.
 */

/** Preset ids are the conventional `initial+increment` shorthand. */
export const TIME_CONTROL_PRESET_IDS = [
  '1+0',
  '2+1',
  '3+0',
  '3+2',
  '5+0',
  '5+3',
  '10+0',
  '10+5',
  '15+10',
  '30+0',
] as const

export type TimeControlPresetId = (typeof TIME_CONTROL_PRESET_IDS)[number]

/** Extra choices that sit alongside the presets in the picker. */
export const TIME_CONTROL_CUSTOM = 'custom'
export const TIME_CONTROL_UNLIMITED = 'unlimited'

export type TimeControlSelection =
  | TimeControlPresetId
  | typeof TIME_CONTROL_CUSTOM
  | typeof TIME_CONTROL_UNLIMITED

export type TimeControlCategory = 'bullet' | 'blitz' | 'rapid' | 'classical'

export interface TimeControlPreset {
  readonly id: TimeControlPresetId
  readonly initialMinutes: number
  readonly incrementSeconds: number
  readonly category: TimeControlCategory
}

/**
 * Bounds for the custom time control.
 *
 * `step` is enforced, not decorative: the schema rejects 1.3 minutes the same
 * way it rejects 200 minutes. Half-minute granularity is the smallest unit the
 * picker offers ("½ + 0"), and increments are whole seconds.
 */
export const CUSTOM_INITIAL_MINUTES = { min: 0.5, max: 180, step: 0.5 } as const
export const CUSTOM_INCREMENT_SECONDS = { min: 0, max: 60, step: 1 } as const

/**
 * Estimated game duration in seconds, using the standard `base + 40 * increment`
 * heuristic (40 moves is the conventional reference game length). Categories are
 * derived from it rather than hard-coded so a custom control lands in the same
 * buckets as a preset.
 */
export function estimatedDurationSeconds(
  initialMinutes: number,
  incrementSeconds: number,
): number {
  return initialMinutes * 60 + incrementSeconds * 40
}

export function categoryFor(
  initialMinutes: number,
  incrementSeconds: number,
): TimeControlCategory {
  const seconds = estimatedDurationSeconds(initialMinutes, incrementSeconds)
  if (seconds < 180) return 'bullet'
  if (seconds < 480) return 'blitz'
  if (seconds < 1500) return 'rapid'
  return 'classical'
}

function preset(id: TimeControlPresetId): TimeControlPreset {
  const [initial, increment] = id.split('+')
  const initialMinutes = Number(initial)
  const incrementSeconds = Number(increment)
  return {
    id,
    initialMinutes,
    incrementSeconds,
    category: categoryFor(initialMinutes, incrementSeconds),
  }
}

export const TIME_CONTROL_PRESETS: readonly TimeControlPreset[] =
  TIME_CONTROL_PRESET_IDS.map(preset)

const PRESETS_BY_ID = new Map<TimeControlPresetId, TimeControlPreset>(
  TIME_CONTROL_PRESETS.map((p) => [p.id, p]),
)

export function getTimeControlPreset(id: TimeControlPresetId): TimeControlPreset {
  const found = PRESETS_BY_ID.get(id)
  // Unreachable for well-typed callers; guards a runtime value that skipped the schema.
  if (!found) throw new Error(`Unknown chess time control preset: ${id}`)
  return found
}

export function isTimeControlPresetId(value: unknown): value is TimeControlPresetId {
  return typeof value === 'string' && PRESETS_BY_ID.has(value as TimeControlPresetId)
}

/** Human label for a control, e.g. `3+2` or `No clock`. */
export function formatTimeControl(
  initialMinutes: number,
  incrementSeconds: number,
): string {
  const minutes = Number.isInteger(initialMinutes)
    ? String(initialMinutes)
    : `${initialMinutes}`
  return `${minutes}+${incrementSeconds}`
}
