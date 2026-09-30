'use client'

import { useState } from 'react'
import type { SettingsFormDescriptor } from '@playhall/game-sdk'

import { Button } from '@/components/ui/button'
import { testIds } from '@/lib/testids'
import {
  PresetQuickStart,
  SettingsForm,
  useSettingsForm,
  type SettingsFieldErrors,
  type SettingsFormPreset,
  type SettingsValues,
} from '@/components/settings-form'

export interface CreateLobbyPreviewProps {
  readonly gameName: string
  /** Already normalized by the server component above. */
  readonly form: SettingsFormDescriptor
  readonly defaultSettings: unknown
  readonly presets: readonly SettingsFormPreset[]
}

/**
 * The create-lobby composition, with the network stubbed out.
 *
 * This is the shape [PER-20](/PER/issues/PER-20)'s real page will take — quick
 * start above the form, form below, one primary action — so measuring this
 * measures the renderer in the layout it will ship in.
 */
export function CreateLobbyPreview({
  gameName,
  form,
  defaultSettings,
  presets,
}: CreateLobbyPreviewProps) {
  const settings = useSettingsForm({ defaultSettings, presets })
  const [submitted, setSubmitted] = useState<SettingsValues | null>(null)

  // Stands in for the field-keyed errors a create-lobby response returns, so the
  // error path has a rendered state to look at rather than only a test.
  const [errors, setErrors] = useState<SettingsFieldErrors>({})

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">New {gameName} lobby</h1>
        <p className="text-muted-foreground text-sm">
          Pick a quick start, or set it up yourself below.
        </p>
      </header>

      <PresetQuickStart
        presets={presets}
        defaults={settings.values}
        onQuickStart={(next) => setSubmitted(next)}
      />

      <hr className="border-border" />

      {/*
        A real `<form>` with the contract's testid, not a bare div: submitting
        is the setup step of every E2E scenario, and a form gives Enter-to-submit
        for free — one fewer tap on a phone, and keyboard parity without a
        handler.
      */}
      <form
        data-testid={testIds.createLobbyForm}
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitted(settings.values)
        }}
        className="flex flex-col gap-6"
      >
        <SettingsForm
          form={form}
          values={settings.values}
          onChange={settings.setValue}
          errors={errors}
          presets={presets}
          activePresetId={settings.activePresetId}
          onApplyPreset={settings.applyPreset}
        />

        <Button type="submit" data-testid={testIds.createLobbySubmit}>
          Create lobby
        </Button>
      </form>

      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          onClick={() =>
            setErrors((current): SettingsFieldErrors =>
              Object.keys(current).length > 0
                ? {}
                : { timeControl: 'That time control is unavailable right now.' },
            )
          }
        >
          Toggle a server error
        </Button>
      </div>

      {submitted === null ? null : (
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
          {JSON.stringify(submitted, null, 2)}
        </pre>
      )}
    </main>
  )
}
