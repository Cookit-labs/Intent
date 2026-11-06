import { http, parseAbi, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AAVE_AVALANCHE_MARKET,
  AAVE_MONAD_MARKET,
  createAaveVenue,
  NEVERLAND_MARKET,
  type AaveMarket,
} from '../chains/evm/aave'
import { evmReader } from '../chains/evm/client'
import { sameAddress } from '../chains/evm/submit'
import type { EvmChain } from '../chains/evm/tokens'

/**
 * That the pinned contracts still are what they were checked to be. Read-only: nothing signs or
 * sends. Set the chain's RPC env where the public one rate limits.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const SLOW_MS = 60_000
// Burned, so it can never move. It holds about 0.05 USDC supplied on Aave on Avalanche.
const BURN = '0x000000000000000000000000000000000000dEaD'

const RPC: Record<EvmChain, string> = {
  avalanche: process.env['AVALANCHE_RPC_URL'] ?? 'https://avalanche-c-chain-rpc.publicnode.com',
  monad: process.env['MONAD_RPC_URL'] ?? 'https://rpc.monad.xyz',
}

function reader(chain: EvmChain) {
  return evmReader(chain, http(RPC[chain], { timeout: 20_000, retryCount: 2 }))
}

const PROVIDER_ABI = parseAbi([
  'function getPool() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function getPriceOracle() view returns (address)',
])
const POOL_ABI = parseAbi([
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getReservesList() view returns (address[])',
])
const ORACLE_ABI = parseAbi(['function BASE_CURRENCY_UNIT() view returns (uint256)'])
const DECIMALS_ABI = parseAbi(['function decimals() view returns (uint8)'])

describe.skipIf(SKIP).each<[string, AaveMarket]>([
  ['Aave on Avalanche', AAVE_AVALANCHE_MARKET],
  ['Aave on Monad', AAVE_MONAD_MARKET],
  ['Neverland on Monad', NEVERLAND_MARKET],
])('%s, live', (_name, market) => {
  const client = reader(market.chain)
  const provider = market.addressesProvider as Address
  const pool = market.pool as Address

  it(
    'has code at every pinned contract',
    async () => {
      for (const address of [market.pool, market.addressesProvider, market.dataProvider]) {
        const code = await client.getCode({ address: address as Address })
        expect((code?.length ?? 0) > 2, address).toBe(true)
      }
    },
    SLOW_MS
  )

  it(
    'has a provider and pool that name each other, and the same data provider',
    async () => {
      const read = <T extends 'getPool' | 'getPoolDataProvider'>(functionName: T) =>
        client.readContract({ address: provider, abi: PROVIDER_ABI, functionName })
      expect(sameAddress(await read('getPool'), market.pool)).toBe(true)
      expect(sameAddress(await read('getPoolDataProvider'), market.dataProvider)).toBe(true)
      const named = await client.readContract({
        address: pool,
        abi: POOL_ABI,
        functionName: 'ADDRESSES_PROVIDER',
      })
      expect(sameAddress(named, provider)).toBe(true)
    },
    SLOW_MS
  )

  it(
    'lists every token here as a reserve, with the decimals here',
    async () => {
      const reserves = await client.readContract({
        address: pool,
        abi: POOL_ABI,
        functionName: 'getReservesList',
      })
      for (const token of market.tokens) {
        expect(
          reserves.some((reserve) => sameAddress(reserve, token.id)),
          token.symbol
        ).toBe(true)
        const decimals = await client.readContract({
          address: token.id as Address,
          abi: DECIMALS_ABI,
          functionName: 'decimals',
        })
        expect(decimals, token.symbol).toBe(token.decimals)
      }
    },
    SLOW_MS
  )

  it(
    'prices in dollars with eight decimals',
    async () => {
      const oracle = await client.readContract({
        address: provider,
        abi: PROVIDER_ABI,
        functionName: 'getPriceOracle',
      })
      const unit = await client.readContract({
        address: oracle,
        abi: ORACLE_ABI,
        functionName: 'BASE_CURRENCY_UNIT',
      })
      expect(unit).toBe(BigInt(100_000_000))
    },
    SLOW_MS
  )

  it(
    'reads a supply rate for USDC through the venue',
    async () => {
      const venue = createAaveVenue(market, client)
      const quote = await venue.quote!({ kind: 'supply', amount: '1', tokenIn: 'USDC' }, BURN)
      expect(quote.apyPercent).toBeGreaterThanOrEqual(0)
      expect(quote.apyPercent).toBeLessThan(100)
    },
    SLOW_MS
  )

  it(
    'refuses a borrow with no collateral behind it',
    async () => {
      const empty = '0x000000000000000000000000000000000000bEEF'
      const venue = createAaveVenue(market, client)
      await expect(
        venue.prepare({ kind: 'borrow', amount: '1', tokenIn: 'USDC' }, empty)
      ).rejects.toThrow(/Nothing was signed or sent/)
    },
    SLOW_MS
  )
})

describe.skipIf(SKIP)('A withdraw built against the real Pool', () => {
  it(
    'passes the chain’s own trial of the call',
    async () => {
      const venue = createAaveVenue(AAVE_AVALANCHE_MARKET, reader('avalanche'))
      const prepared = await venue.prepare(
        { kind: 'withdraw', amount: '0.01', tokenIn: 'USDC' },
        BURN
      )
      expect(() => venue.assertSafe(prepared.signing, BURN)).not.toThrow()
    },
    SLOW_MS
  )
})
