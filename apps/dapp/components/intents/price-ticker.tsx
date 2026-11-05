'use client'

import { activeNetwork } from '@intent/config'
import { useQuery } from '@tanstack/react-query'

import type { MarketPrice } from '../../lib/swap/price-types'
import { CoinStat } from './coin-stat'

/**
 * What XLM trades for, on the network this app actually executes against.
 *
 * **The execution network's book is the headline figure.** A swap signed
 * here fills against that book, so its price is the one that describes what
 * happens to the user's own money. "What it is worth" sits beside it as the
 * reference the agents reason with — both are true, and which one matters
 * depends on whether you are asking "what will I get" or "is that a good
 * rate".
 *
 * On testnet they diverge widely and permanently: its liquidity is synthetic,
 * so the gap is a property of the venue rather than a staleness to be
 * corrected. Both are shown rather than one reconciled figure, because
 * averaging them would describe no market at all.
 */
async function loadTestnetPrice(): Promise<MarketPrice | null> {
  const res = await fetch('/api/prices/testnet')
  if (!res.ok) return null
  const body = (await res.json()) as { price?: MarketPrice | null }
  return body.price ?? null
}

export function PriceTicker({
  prices,
}: {
  /** Mainnet readings, already loaded for sizing. */
  prices: Record<string, MarketPrice> | undefined
}): JSX.Element | null {
  const here = activeNetwork()
  const { data: testnet } = useQuery({
    queryKey: ['testnet-xlm-price'],
    queryFn: loadTestnetPrice,
    // Testnet's book is thin and moves on whoever last traded, so this is
    // refreshed rather than read once per mount.
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  // "What is it worth" — Reflector when it answers, the mainnet book when it
  // does not, a labelled fallback when nothing does. The label follows the
  // source rather than assuming one, because a Reflector reading and a
  // hardcoded guess are both plausible-looking numbers.
  const worth = prices?.['XLM']
  if (testnet == null && worth === undefined) return null

  const worthLabel =
    worth?.source === 'reflector'
      ? 'oracle'
      : worth?.source === 'stellar-mainnet'
        ? 'mainnet'
        : 'fallback'
  const worthTitle =
    worth?.source === 'reflector'
      ? 'XLM according to Reflector, an oracle aggregating exchange prices. Used to size dollar amounts and to judge whether a quote here is reasonable. Not what a swap here fills at, and not what Blend liquidates against.'
      : worth?.source === 'stellar-mainnet'
        ? 'XLM on the Stellar mainnet order book. Reflector could not be read, so this single venue stands in for it.'
        : 'Neither Reflector nor the mainnet order book could be read, so this is a fallback figure rather than a live quote.'

  const bookTitle =
    testnet != null
      ? `XLM mid price from the Stellar ${here} order book — the venue this app signs against, so this is the rate your swaps actually fill near.`
      : `The ${here} XLM/USDC order book could not be read, or has no offers resting on it right now.`

  return (
    <CoinStat
      figure={testnet != null ? `$${testnet.usd.toFixed(4)}` : 'XLM'}
      title={worth !== undefined ? `${bookTitle} ${worthTitle}` : bookTitle}
      label={
        <>
          {here === 'mainnet'
            ? testnet != null
              ? 'XLM price'
              : 'Price unavailable'
            : testnet != null
              ? `XLM on ${here}`
              : `${here} book unavailable`}
          {/* The real market, kept visible but subordinate. Dollar amounts typed
              into an intent are sized against this, and the agents compare routes
              with it, so hiding it would make those numbers unaccountable. */}
          {worth !== undefined ? (
            <span className="hidden lg:inline">
              , {worthLabel} ${worth.usd.toFixed(4)}
            </span>
          ) : null}
        </>
      }
    />
  )
}
