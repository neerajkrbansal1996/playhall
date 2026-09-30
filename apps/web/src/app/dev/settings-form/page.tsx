import { notFound } from 'next/navigation'

import {
  normalizeSettingsForm,
  warnAboutSkippedFields,
} from '@/components/settings-form/normalize'

import { CreateLobbyPreview } from './create-lobby-preview'
import catalogEntry from './catalog-entry.json'

/**
 * Measurement harness for the settings-form renderer ([PER-43]).
 *
 * ADR-0004 books a measurement against Frontend Engineer: create-lobby LCP on a
 * mid-range Android over 4G, versus the < 2 s target. That needs a real page in a
 * real production build, and the create-lobby route itself belongs to
 * [PER-20](/PER/issues/PER-20) and depends on the game registry
 * ([PER-12](/PER/issues/PER-12)) — neither of which has landed. So this route
 * renders the same component tree from a JSON catalogue slice on disk: the same
 * bytes, the same client bundle, no registry.
 *
 * It is **404 unless `NEXT_PUBLIC_SETTINGS_FORM_PREVIEW=1`**, so it costs the
 * shipped app nothing, and it is expected to be deleted when PER-20 lands the
 * real `/play/[slug]/new`.
 */
export const metadata = { title: 'Settings form preview' }

export default function SettingsFormPreviewPage() {
  if (process.env.NEXT_PUBLIC_SETTINGS_FORM_PREVIEW !== '1') notFound()

  // The zod parse happens here, on the server, and only the validated descriptor
  // crosses to the client — that is the whole reason the create-lobby bundle does
  // not carry a validator.
  const normalized = normalizeSettingsForm(catalogEntry.settingsForm)
  warnAboutSkippedFields(normalized)

  return (
    <CreateLobbyPreview
      gameName={catalogEntry.name}
      form={normalized.form}
      defaultSettings={catalogEntry.defaultSettings}
      presets={catalogEntry.presets}
    />
  )
}
