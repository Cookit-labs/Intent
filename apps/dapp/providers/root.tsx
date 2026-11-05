'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { ThemeProvider } from 'next-themes'
import { useState } from 'react'

import { quietExtensionErrors } from '../lib/extension-console'
import { wagmiConfig } from '../lib/wagmi.config'

// At module load, so it wraps the dev overlay's console hook, which is already in place.
if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
  quietExtensionErrors(console)
}

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
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
