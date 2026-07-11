import type { Metadata } from 'next'
import { Inter, JetBrains_Mono, Playfair_Display, Cormorant } from 'next/font/google'

import { AppShell } from '../components/layout/app-shell'
import { RootProviders } from '../providers/root'

import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const playfair = Playfair_Display({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-playfair',
  display: 'swap',
})
const cormorant = Cormorant({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-cormorant',
  display: 'swap',
})
const geistMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: { default: 'Intent Terminal', template: '%s | Intent' },
  description: 'Submit intents. Watch agents compete. Settle on-chain.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${playfair.variable} ${cormorant.variable} ${geistMono.variable} bg-background text-foreground antialiased`}
      >
        <RootProviders>
          <AppShell>{children}</AppShell>
        </RootProviders>
      </body>
    </html>
  )
}
