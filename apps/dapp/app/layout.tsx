import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import localFont from 'next/font/local'
import { SpaceGrotesk } from 'next/font/google'

import { RootProviders } from '../providers/root'

import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const spaceGrotesk = SpaceGrotesk({ subsets: ['latin'], variable: '--font-space-grotesk', display: 'swap' })
const geistMono = localFont({
  src: '../public/fonts/GeistMono-Regular.woff2',
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
      <body className={`${inter.variable} ${spaceGrotesk.variable} ${geistMono.variable} bg-[#09090b] text-zinc-50 antialiased`}>
        <RootProviders>{children}</RootProviders>
      </body>
    </html>
  )
}