'use client'

import { useQuery } from '@tanstack/react-query'

import type { BlendPosition } from '../lib/lend/position'
import { useWallet } from './use-wallet'

/**
 * What this account currently holds in Blend.
 *
 * Read from the pool on an interval rather than recorded when the supply was
 * made. A position grows every ledger as interest accrues, and can be added to
 * or withdrawn from another client entirely — so a figure this app stored at
 * supply time would be wrong within seconds and misleading within a day.
 *
 * Null is a real answer meaning "nothing supplied", distinct from `undefined`
 * while loading and from an error. A caller that conflates them either shows an
 * empty position as a failure, or a failure as an empty position.
 */
async function loadPosition(account: string): Promise<BlendPosition | null> {
  const res = await fetch(`/api/lend/position?account=${encodeURIComponent(account)}`)
  if (!res.ok) throw new Error('could not read your Blend position')
  const body = (await res.json()) as { position?: BlendPosition | null }
  return body.position ?? null
}

export function useBlendPosition(): {
  position: BlendPosition | null | undefined
  loading: boolean
  error: boolean
} {
  const { address, isConnected } = useWallet()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['blend-position', address],
    queryFn: () => loadPosition(address as string),
    enabled: isConnected && address !== undefined,
    // Interest accrues continuously, but not fast enough to warrant hammering
    // the RPC — a minute keeps the figure honest without the noise.
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  return { position: data, loading: isLoading, error: isError }
}
