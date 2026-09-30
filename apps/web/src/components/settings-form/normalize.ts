/**
 * The boundary between "JSON that arrived over the wire" and "a descriptor the
 * renderer will draw".
 *
 * ADR-0004 asks for two things that pull in opposite directions:
 *
 * - §10 — a renderer must **skip** a field kind it does not know rather than
 *   choke on it, because an additive kind keeps `version: 1`;
 * - the SDK ships `settingsFormDescriptorSchema` for parsing the descriptor at
 *   the boundary.
 *
 * Those cannot both be satisfied by one `settingsFormDescriptorSchema.parse()`:
 * `settingsFieldSchema` is a `.strict()` discriminated union, so a single future
 * field kind fails the whole descriptor and the player gets a blank screen —
 * exactly the degradation the ADR forbids. So the parse is per field instead:
 * the envelope is checked once, then each field independently. A field that
 * parses is rendered, a field that does not is dropped and left at its default,
 * and the rest of the form is unaffected.
 *
 * ## Run this on the server
 *
 * **This module is deliberately not part of the client entry point** and is not
 * re-exported from `./index`. It imports zod, and zod measured **20.7 kB
 * gzipped** in the create-lobby client bundle against the renderer's own 5.8 kB —
 * 3.5× the component tree, to re-check 817 bytes of JSON that `checkSettingsForm`
 * already validated against the game's schema at registry load. ADR-0004 justified
 * the whole descriptor design on keeping the create-lobby path light, so paying
 * that on the LCP path would be self-defeating.
 *
 * Call it where the catalogue entry is read — a server component, a route
 * handler — and pass the resulting `form` to `useSettingsForm`. The renderer
 * needs no validator: `SettingsFieldRow` switches on three known kinds and
 * renders nothing for anything else, so an unnormalized descriptor degrades the
 * same way rather than throwing.
 */

import {
  SETTINGS_FORM_VERSION,
  settingsFieldSchema,
  type SettingsField,
  type SettingsFormDescriptor,
} from '@playhall/game-sdk'

/** Why a field in the incoming JSON is not being rendered. */
export interface SkippedField {
  /** The field's `key`, or `null` when the JSON was too malformed to have one. */
  readonly key: string | null
  /** Index in the incoming `fields` array, so a keyless skip is still locatable. */
  readonly index: number
  /** The `kind` as it arrived — the useful half of a forward-compatibility log. */
  readonly kind: string | null
  readonly reason: 'unknown_kind' | 'invalid_field'
}

export interface NormalizedSettingsForm {
  /** Only fields this renderer understands, in declaration order. */
  readonly form: SettingsFormDescriptor
  readonly skipped: readonly SkippedField[]
  /**
   * Set when the descriptor announces a version this renderer was not written
   * against. `form.fields` is empty in that case: a major version bump may have
   * changed what the existing kinds mean, so guessing is worse than deferring to
   * `defaultSettings`.
   */
  readonly unsupportedVersion: number | null
}

const EMPTY_FORM: SettingsFormDescriptor = { version: SETTINGS_FORM_VERSION, fields: [] }

function readKind(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const kind = (raw as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : null
}

function readKey(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const key = (raw as { key?: unknown }).key
  return typeof key === 'string' ? key : null
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(['select', 'number', 'toggle'])

/**
 * Field-by-field validation of a descriptor that arrived as JSON.
 *
 * Pure and cheap — no React, no I/O — so it is safe to call during render or on
 * the server while building the create-lobby response.
 */
export function normalizeSettingsForm(raw: unknown): NormalizedSettingsForm {
  if (typeof raw !== 'object' || raw === null) {
    return { form: EMPTY_FORM, skipped: [], unsupportedVersion: null }
  }

  const envelope = raw as { version?: unknown; fields?: unknown }

  if (typeof envelope.version === 'number' && envelope.version !== SETTINGS_FORM_VERSION) {
    return { form: EMPTY_FORM, skipped: [], unsupportedVersion: envelope.version }
  }

  if (!Array.isArray(envelope.fields)) {
    return { form: EMPTY_FORM, skipped: [], unsupportedVersion: null }
  }

  const fields: SettingsField[] = []
  const skipped: SkippedField[] = []
  const seen = new Set<string>()

  for (const [index, candidate] of envelope.fields.entries()) {
    const parsed = settingsFieldSchema.safeParse(candidate)
    if (!parsed.success) {
      const kind = readKind(candidate)
      skipped.push({
        key: readKey(candidate),
        index,
        kind,
        // A `kind` we simply have not implemented is the forward-compatibility
        // case ADR-0004 §10 anticipates; anything else is a malformed field.
        reason: kind !== null && !KNOWN_KINDS.has(kind) ? 'unknown_kind' : 'invalid_field',
      })
      continue
    }

    // `checkSettingsForm` already rejects a duplicate key at registry load, so
    // this only fires on a hand-rolled descriptor. First declaration wins,
    // matching the SDK checker.
    if (seen.has(parsed.data.key)) {
      skipped.push({
        key: parsed.data.key,
        index,
        kind: parsed.data.kind,
        reason: 'invalid_field',
      })
      continue
    }
    seen.add(parsed.data.key)
    fields.push(parsed.data)
  }

  return {
    form: { version: SETTINGS_FORM_VERSION, fields },
    skipped,
    unsupportedVersion: null,
  }
}

/** Human-readable one-liner for a skipped field. Used by the dev-only warning. */
export function describeSkippedField(skipped: SkippedField): string {
  const where = skipped.key !== null ? `'${skipped.key}'` : `fields[${skipped.index}]`
  return skipped.reason === 'unknown_kind'
    ? `[settings-form] skipping ${where}: unsupported field kind '${skipped.kind}'. ` +
        'It will keep its default value. Update @playhall/web to render it.'
    : `[settings-form] skipping ${where}: the field does not match the SETTINGS_FORM_VERSION ${SETTINGS_FORM_VERSION} shape.`
}

/**
 * Report anything the descriptor asked for and this renderer will not draw.
 *
 * Dev-only and no-ops in production: a stale renderer meeting a newer descriptor
 * is a deployment fact for us to notice, not something to shout about in a
 * player's console. Call it next to `normalizeSettingsForm` — a skipped field
 * should surface in the log of whoever served the page.
 */
export function warnAboutSkippedFields(normalized: NormalizedSettingsForm): void {
  if (process.env.NODE_ENV === 'production') return
  for (const skipped of normalized.skipped) console.warn(describeSkippedField(skipped))
  if (normalized.unsupportedVersion !== null) {
    console.warn(
      `[settings-form] descriptor version ${normalized.unsupportedVersion} is newer than the ` +
        `SETTINGS_FORM_VERSION ${SETTINGS_FORM_VERSION} this renderer implements. ` +
        'Falling back to defaultSettings with no fields shown.',
    )
  }
}
