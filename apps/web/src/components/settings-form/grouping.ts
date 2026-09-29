/**
 * Select-option grouping and value-type preservation.
 *
 * Both jobs here exist because the DOM is stringly typed and the descriptor is
 * not. `SelectOption.value` is `string | number` (ADR-0004 §3 — a discrete
 * player count is an obvious select over numbers), but a radio's `value`
 * attribute and an `<option>`'s are always strings. Round-tripping through
 * `Number(...)` would guess, and would turn the string `'10'` into `10` for a
 * game whose schema wanted the string. So the token is only ever a lookup key
 * back into the descriptor, and the value submitted is the identical value the
 * descriptor declared.
 */

import type { SelectField, SelectOption } from '@atrium/game-sdk'

/** Options that share a `group`, plus the heading to draw above them. */
export interface OptionGroup {
  /** Null for options with no `group` — rendered without a heading. */
  readonly group: string | null
  readonly options: readonly SelectOption[]
}

/**
 * Stable DOM token for an option value.
 *
 * Prefixed by type so the number `5` and the string `'5'` cannot collide in the
 * same select — without the prefix, a descriptor offering both would have two
 * radios with one `value` and the wrong one would win.
 */
export function optionToken(value: string | number): string {
  return typeof value === 'number' ? `n:${value}` : `s:${value}`
}

/**
 * Group a select's options for rendering.
 *
 * Order, per the descriptor contract: every group named in `groupOrder` first,
 * in that order; then any group that appears on an option but not in
 * `groupOrder`, in first-appearance order. Ungrouped options keep their
 * first-appearance position among the groups, so a descriptor that mixes them is
 * still rendered in a predictable order rather than silently reshuffled.
 */
export function groupOptions(field: SelectField): readonly OptionGroup[] {
  const byGroup = new Map<string | null, SelectOption[]>()
  // Insertion order of this Map *is* first-appearance order, which is what the
  // contract asks for on an unlisted group.
  for (const option of field.options) {
    const key = option.group ?? null
    const bucket = byGroup.get(key)
    if (bucket === undefined) byGroup.set(key, [option])
    else bucket.push(option)
  }

  // A single unnamed bucket is the common case (chess's `color`, tic-tac-toe's
  // `firstPlayer`): no headings, just options.
  if (byGroup.size === 1 && byGroup.has(null)) {
    return [{ group: null, options: field.options }]
  }

  const ordered: OptionGroup[] = []
  const taken = new Set<string | null>()

  for (const name of field.groupOrder ?? []) {
    if (taken.has(name)) continue
    const options = byGroup.get(name)
    // A `groupOrder` entry no option uses renders nothing rather than an empty
    // heading. Harmless drift; not worth failing a lobby over.
    if (options === undefined) continue
    taken.add(name)
    ordered.push({ group: name, options })
  }

  for (const [name, options] of byGroup) {
    if (taken.has(name)) continue
    ordered.push({ group: name, options })
  }

  return ordered
}

/** Look an option back up from its DOM token, preserving the declared type. */
export function optionForToken(field: SelectField, token: string): SelectOption | undefined {
  return field.options.find((option) => optionToken(option.value) === token)
}

/** The option matching the current value, compared strictly (ADR-0004 §3). */
export function selectedOption(field: SelectField, value: unknown): SelectOption | undefined {
  return field.options.find((option) => option.value === value)
}
