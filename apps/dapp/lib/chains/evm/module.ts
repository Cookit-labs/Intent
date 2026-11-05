import { oneClickPrice } from '../near/oneclick'
import { canIssueOneClick, oneClickAssetId, oneClickOriginVenue } from '../oneclick-origin'
import { createSendVenue, SEND_VENUE_ID } from '../send'
import type { ChainModule, ChainToken, ChainVenue } from '../types'
import { readEvmBalances } from './balances'
import { COW_VENUE_ID, cowBook, cowVenue } from './cow'
import { EVM_CHAINS, type EvmChain } from './tokens'

export function buildEvmVenues(
  chain: EvmChain,
  env: Record<string, string | undefined> = process.env
): ChainVenue[] {
  // CoW has no deployment on Monad, so its limit orders are Avalanche's alone.
  const limit = chain === 'avalanche' ? [cowVenue] : []
  return [
    ...limit,
    ...(canIssueOneClick(env) ? [oneClickOriginVenue(chain), createSendVenue(chain)] : []),
  ]
}

/**
 * Priced from 1Click's list, as NEAR is. Every route here comes from that one venue, so one source
 * can't rank two routes by a gap between sources. Any doubt is no price, which refuses the trade.
 */
async function priceFromOneClick(chain: EvmChain, token: ChainToken): Promise<number | undefined> {
  try {
    const assetId = await oneClickAssetId(chain, token)
    return assetId === undefined ? undefined : await oneClickPrice(assetId, token.decimals)
  } catch {
    return undefined
  }
}

function evmModule(chain: EvmChain, tokenHints?: Record<string, string>): ChainModule {
  return {
    chain,
    tokens: EVM_CHAINS[chain].tokens,
    venues: buildEvmVenues(chain),
    defaultVenue: {
      swap: `1click-${chain}`,
      send: SEND_VENUE_ID,
      ...(chain === 'avalanche' ? { limit: COW_VENUE_ID } : {}),
    },
    priceUsd: (token) => priceFromOneClick(chain, token),
    // Every venue here lands its own transactions or posts its own orders, and no venue means no
    // submit gets this far.
    submit: async () => ({
      ok: false,
      pending: true,
      error:
        "This app can't follow that from here. Check your wallet's activity before trying again.",
    }),
    balances: (account, signal) => readEvmBalances(chain, account, undefined, signal),
    ...(tokenHints !== undefined ? { tokenHints } : {}),
    ...(chain === 'avalanche' ? { limitBook: cowBook() } : {}),
  }
}

export const avalancheModule = evmModule('avalanche')

/**
 * USDT is not matched to USDT0. A person is told instead, so nothing gets signed under a name they
 * didn't type, and the one token keeps the one name on the card, in the wallet and in 1Click's list.
 */
export const monadModule = evmModule('monad', {
  USDT: 'On Monad, Tether’s dollar is called USDT0, so ask for USDT0.',
})
