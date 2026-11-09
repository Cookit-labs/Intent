import { oneClickPrice } from '../near/oneclick'
import { canIssueOneClick, oneClickAssetId, oneClickOriginVenue } from '../oneclick-origin'
import { createSendVenue, SEND_VENUE_ID } from '../send'
import type { ChainModule, ChainToken, ChainVenue } from '../types'
import {
  AAVE_AVALANCHE_MARKET,
  AAVE_MONAD_MARKET,
  aaveAvalancheVenue,
  aaveMonadVenue,
  aaveOraclePriceUsd,
  neverlandVenue,
} from './aave'
import { readEvmBalances } from './balances'
import { beefyMonadVenue } from './beefy'
import { createBullaVenue } from './bulla'
import { COW_VENUE_ID, cowBook, cowVenue } from './cow'
import { curvanceVenue } from './curvance'
import { createEulerMonadVenue } from './euler'
import { createFastlaneVenue, SHMON, shmonPriceUsd } from './fastlane'
import { createMorphoVenue } from './morpho'
import { createPharaohVenue } from './pharaoh'
import { sablierAvalancheVenue, sablierMonadVenue } from './sablier'
import { EVM_CHAINS, EVM_NATIVE_ID, type EvmChain } from './tokens'
import { createUniswapVenue } from './uniswap'

/** Needing no secret, so these run whether or not this deployment can issue 1Click. */
const ONCHAIN_VENUES: Record<EvmChain, () => ChainVenue[]> = {
  avalanche: () => [
    createUniswapVenue('avalanche'),
    createPharaohVenue(),
    aaveAvalancheVenue,
    sablierAvalancheVenue,
    createBullaVenue(),
  ],
  monad: () => [
    createUniswapVenue('monad'),
    aaveMonadVenue,
    neverlandVenue,
    createMorphoVenue(),
    createEulerMonadVenue(),
    curvanceVenue,
    beefyMonadVenue,
    createFastlaneVenue(),
    sablierMonadVenue,
  ],
}

export function buildEvmVenues(
  chain: EvmChain,
  env: Record<string, string | undefined> = process.env
): ChainVenue[] {
  const oneClick = canIssueOneClick(env)
  // CoW has no deployment on Monad, so its limit orders are Avalanche's alone.
  const limit = chain === 'avalanche' ? [cowVenue] : []
  return [
    ...(oneClick ? [oneClickOriginVenue(chain)] : []),
    ...ONCHAIN_VENUES[chain](),
    ...limit,
    ...(oneClick ? [createSendVenue(chain)] : []),
  ]
}

async function priceFromOneClick(chain: EvmChain, token: ChainToken): Promise<number | undefined> {
  try {
    const assetId = await oneClickAssetId(chain, token)
    return assetId === undefined ? undefined : await oneClickPrice(assetId, token.decimals)
  } catch {
    return undefined
  }
}

const AAVE_MARKET = { avalanche: AAVE_AVALANCHE_MARKET, monad: AAVE_MONAD_MARKET }
const WRAPPED_SYMBOL = { avalanche: 'WAVAX', monad: 'WMON' }

function tokenNamed(chain: EvmChain, symbol: string): ChainToken | undefined {
  return EVM_CHAINS[chain].tokens.find((t) => t.symbol === symbol)
}

/** A token 1Click doesn't list, or any token while 1Click can't answer, from Aave's own oracle. */
async function priceFromOracle(chain: EvmChain, token: ChainToken): Promise<number | undefined> {
  const priced = token.id === EVM_NATIVE_ID ? tokenNamed(chain, WRAPPED_SYMBOL[chain]) : token
  return priced === undefined ? undefined : aaveOraclePriceUsd(AAVE_MARKET[chain], priced)
}

/**
 * Priced from 1Click's list, as NEAR is, then from the oracle. A wrapped coin is priced as the coin,
 * and shMON from what it redeems for. Each token has one answer, so every route out to it is ranked
 * at the same price. Any doubt is no price, which refuses the trade.
 */
async function priceOf(chain: EvmChain, token: ChainToken): Promise<number | undefined> {
  const native = tokenNamed(chain, EVM_CHAINS[chain].nativeSymbol)
  if (token.id === SHMON) {
    return shmonPriceUsd(native === undefined ? undefined : await priceOf(chain, native))
  }
  const listed = token.symbol === WRAPPED_SYMBOL[chain] ? native : token
  const fromOneClick = listed === undefined ? undefined : await priceFromOneClick(chain, listed)
  return fromOneClick ?? priceFromOracle(chain, token)
}

function evmModule(
  chain: EvmChain,
  defaults: ChainModule['defaultVenue'],
  tokenHints?: Record<string, string>
): ChainModule {
  return {
    chain,
    tokens: EVM_CHAINS[chain].tokens,
    venues: buildEvmVenues(chain),
    defaultVenue: {
      swap: `1click-${chain}`,
      send: SEND_VENUE_ID,
      ...defaults,
      ...(chain === 'avalanche' ? { limit: COW_VENUE_ID } : {}),
    },
    priceUsd: (token) => priceOf(chain, token),
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

export const avalancheModule: ChainModule = {
  ...evmModule('avalanche', {
    supply: 'aave-avalanche',
    withdraw: 'aave-avalanche',
    borrow: 'aave-avalanche',
    repay: 'aave-avalanche',
    stream: 'sablier-avalanche',
    cancel: 'sablier-avalanche',
    invoice: 'bulla',
    pay_invoice: 'bulla',
  }),
  // 1Click, the default, doesn't list WAVAX.
  venueForToken: { swap: { WAVAX: 'uniswap-avalanche' } },
  wrappedToken: { AVAX: 'WAVAX' },
}

/**
 * USDT is not matched to USDT0. A person is told instead, so nothing gets signed under a name they
 * didn't type, and the one token keeps the one name on the card, in the wallet and in 1Click's list.
 */
export const monadModule = evmModule(
  'monad',
  {
    supply: 'aave-monad',
    withdraw: 'aave-monad',
    borrow: 'aave-monad',
    repay: 'aave-monad',
    stake: 'fastlane',
    unstake: 'fastlane',
    stream: 'sablier-monad',
    cancel: 'sablier-monad',
  },
  { USDT: 'On Monad, Tether’s dollar is called USDT0, so ask for USDT0.' }
)
