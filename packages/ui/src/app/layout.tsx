import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentOS · nova',
  description: 'Your personal AI crew. Local, private, playful.',
};

export const viewport: Viewport = {
  themeColor: '#0B0518',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
