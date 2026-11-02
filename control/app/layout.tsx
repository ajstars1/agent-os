import type { ReactNode } from 'react'
import type { Viewport } from 'next'
import './globals.css'

export const metadata = { title: 'aos control', robots: { index: false, follow: false } }

export const viewport: Viewport = { themeColor: '#0b0d10', width: 'device-width', initialScale: 1 }

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en" className="dark">
    <body className="min-h-dvh font-sans antialiased">{children}</body>
  </html>
)

export default RootLayout
