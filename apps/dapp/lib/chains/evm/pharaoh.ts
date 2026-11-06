import { parseAbi, type Address, type Hex } from 'viem'

import type { ChainToken, ChainVenue } from '../types'
import { AVALANCHE_TOKENS } from './tokens'
import {
  createV3SwapVenue,
  REFUND_ABI,
  WAVAX,
  type SingleSwap,
  type V3Router,
  type V3SwapDeps,
} from './v3-swap'

/**
 * Pharaoh's concentrated-liquidity pools on Avalanche, a fork of Ramses V3 whose pools are named by
 * tick spacing rather than fee. Its DLMM pools and UniversalRouter are left out.
 *
 * Addresses: https://docs.phar.gg/pages/contract-addresses, as SwapRouter, QuoterV2 and
 * RamsesV3PoolDeployer. Routescan verifies the source of both. On chain, each answers `deployer()`
 * with that deployer, and `pharaoh.live.test.ts` holds them to it.
 */

const ROUTER_ABI = [
  ...parseAbi([
    'struct ExactInputSingleParams { address tokenIn; address tokenOut; int24 tickSpacing; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
    'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
    'function multicall(bytes[] data) payable returns (bytes[] results)',
  ]),
  ...REFUND_ABI,
]

const QUOTER_ABI = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; int24 tickSpacing; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

interface RouterParams {
  tokenIn: string
  tokenOut: string
  tickSpacing: number
  recipient: string
  deadline: bigint
  amountIn: bigint
  amountOutMinimum: bigint
  sqrtPriceLimitX96: bigint
}

/** Each is switched on in the factory, read with `tickSpacingInitialFee`. */
const TICK_SPACINGS = [1, 5, 10, 50, 100, 200]

export const PHARAOH_TOKENS: ChainToken[] = [WAVAX]

const AUDIT_NOTE =
  'Pharaoh’s audits cover the Ramses V3 and Shadow code it is built on, and its own docs say they are not a review of Pharaoh’s deployment. Ramses lost about $93,000 to a reward logic flaw on Arbitrum on Oct 24, 2024, per DefiLlama.'

const ADMIN_NOTE =
  'The router and pool here aren’t upgradeable proxies, but Pharaoh’s governance can change a pool’s fee. The minimum above still holds if it does.'

export function pharaohRouter(): V3Router {
  return {
    id: 'pharaoh',
    name: 'Pharaoh',
    chain: 'avalanche',
    router: '0xc8B8fCbDb5C019D7802fFb0b39603395D7d3915c',
    quoter: '0xB7297301b7CC659BB96D51754643A0Df6eEA2138',
    wrapped: WAVAX,
    tokens: [
      ...AVALANCHE_TOKENS.filter((token) => ['AVAX', 'USDC', 'USDT'].includes(token.symbol)),
      WAVAX,
    ],
    tiers: TICK_SPACINGS,
    abi: ROUTER_ABI,
    quoterAbi: QUOTER_ABI,
    quoteParams: (tokenIn, tokenOut, amountIn, tier) => ({
      tokenIn,
      tokenOut,
      amountIn,
      tickSpacing: tier,
      sqrtPriceLimitX96: BigInt(0),
    }),
    swapParams: (swap: SingleSwap) => ({
      tokenIn: swap.tokenIn as Address,
      tokenOut: swap.tokenOut as Address,
      tickSpacing: swap.tier,
      recipient: swap.recipient as Address,
      deadline: swap.deadline,
      amountIn: swap.amountIn,
      amountOutMinimum: swap.amountOutMinimum,
      sqrtPriceLimitX96: swap.sqrtPriceLimitX96,
    }),
    readSwap: (params) => {
      const swap = params as RouterParams
      return { ...swap, tier: swap.tickSpacing }
    },
    multicallArgs: (calls) => [calls],
    readMulticall: (args) => {
      const [calls] = args as readonly [readonly Hex[]]
      return { calls }
    },
    notes: [AUDIT_NOTE, ADMIN_NOTE],
  }
}

export function createPharaohVenue(deps?: V3SwapDeps): ChainVenue {
  return createV3SwapVenue(pharaohRouter(), deps)
}
