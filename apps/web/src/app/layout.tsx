import type { Metadata, Viewport } from 'next'
import { BRAND } from '@playhall/shared'

import './globals.css'

export const metadata: Metadata = {
  // Brand comes from one constant. The name is approved; the domain and logo are
  // still a board decision (PER-2). Never hard-code a brand string here.
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
