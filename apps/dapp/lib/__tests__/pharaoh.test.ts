import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'

import { createPharaohVenue } from '../chains/evm/pharaoh'
import {
  ACCOUNT,
  describeV3SwapVenue,
  fakeClient,
  fakeReader,
  type RouterFixture,
  type SwapFields,
} from './v3-swap-suite'

// Written out by hand from the source Routescan verifies at this router, apart from the code under test.
const ROUTER_ABI = parseAbi([
  'struct Params { address tokenIn; address tokenOut; int24 tickSpacing; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(Params params) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
])

function encodeSwap(fields: SwapFields): Hex {
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: fields.tokenIn as Address,
        tokenOut: fields.tokenOut as Address,
        tickSpacing: fields.tier,
        recipient: fields.recipient as Address,
        deadline: fields.deadline,
        amountIn: fields.amountIn,
        amountOutMinimum: fields.amountOutMinimum,
        sqrtPriceLimitX96: fields.sqrtPriceLimitX96,
      },
    ],
  })
}

function decodeSwap(data: Hex): SwapFields & { outer: Hex[] } {
  const outer = decodeFunctionData({ abi: ROUTER_ABI, data })
  if (outer.functionName !== 'multicall') throw new Error('not a multicall')
  const [calls] = outer.args
  const inner = decodeFunctionData({ abi: ROUTER_ABI, data: calls[0] as Hex })
  if (inner.functionName !== 'exactInputSingle') throw new Error('not a swap')
  const [params] = inner.args
  return {
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    tier: params.tickSpacing,
    recipient: params.recipient,
    amountIn: params.amountIn,
    amountOutMinimum: params.amountOutMinimum,
    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
    deadline: params.deadline,
    outer: [...calls],
  }
}

const PHARAOH: RouterFixture = {
  label: 'Pharaoh',
  venue: (reader, client) => createPharaohVenue({ reader: () => reader, client: () => client }),
  chainId: 43114,
  otherChainId: 143,
  router: '0xc8B8fCbDb5C019D7802fFb0b39603395D7d3915c',
  quoter: '0xB7297301b7CC659BB96D51754643A0Df6eEA2138',
  nativeSymbol: 'AVAX',
  wrapped: { symbol: 'WAVAX', id: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7' },
  stable: { symbol: 'USDC', id: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' },
  stable2: { symbol: 'USDT', id: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7' },
  bestTier: 10,
  worseTier: 1,
  unverifiedTier: 500,
  tierOf: (params) => params['tickSpacing'] as number,
  encodeSwap,
  encodeOuter: (calls) =>
    encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [calls] }),
  deadlineIn: 'swap',
  decodeSwap,
}

describeV3SwapVenue(PHARAOH)

describe('Pharaoh encoding', () => {
  it('uses the multicall selector in the deployed bytecode', () => {
    expect(toFunctionSelector(ROUTER_ABI[1])).toBe('0xac9650d8')
  })

  it('only swaps, under its one id', () => {
    expect(createPharaohVenue().id).toBe('pharaoh')
    expect(createPharaohVenue().kinds).toEqual(['swap'])
  })

  it('says on the card that its audits are not of its own deployment', async () => {
    const { reader } = fakeReader(PHARAOH, { rate: { 10: BigInt(900_000) } })
    const venue = createPharaohVenue({ reader: () => reader, client: () => fakeClient() })
    const prepared = await venue.prepare(
      { kind: 'swap', amount: '5', tokenIn: 'USDC', tokenOut: 'USDT' },
      ACCOUNT
    )
    const notes = prepared.notes.join(' ')
    expect(notes).toContain('not a review of Pharaoh’s deployment')
    expect(notes).toContain('about $93,000')
    expect(notes).toContain('change a pool’s fee')
  })
})
