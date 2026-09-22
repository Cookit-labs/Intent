'use client'

import { useQuery } from '@tanstack/react-query'

import type { MarketPrice } from '../../lib/swap/price-types'

/**
 * What XLM trades for, on the network this app actually executes against.
 *
 * **Testnet is the headline figure, not mainnet.** A swap signed here fills
 * against testnet's book, so testnet's price is the one that describes what
 * happens to the user's own money. Mainnet sits beside it as the reference the
 * agents reason with — both are true, and which one matters depends on whether
 * you are asking "what will I get" or "is that a good rate".
 *
 * They diverge widely and permanently: testnet liquidity is synthetic, so the
 * gap is a property of the venue rather than a staleness to be corrected. Both
 * are shown rather than one reconciled figure, because averaging them would
 * describe no market at all.
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
      ? 'XLM according to Reflector, an oracle aggregating exchange prices. Used to size dollar amounts and to judge whether a testnet quote is reasonable. Not what a swap here fills at, and not what Blend liquidates against.'
      : worth?.source === 'stellar-mainnet'
        ? 'XLM on the Stellar mainnet order book. Reflector could not be read, so this single venue stands in for it.'
        : 'Neither Reflector nor the mainnet order book could be read, so this is a fallback figure rather than a live quote.'

  return (
    <span className="text-muted-foreground flex items-center gap-2 text-xs tabular-nums">
      {testnet != null ? (
        <span
          className="flex items-center gap-1.5"
          title="XLM mid price from the Stellar testnet order book — the venue this app signs against, so this is the rate your swaps actually fill near."
        >
          <span className="bg-foreground h-1.5 w-1.5 rounded-full" aria-hidden />
          <span className="text-foreground font-medium">XLM ${testnet.usd.toFixed(4)}</span>
          <span className="opacity-60">testnet</span>
        </span>
      ) : (
        <span
          className="flex items-center gap-1.5"
          title="Testnet's XLM/USDC order book could not be read, or has no offers resting on it right now."
        >
          <span className="bg-muted-foreground h-1.5 w-1.5 rounded-full" aria-hidden />
          <span className="opacity-60">testnet book unavailable</span>
        </span>
      )}

      {/* The real market, kept visible but subordinate. Dollar amounts typed
          into an intent are sized against this, and the agents compare routes
          with it, so hiding it would make those numbers unaccountable. */}
      {worth !== undefined ? (
        <span className="hidden opacity-60 lg:inline" title={worthTitle}>
          · {worthLabel} ${worth.usd.toFixed(4)}
        </span>
      ) : null}
    </span>
  )
}
