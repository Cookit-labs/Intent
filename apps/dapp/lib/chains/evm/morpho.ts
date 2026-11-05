import {
  decodeAbiParameters,
  encodeAbiParameters,
  erc20Abi,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'

import { ChainActionRefused, type ChainToken, type PreparedAction } from '../types'
import type { EvmReaderClient } from './call'
import {
  createVaultVenue,
  type ReviewedVault,
  type VaultVenueConfig,
  type VaultVenueDeps,
} from './erc4626'
import { sameAddress } from './submit'

/**
 * Morpho on Monad only. Morpho Blue holds $536 on Avalanche (DefiLlama), which is not worth a venue.
 *
 * Reviewed and left out on Monad: Hyperithm USDC Apex (none free to withdraw), SharpByte USDC High
 * Yield (lends against principal tokens at 91.5%, and its curator can add a withdrawal gate with
 * no notice), August USDC V2 (a rate near 18%, so not taken further).
 */

// Morpho's Monad table at docs.morpho.org/developers/contracts/addresses, code confirmed by RPC.
export const MORPHO_BLUE_MONAD = '0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee'
export const VAULT_V2_FACTORY_MONAD = '0x8B2F922162FBb60A6a072cC784A2E4168fB0bb0c'

const MONAD_USDC: ChainToken = {
  symbol: 'USDC',
  id: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  decimals: 6,
  name: 'USD Coin',
}

// Listed by Morpho's registry (blue-api.morpho.org) with curator 0x827e86...aDeCdB, which that
// registry names Steakhouse Financial. `isVaultV2` is true on the factory above.
export const MORPHO_VAULT: ReviewedVault = {
  address: '0xbeEFf443C3CbA3E369DA795002243BeaC311aB83',
  name: 'Steakhouse High Yield USDC',
  shareSymbol: 'bbqUSDC',
  shareDecimals: 18,
  asset: MONAD_USDC,
  curator: 'Steakhouse Financial',
}

/** The vault's only adapter, read from the vault. Another one means another review. */
export const MORPHO_ADAPTER = '0x607560Aa49da53bC550E40751E90D2057486D0f5'

/** Morpho Blue market ids the adapter lends to, read from it: XAUt0, WMON, WETH, WBTC. */
export const MORPHO_REVIEWED_MARKETS: readonly string[] = [
  '0x51efed9df487fd3e316421212683e04cfdb198d470c5c936ae4f36efb45b213d',
  '0xcaa68590c9fd1815f5f2e9f61c2001061813f6e346f07505b9e9b3d228b4aa13',
  '0x409f2824aee2d8391d4a5924935e13312e157055e262b923b60c9dcb47e6311d',
  '0xe35c5abc6418b6319b014e07aa3c86163a870a957284128f03cf7a9e414f8899',
]

const VAULT_V2_ABI = parseAbi([
  'function adaptersLength() view returns (uint256)',
  'function adapters(uint256 index) view returns (address)',
  'function liquidityAdapter() view returns (address)',
  'function liquidityData() view returns (bytes)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
])

const ADAPTER_ABI = parseAbi([
  'function marketIdsLength() view returns (uint256)',
  'function marketIds(uint256 index) view returns (bytes32)',
])

const MORPHO_BLUE_ABI = parseAbi([
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
])

const MARKET_PARAMS = [
  { type: 'address' },
  { type: 'address' },
  { type: 'address' },
  { type: 'address' },
  { type: 'uint256' },
] as const

const vaultAddress = MORPHO_VAULT.address as Address
const WEEK_SECONDS = 7 * 86_400
const YEAR_SECONDS = 365 * 86_400
const MONAD_BLOCK_SECONDS = 0.4
/** Enough shares that the price reads to about twelve significant figures. */
const PRICE_SHARES = BigInt('1000000000000000000000000')

/**
 * Only cash in the vault and the market its liquidity adapter points at can pay a withdrawal, so
 * `maxWithdraw`, which always answers zero on this vault type, couldn't say.
 */
export async function readMorphoLiquidity(reader: EvmReaderClient): Promise<bigint> {
  const [idle, adapter, data] = await Promise.all([
    reader.readContract({
      address: MORPHO_VAULT.asset.id as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [vaultAddress],
    }),
    reader.readContract({
      address: vaultAddress,
      abi: VAULT_V2_ABI,
      functionName: 'liquidityAdapter',
    }),
    reader.readContract({
      address: vaultAddress,
      abi: VAULT_V2_ABI,
      functionName: 'liquidityData',
    }),
  ])
  if (adapter === zeroAddress || data === '0x') return idle

  const params = decodeAbiParameters(MARKET_PARAMS, data as Hex)
  if (!sameAddress(params[0], MORPHO_VAULT.asset.id)) {
    throw new Error('The liquidity market lends another token.')
  }
  const id = keccak256(encodeAbiParameters(MARKET_PARAMS, params))
  const [market, position] = await Promise.all([
    reader.readContract({
      address: MORPHO_BLUE_MONAD as Address,
      abi: MORPHO_BLUE_ABI,
      functionName: 'market',
      args: [id],
    }),
    reader.readContract({
      address: MORPHO_BLUE_MONAD as Address,
      abi: MORPHO_BLUE_ABI,
      functionName: 'position',
      args: [id, adapter],
    }),
  ])
  const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets] = market
  const [supplyShares] = position
  const free = totalSupplyAssets - totalBorrowAssets
  const held =
    totalSupplyShares === BigInt(0)
      ? BigInt(0)
      : (supplyShares * totalSupplyAssets) / totalSupplyShares
  return idle + (held < free ? held : free)
}

/**
 * What the vault actually paid over the past week, from its share price at both ends. The vault
 * has no current rate of its own to read, and the price is already after its fee and before any
 * rewards. An RPC with no history gives no rate. A price that fell is a loss, which stops a deposit.
 */
export async function readMorphoApy(reader: EvmReaderClient): Promise<PreparedAction['apy']> {
  const latest = await reader.getBlock()
  const past = latest.number - BigInt(Math.floor(WEEK_SECONDS / MONAD_BLOCK_SECONDS))
  const [earlier, now, was] = await Promise.all([
    reader.getBlock({ blockNumber: past }),
    reader.readContract({
      address: vaultAddress,
      abi: VAULT_V2_ABI,
      functionName: 'convertToAssets',
      args: [PRICE_SHARES],
      blockNumber: latest.number,
    }),
    reader.readContract({
      address: vaultAddress,
      abi: VAULT_V2_ABI,
      functionName: 'convertToAssets',
      args: [PRICE_SHARES],
      blockNumber: past,
    }),
  ])
  if (now < was) {
    throw new ChainActionRefused(
      `${MORPHO_VAULT.name} lost value over the past week, so I won't add to it. Nothing was signed or sent.`
    )
  }
  const elapsed = Number(latest.timestamp - earlier.timestamp)
  if (elapsed < WEEK_SECONDS / 2 || was === BigInt(0) || now === was) return undefined
  const growth = Number(now) / Number(was)
  return { basePercent: (Math.pow(growth, YEAR_SECONDS / elapsed) - 1) * 100 }
}

function drifted(what: string): never {
  throw new ChainActionRefused(
    `${MORPHO_VAULT.name} ${what} since I reviewed it, so this stays blocked until it is checked again. Nothing was signed or sent.`
  )
}

/** The card names what the vault lends against, so a vault lending against anything else refuses. */
export async function assertMorphoAsReviewed(reader: EvmReaderClient): Promise<void> {
  const [adapterCount, marketCount] = await Promise.all([
    reader.readContract({
      address: vaultAddress,
      abi: VAULT_V2_ABI,
      functionName: 'adaptersLength',
    }),
    reader.readContract({
      address: MORPHO_ADAPTER as Address,
      abi: ADAPTER_ABI,
      functionName: 'marketIdsLength',
    }),
  ])
  if (adapterCount !== BigInt(1)) drifted('changed how it lends')
  const [adapter, ...markets] = await Promise.all([
    reader.readContract({
      address: vaultAddress,
      abi: VAULT_V2_ABI,
      functionName: 'adapters',
      args: [BigInt(0)],
    }),
    ...Array.from({ length: Number(marketCount) }, (_, index) =>
      reader.readContract({
        address: MORPHO_ADAPTER as Address,
        abi: ADAPTER_ABI,
        functionName: 'marketIds',
        args: [BigInt(index)],
      })
    ),
  ])
  if (!sameAddress(adapter, MORPHO_ADAPTER)) drifted('changed how it lends')
  const reviewed = (market: string) =>
    MORPHO_REVIEWED_MARKETS.some((known) => known.toLowerCase() === market.toLowerCase())
  if (!markets.every(reviewed)) drifted('added a market')
}

const NOTES: readonly string[] = [
  'Curated by Steakhouse Financial. This vault lends your USDC to borrowers against XAUt0, WMON, WETH and WBTC. If a price falls too fast or an oracle fails, bad debt falls on everyone in the vault.',
  'Steakhouse must give 7 days’ notice to add a way of lending, raise a limit or block withdrawals, so there is time to leave first. It can move money between these markets, and raise its fee on interest (10% today), at once.',
  'A different Morpho market lost about $250,000 to a misconfigured oracle in October 2024. It is not one of this vault’s markets, but the oracles here are the curator’s choice too.',
  'Any rate shown is what the vault paid over the past 7 days, after its fee, read from its share price. It is not promised, and any rewards are not included.',
]

export const MORPHO_CONFIG: VaultVenueConfig = {
  id: 'morpho',
  name: 'Morpho',
  chain: 'monad',
  vault: MORPHO_VAULT,
  notes: NOTES,
  readLiquidity: readMorphoLiquidity,
  readApy: readMorphoApy,
  assertAsReviewed: assertMorphoAsReviewed,
}

export function createMorphoVenue(deps: VaultVenueDeps = {}) {
  return createVaultVenue(MORPHO_CONFIG, deps)
}
