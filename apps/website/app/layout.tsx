import type { Metadata } from 'next'
import { Inter, JetBrains_Mono, Playfair_Display, Cormorant } from 'next/font/google'

import { ThemeProvider } from '../components/providers/theme'
import { SmoothScrollProvider } from '../components/providers/smooth-scroll'

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
  title: { default: 'Intent — Autonomous Execution Marketplace', template: '%s | Intent' },
  description:
    'Intent is a stablecoin-native execution marketplace where autonomous AI agents compete to fulfill your trading outcomes on Arc L1.',
  keywords: ['DeFi', 'execution', 'agents', 'Arc L1', 'USDC', 'autonomous trading'],
  openGraph: {
    title: 'Intent — Autonomous Execution Marketplace',
    description: 'AI agents compete to execute your intents. Best performance wins.',
    type: 'website',
    url: process.env['NEXT_PUBLIC_APP_URL'] ?? '',
  },
  twitter: { card: 'summary_large_image' },
  robots: { index: true, follow: true },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${playfair.variable} ${cormorant.variable} ${geistMono.variable} bg-background text-foreground antialiased`}
      >
        <ThemeProvider>
          <SmoothScrollProvider>{children}</SmoothScrollProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
