import { Suspense } from 'react'
import { notFound } from 'next/navigation'

import { BRAND } from '@playhall/shared'

import { WordmarkPreview } from './wordmark-preview'

/**
 * Measurement harness for `Wordmark` ([PER-194]).
 *
 * The acceptance test for "a rename costs one constant" is the same 56px app bar at
 * 390px holding a 4-character and a 14-character name without clipping, wrapping, or
 * pushing the bar's controls off the right edge. jsdom cannot show that — it does no
 * layout — and the real app bar belongs to [PER-20](/PER/issues/PER-20), which is
 * blocked on [PER-15](/PER/issues/PER-15). So this route stands up the bar on its own
 * so the two-name check is screenshot-able and measurable now.
 *
 * `?name=` overrides the name, which is how the two screenshots are taken from one
 * route. It is read on the client so the page stays statically exportable.
 *
 * **404 unless `NEXT_PUBLIC_WORDMARK_PREVIEW=1`**, matching `/dev/room` and
 * `/dev/settings-form`: the landing page must not pay a byte for it, and it is expected
 * to be deleted when PER-20 lands the real app bar.
 */
export const metadata = { title: 'Wordmark preview' }

export default function WordmarkPreviewPage() {
  if (process.env.NEXT_PUBLIC_WORDMARK_PREVIEW !== '1') notFound()

  // The name crosses from the app layer as a prop, exactly as it does on the landing
  // page. `?name=` only replaces the default inside the client component.
  return (
    <Suspense fallback={null}>
      <WordmarkPreview defaultName={BRAND.name} />
    </Suspense>
  )
}
