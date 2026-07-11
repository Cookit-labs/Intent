'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { RainbowKitProvider, lightTheme } from '@rainbow-me/rainbowkit'
import { WagmiProvider } from 'wagmi'
import { ThemeProvider } from 'next-themes'
import { useState } from 'react'

import { wagmiConfig } from '../lib/wagmi.config'

import '@rainbow-me/rainbowkit/styles.css'

export function RootProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, retry: 1 },
        },
      })
  )

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={lightTheme({
            accentColor: '#6366f1',
            accentColorForeground: '#ffffff',
            borderRadius: 'small',
            fontStack: 'system',
          })}
        >
          <ThemeProvider attribute="class" defaultTheme="light" forcedTheme="light">
            {children}
          </ThemeProvider>
        </RainbowKitProvider>
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </WagmiProvider>
  )
}
