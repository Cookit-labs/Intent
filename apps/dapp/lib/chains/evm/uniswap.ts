import { parseAbi, type Address, type Hex } from 'viem'

import type { ChainToken, ChainVenue } from '../types'
import { AVALANCHE_TOKENS, MONAD_TOKENS, type EvmChain } from './tokens'
import {
  createV3SwapVenue,
  REFUND_ABI,
  WAVAX,
  WMON,
  type SingleSwap,
  type V3Router,
  type V3SwapDeps,
} from './v3-swap'

/**
 * Uniswap v3 through SwapRouter02, on Avalanche and Monad. v4 and the Universal Router would need
 * Permit2's second approval, and UniswapX depends on fillers, so neither is used.
 *
 * Addresses: Uniswap's registry at https://developers.uniswap.org/deployments.json, as
 * `v3-swaprouter02-<chain>`, `v3-quoterv2-<chain>` and `v3-uniswapv3factory-<chain>`. The Avalanche
 * set is also in Uniswap's sdk-core `src/addresses.ts`. On chain, each router and quoter answers
 * with that factory, and `uniswap.live.test.ts` holds them to it.
 */

const ROUTER_ABI = [
  ...parseAbi([
    'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
    'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
    'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  ]),
  ...REFUND_ABI,
]

const QUOTER_ABI = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

interface RouterParams {
  tokenIn: string
  tokenOut: string
  fee: number
  recipient: string
  amountIn: bigint
  amountOutMinimum: bigint
  sqrtPriceLimitX96: bigint
}

/** Each is switched on in both chains' factories, read with `feeAmountTickSpacing`. */
const FEE_TIERS = [100, 500, 3000, 10000]

const RISK_NOTE =
  'Uniswap v3’s pools and this router can’t be upgraded or paused. Its factory’s owner can only add fee tiers and turn on a share of the swap fees. DefiLlama records two old incidents, both on Ethereum and neither in these contracts: about $220,000 taken from Uniswap V1 by reentrancy on Apr 18, 2020, and about $8M phished from liquidity providers on Jul 11, 2022.'

function pick(tokens: readonly ChainToken[], symbols: readonly string[]): ChainToken[] {
  return tokens.filter((token) => symbols.includes(token.symbol))
}

export const UNISWAP_AVALANCHE_TOKENS: ChainToken[] = [WAVAX]
export const UNISWAP_MONAD_TOKENS: ChainToken[] = [WMON]

const CHAINS: Record<EvmChain, Pick<V3Router, 'router' | 'quoter' | 'wrapped' | 'tokens'>> = {
  avalanche: {
    router: '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE',
    quoter: '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
    wrapped: WAVAX,
    tokens: [...pick(AVALANCHE_TOKENS, ['AVAX', 'USDC', 'USDT']), WAVAX],
  },
  monad: {
    router: '0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900',
    quoter: '0x661E93cca42AfacB172121EF892830cA3b70F08d',
    wrapped: WMON,
    tokens: [...pick(MONAD_TOKENS, ['MON', 'USDC', 'USDT0']), WMON],
  },
}

export function uniswapRouter(chain: EvmChain): V3Router {
  return {
    id: `uniswap-${chain}`,
    name: 'Uniswap',
    chain,
    ...CHAINS[chain],
    tiers: FEE_TIERS,
    abi: ROUTER_ABI,
    quoterAbi: QUOTER_ABI,
    quoteParams: (tokenIn, tokenOut, amountIn, tier) => ({
      tokenIn,
      tokenOut,
      amountIn,
      fee: tier,
      sqrtPriceLimitX96: BigInt(0),
    }),
    swapParams: (swap: SingleSwap) => ({
      tokenIn: swap.tokenIn as Address,
      tokenOut: swap.tokenOut as Address,
      fee: swap.tier,
      recipient: swap.recipient as Address,
      amountIn: swap.amountIn,
      amountOutMinimum: swap.amountOutMinimum,
      sqrtPriceLimitX96: swap.sqrtPriceLimitX96,
    }),
    // This router's struct has no deadline. Its multicall holds one, which `readMulticall` reads.
    readSwap: (params) => {
      const swap = params as RouterParams
      return { ...swap, tier: swap.fee, deadline: BigInt(0) }
    },
    multicallArgs: (calls, deadline) => [deadline, calls],
    readMulticall: (args) => {
      const [deadline, calls] = args as readonly [bigint, readonly Hex[]]
      return { calls, deadline }
    },
    notes: [RISK_NOTE],
  }
}

export function createUniswapVenue(chain: EvmChain, deps?: V3SwapDeps): ChainVenue {
  return createV3SwapVenue(uniswapRouter(chain), deps)
}
