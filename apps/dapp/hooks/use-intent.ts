'use client'

import type { CreateIntentInput, Intent } from '@intent/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { getIntentClient } from '../lib/sdk'
import { fetchMarketPrices, toPriceTable } from '../lib/swap/prices'
import { useIntentStore } from '../stores/intent.store'

const client = getIntentClient()

export const intentKeys = {
  all: ['intents'] as const,
  prices: ['market-prices'] as const,
  // Keyed by chain so switching networks refetches rather than showing the
  // previous chain's cached list.
  forChain: (chain: string) => ['intents', { chain }] as const,
  detail: (id: string) => ['intents', id] as const,
}

function isLive(intent?: Intent): boolean {
  return (
    intent != null &&
    intent.status !== 'settled' &&
    intent.status !== 'failed' &&
    intent.status !== 'cancelled'
  )
}

/**
 * Live market prices, shared by every intent query.
 *
 * A limit order's status depends on the price, so the list cannot report
 * whether an order has filled without knowing what the market is doing.
 */
function useMarketPrices() {
  return useQuery({
    queryKey: intentKeys.prices,
    queryFn: async () => toPriceTable(await fetchMarketPrices()),
    // Prices move, and a limit order's status moves with them.
    refetchInterval: 30_000,
    staleTime: 15_000,
  })
}

export function useIntents(chain?: string) {
  const setIntents = useIntentStore((s) => s.setIntents)
  const { data: prices } = useMarketPrices()

  return useQuery({
    queryKey: [...(chain === undefined ? intentKeys.all : intentKeys.forChain(chain)), prices],
    queryFn: async () => {
      const data = await client.intents.list(chain, prices)
      setIntents(data)
      return data
    },
    // Limit orders are open positions: they fill when the market reaches them,
    // not when the page happens to be reloaded.
    refetchInterval: 10_000,
  })
}

export function useIntent(id: string) {
  const { data: prices } = useMarketPrices()
  return useQuery({
    queryKey: [...intentKeys.detail(id), prices],
    queryFn: () => client.intents.get(id, prices),
    // Poll while the intent is still progressing so the lifecycle animates.
    refetchInterval: (query) => (isLive(query.state.data) ? 1500 : false),
  })
}

export function useCreateIntent() {
  const queryClient = useQueryClient()
  const addIntent = useIntentStore((s) => s.addIntent)

  return useMutation({
    mutationFn: (input: CreateIntentInput) => client.intents.create(input),
    onSuccess: (created) => {
      addIntent(created)
      queryClient.invalidateQueries({ queryKey: intentKeys.all })
      queryClient.setQueryData(intentKeys.detail(created.id), created)
    },
  })
}

/**
 * Withdraw an open intent.
 *
 * Limit orders sit unfilled until the market reaches them, which is precisely
 * why they must be withdrawable — an offer with no way to take it back is a
 * commitment, not an order.
 */
export function useCancelIntent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => client.intents.cancel(id),
    onSuccess: (cancelled) => {
      queryClient.invalidateQueries({ queryKey: intentKeys.all })
      queryClient.setQueryData(intentKeys.detail(cancelled.id), cancelled)
    },
  })
}
