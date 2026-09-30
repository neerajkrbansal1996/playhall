/**
 * `settings-form-contract` — the ADR-0007 descriptor against the schema it
 * claims to render.
 *
 * The SDK already ships the checker (`checkSettingsForm`) and the structural
 * schema (`settingsFormDescriptorSchema`). Before this check existed the only
 * thing that ran them was `validateManifest`, folded into `manifest-valid` —
 * so a descriptor bug arrived as "manifest failed validateManifest()" with the
 * real cause buried in a semicolon-joined detail string, and no game had a call
 * site of its own. A checker with no named call site is a checker nobody reads
 * the output of.
 *
 * Three things are asserted here, and only the first two overlap the SDK:
 *
 *   1. the descriptor parses against `settingsFormDescriptorSchema`. Typechecking
 *      is strictly weaker: every field schema is `.strict()`, and TypeScript's
 *      excess-property check only fires on a fresh object literal — a descriptor
 *      assembled through a variable, a spread or a helper typechecks and then
 *      fails `.strict()` at runtime.
 *   2. `checkSettingsForm` reports nothing, each issue surfaced as its own
 *      failure carrying the issue code and the dotted path.
 *   3. every **preset** is producible by the form. `checkSettingsForm` probes
 *      only `defaultSettings`, so a preset that sets a value no control offers
 *      is invisible to it: the player picks "Blitz", gets settings the form
 *      cannot draw, and the first edit silently snaps the value back. Presets
 *      are manifest data, so this belongs in conformance rather than in the SDK
 *      checker's `SettingsContract` slice.
 *
 * Reachability uses the SDK's own `isFieldVisible`, not a reimplementation:
 * the point is that the renderer, the server and this check agree on one
 * implementation of `visibleWhen`.
 */

import {
  type GameEvent,
  type SettingsField,
  checkSettingsForm,
  isFieldVisible,
  settingsFormDescriptorSchema,
} from '@playhall/game-sdk'
import { CheckRecorder } from '../report.js'
import type { Prepared } from '../internal/prepare.js'
import { preview } from '../internal/value.js'

/** Is `value` something this control can actually produce? */
function controlOffers(field: SettingsField, value: unknown): boolean {
  switch (field.kind) {
    case 'select':
      return field.options.some((option) => option.value === value)
    case 'toggle':
      return typeof value === 'boolean'
    case 'number':
      // The descriptor's bounds are affordances, not validation, so a value
      // outside them is not illegal — but it is one the control cannot reach,
      // which is the bug this check is looking for.
      return typeof value === 'number' && value >= field.min && value <= field.max
  }
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value)
}

export function checkSettingsFormContract<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>): CheckRecorder {
  const recorder = new CheckRecorder(
    'settings-form-contract',
    'Settings form descriptor matches the settings it renders',
  )
  const { manifest } = prep.subject

  const structural = settingsFormDescriptorSchema.safeParse(manifest.settingsForm)
  recorder.assert(structural.success, () => ({
    message: 'settingsForm does not satisfy settingsFormDescriptorSchema',
    detail: structural.success
      ? ''
      : structural.error.issues
          .map(
            (issue) => `${['settingsForm', ...issue.path.map(String)].join('.')}: ${issue.message}`,
          )
          .join('; '),
  }))
  // Everything below indexes into fields whose shape is not trustworthy.
  if (!structural.success) return recorder

  // The SDK's own cross-check, one failure per issue so the code and the path
  // survive into the CI annotation instead of being joined into one line.
  const issues = checkSettingsForm({
    settingsForm: manifest.settingsForm,
    settingsSchema: manifest.settingsSchema,
    defaultSettings: manifest.defaultSettings,
  })
  recorder.assert(issues.length === 0, () => ({
    message: `checkSettingsForm reported ${issues.length} issue(s)`,
  }))
  for (const issue of issues) {
    recorder.fail({
      message: `[${issue.code}] ${issue.message}`,
      where: issue.path,
    })
  }

  const form = manifest.settingsForm

  // A conditional field must be reachable under the SDK's own visibility
  // implementation, from the defaults, by changing only its target field.
  // `checkSettingsForm` proves the target *value* is offered; this proves the
  // two halves agree that the value actually reveals the field.
  const defaults = manifest.defaultSettings as Readonly<Record<string, unknown>>
  for (const field of form.fields) {
    const rule = field.visibleWhen
    if (rule === undefined) continue
    const revealed = { ...defaults, [rule.field]: rule.equals[0] }
    recorder.assert(isFieldVisible(field, revealed), () => ({
      message: `field '${field.key}' is never visible: setting '${rule.field}' to ${describeValue(rule.equals[0])} does not satisfy its own visibleWhen rule`,
      where: `settingsForm.fields.${field.key}.visibleWhen`,
      detail: preview(rule),
    }))
  }

  // Presets. `checkSettingsForm` never looks at them, and a preset the form
  // cannot draw is a lobby the player cannot edit without losing the setting.
  for (const [index, preset] of manifest.presets.entries()) {
    const parsed = manifest.settingsSchema.safeParse(preset.settings)
    // `manifest-valid` already owns "preset satisfies settingsSchema"; if it
    // does not, its values say nothing about the form.
    if (!parsed.success) continue
    const values = parsed.data as Readonly<Record<string, unknown>>

    for (const field of form.fields) {
      if (!isFieldVisible(field, values)) continue
      const value = values[field.key]
      recorder.assert(controlOffers(field, value), () => ({
        message: `preset '${preset.id}' sets ${field.key} to ${describeValue(value)}, which its ${field.kind} control cannot produce`,
        where: `presets.${index}.settings.${field.key}`,
        detail:
          field.kind === 'select'
            ? `offered: ${field.options.map((option) => describeValue(option.value)).join(', ')}`
            : field.kind === 'number'
              ? `range: ${field.min}..${field.max} step ${field.step}`
              : 'a toggle can only produce true or false',
      }))
    }
  }

  // Deliberately not checked here: a settings key that no field binds. That
  // rule belongs to `checkSettingsForm` — PER-110 adds it as
  // `setting_without_field` — and it arrives through the loop above the moment
  // that lands. Asserting it here too would mean two call sites disagreeing
  // about whether it is a note or a failure.

  return recorder
}
