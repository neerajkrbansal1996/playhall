import type { Metadata, Viewport } from 'next'
import { BRAND } from '@atrium/shared'

import './globals.css'

export const metadata: Metadata = {
  // Brand comes from one constant. The final name/domain is a board decision
  // (PER-2); never hard-code a string here.
  title: BRAND.name,
  description: 'Open a lobby, share a link, play with friends. No downloads, no sign-up.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b0d12',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  )
}
