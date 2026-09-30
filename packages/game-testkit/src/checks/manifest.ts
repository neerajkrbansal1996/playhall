/**
 * `manifest-valid` — the declarations the whole platform trusts.
 *
 * The lobby, the registry, the settings form and the result panel are all
 * built from the manifest, so a manifest that lies is a runtime bug in four
 * places at once. Two of the rules here are less obvious than the rest:
 *
 *   - a game that declares `hasHiddenInformation: true` must declare secrets
 *     to the conformance subject. Otherwise the leak fuzzer has nothing to
 *     look for and reports a confident, meaningless pass.
 *   - every timer id a playout actually uses must be declared. An undeclared
 *     timer is one the runner will refuse to schedule, so the game would
 *     silently lose its clock in production and pass every unit test.
 */

import { type GameEvent, validateManifest } from '@playhall/game-sdk'
import { CheckRecorder } from '../report.js'
import type { Prepared } from '../internal/prepare.js'
import { preview } from '../internal/value.js'

export function checkManifest<
  TState,
  TAction,
  TView,
  TSettings,
  TEvent extends GameEvent,
  TErrorCode extends string,
>(prep: Prepared<TState, TAction, TView, TSettings, TEvent, TErrorCode>): CheckRecorder {
  const recorder = new CheckRecorder('manifest-valid', 'Manifest is valid and honest')
  const { manifest } = prep.subject

  const validated = validateManifest(manifest)
  recorder.assert(validated.ok, () => ({
    message: 'manifest failed validateManifest()',
    detail: validated.ok
      ? ''
      : validated.error.map((problem) => `${problem.path}: ${problem.message}`).join('; '),
  }))

  const parsedDefaults = manifest.settingsSchema.safeParse(manifest.defaultSettings)
  recorder.assert(parsedDefaults.success, () => ({
    message: 'defaultSettings does not satisfy settingsSchema',
    detail: preview(manifest.defaultSettings),
  }))

  for (const preset of manifest.presets) {
    const parsed = manifest.settingsSchema.safeParse(preset.settings)
    recorder.assert(parsed.success, () => ({
      message: `preset '${preset.id}' does not satisfy settingsSchema`,
      detail: preview(preset.settings),
    }))
  }

  const defaults = manifest.presets.filter((preset) => preset.isDefault === true)
  recorder.assert(defaults.length <= 1, () => ({
    message: `${defaults.length} presets are marked isDefault; at most one may be`,
    detail: defaults.map((preset) => preset.id).join(', '),
  }))

  recorder.assert(manifest.turnModel !== 'realtime', () => ({
    message: 'a realtime manifest cannot be run through the turn-based conformance suite',
  }))

  const declaredSecrets = prep.subject.secrets ?? []
  recorder.assert(!manifest.hasHiddenInformation || declaredSecrets.length > 0, () => ({
    message:
      'manifest declares hasHiddenInformation: true but the conformance subject declares no secrets, so the leak fuzzer would pass vacuously',
    detail: 'Add `secrets: [...]` to the subject, one SecretDescriptor per hidden thing.',
  }))
  recorder.assert(manifest.hasHiddenInformation || declaredSecrets.length === 0, () => ({
    message:
      'the conformance subject declares secrets but the manifest says hasHiddenInformation: false',
    detail: declaredSecrets.map((secret) => secret.label).join(', '),
  }))

  recorder.assert(
    manifest.supportsBots ||
      prep.subject.server.disconnectPolicy.onGraceExpired !== 'substitute_bot',
    () => ({
      message:
        "disconnectPolicy.onGraceExpired is 'substitute_bot' but the manifest sets supportsBots: false",
    }),
  )

  // Timer ids actually used, gathered from real playouts rather than by
  // reading the source.
  const declaredTimerIds = new Set(manifest.timers.map((timer) => timer.id))
  const usedTimerIds = new Set<string>()
  for (const run of prep.runs) {
    if (run.crash !== null) continue
    for (const command of run.playout.initial.timers ?? [])
      usedTimerIds.add(String(command.timerId))
    for (const step of run.playout.steps) {
      for (const command of step.timers) usedTimerIds.add(String(command.timerId))
    }
  }
  for (const timerId of [...usedTimerIds].sort()) {
    recorder.assert(declaredTimerIds.has(timerId), () => ({
      message: `timer '${timerId}' is used by the game but not declared in manifest.timers`,
      detail: `declared: ${[...declaredTimerIds].join(', ') || '(none)'}`,
    }))
  }
  if (usedTimerIds.size === 0 && declaredTimerIds.size > 0) {
    recorder.note(
      `manifest declares ${declaredTimerIds.size} timer(s) that no playout exercised; they may still be driven by onTimer`,
    )
  }

  for (const scenario of prep.scenarios) {
    recorder.assert(
      scenario.playerCount >= manifest.minPlayers && scenario.playerCount <= manifest.maxPlayers,
      () => ({
        message: `scenario '${scenario.label}' uses ${scenario.playerCount} players, outside [${manifest.minPlayers}, ${manifest.maxPlayers}]`,
      }),
    )
    recorder.assert(scenario.roster.length === scenario.playerCount, () => ({
      message: `roster for '${scenario.label}' has ${scenario.roster.length} seats, expected ${scenario.playerCount}`,
    }))
  }

  return recorder
}
