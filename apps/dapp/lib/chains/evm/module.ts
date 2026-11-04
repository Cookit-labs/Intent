import { oneClickPrice } from '../near/oneclick'
import { canIssueOneClick, oneClickAssetId, oneClickOriginVenue } from '../oneclick-origin'
import type { ChainModule, ChainToken, ChainVenue } from '../types'
import { readEvmBalances } from './balances'
import { EVM_CHAINS, type EvmChain } from './tokens'

export function buildEvmVenues(
  chain: EvmChain,
  env: Record<string, string | undefined> = process.env
): ChainVenue[] {
  return canIssueOneClick(env) ? [oneClickOriginVenue(chain)] : []
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
    defaultVenue: { swap: `1click-${chain}` },
    priceUsd: (token) => priceFromOneClick(chain, token),
    // Every venue here lands its own transactions, and no venue means no submit gets this far.
    submit: async () => ({
      ok: false,
      pending: true,
      error:
        "This app can't follow that from here. Check your wallet's activity before trying again.",
    }),
    balances: (account) => readEvmBalances(chain, account),
    ...(tokenHints !== undefined ? { tokenHints } : {}),
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
