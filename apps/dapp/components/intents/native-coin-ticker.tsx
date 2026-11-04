'use client'

import { useQuery } from '@tanstack/react-query'

import { formatCoinUsd, type NativeCoinPrice } from '../../lib/prices/native-coin'
import { useChain } from '../../providers/chain-provider'
import { CoinStat } from './coin-stat'

async function loadPrice(chain: string): Promise<NativeCoinPrice | null> {
  const res = await fetch(`/api/prices/native?chain=${encodeURIComponent(chain)}`)
  if (!res.ok) throw new Error('could not read the price')
  const body = (await res.json()) as { price?: NativeCoinPrice | null }
  return body.price ?? null
}

/** The live price of the coin of the chain this page is on. */
export function NativeCoinTicker(): JSX.Element | null {
  const { slug, descriptor } = useChain()
  const { symbol } = descriptor.nativeCurrency
  const { data: price, isPending } = useQuery({
    queryKey: ['native-coin-price', slug],
    queryFn: () => loadPrice(slug),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  if (isPending) return null

  if (price == null) {
    return (
      <CoinStat
        figure={symbol}
        label="Price unavailable"
        title={`No up-to-date ${symbol} price right now. This checks again every minute.`}
      />
    )
  }

  return (
    <CoinStat
      figure={formatCoinUsd(price.usd)}
      label={`${symbol} price`}
      title={`${descriptor.nativeCurrency.name} (${symbol}) in US dollars, updated every minute.`}
    />
  )
}
