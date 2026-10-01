import { notFound } from 'next/navigation'

import { RoomPreview } from './room-preview'

/**
 * Harness route for the platform room surfaces ([PER-141]).
 *
 * The real `/r/[code]` and `/play/[slug]/new` routes belong to
 * [PER-20](/PER/issues/PER-20) and cannot be built before the lobby protocol
 * on [PER-15](/PER/issues/PER-15) gives them room state to render. This route
 * mounts the same components from static props so the M2 E2E selector surface
 * is visible, screenshot-able and measurable now.
 *
 * **404 unless `NEXT_PUBLIC_ROOM_PREVIEW=1`**, matching
 * `/dev/settings-form`: the landing page must not pay a byte for it, and it is
 * expected to be deleted when PER-20 lands the real routes.
 */
export const metadata = { title: 'Room surfaces preview' }

export default function RoomPreviewPage() {
  if (process.env.NEXT_PUBLIC_ROOM_PREVIEW !== '1') notFound()

  return <RoomPreview />
}
