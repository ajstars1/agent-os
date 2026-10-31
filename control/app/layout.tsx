import type { ReactNode } from 'react'

export const metadata = { title: 'aos control', robots: { index: false } }

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <body style={{ fontFamily: 'system-ui', margin: 24 }}>{children}</body>
  </html>
)

export default RootLayout
