import type { ReactNode } from 'react'
import type { Viewport } from 'next'
import { Schibsted_Grotesk } from 'next/font/google'
import './globals.css'

const sans = Schibsted_Grotesk({ subsets: ['latin'], variable: '--font-schibsted', display: 'swap' })

export const metadata = { title: 'aos', robots: { index: false, follow: false } }

export const viewport: Viewport = { themeColor: '#12161d', width: 'device-width', initialScale: 1, viewportFit: 'cover' }

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en" className={sans.variable}>
    <body className="min-h-dvh font-sans antialiased">{children}</body>
  </html>
)

export default RootLayout
