import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'

import { createUniswapVenue } from '../chains/evm/uniswap'
import {
  ACCOUNT,
  describeV3SwapVenue,
  fakeClient,
  fakeReader,
  type RouterFixture,
  type SwapFields,
} from './v3-swap-suite'

// Written out by hand from Uniswap's SwapRouter02 source, apart from the code under test.
const ROUTER_ABI = parseAbi([
  'struct Params { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(Params params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
])

function encodeSwap(fields: SwapFields): Hex {
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: fields.tokenIn as Address,
        tokenOut: fields.tokenOut as Address,
        fee: fields.tier,
        recipient: fields.recipient as Address,
        amountIn: fields.amountIn,
        amountOutMinimum: fields.amountOutMinimum,
        sqrtPriceLimitX96: fields.sqrtPriceLimitX96,
      },
    ],
  })
}

function encodeOuter(calls: readonly Hex[], deadline: bigint): Hex {
  return encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [deadline, calls] })
}

function decodeSwap(data: Hex): SwapFields & { outer: Hex[] } {
  const outer = decodeFunctionData({ abi: ROUTER_ABI, data })
  if (outer.functionName !== 'multicall') throw new Error('not a multicall')
  const [deadline, calls] = outer.args
  const inner = decodeFunctionData({ abi: ROUTER_ABI, data: calls[0] as Hex })
  if (inner.functionName !== 'exactInputSingle') throw new Error('not a swap')
  const [params] = inner.args
  return {
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    tier: params.fee,
    recipient: params.recipient,
    amountIn: params.amountIn,
    amountOutMinimum: params.amountOutMinimum,
    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
    deadline,
    outer: [...calls],
  }
}

function fixture(
  chain: 'avalanche' | 'monad',
  pinned: Pick<
    RouterFixture,
    | 'chainId'
    | 'otherChainId'
    | 'router'
    | 'quoter'
    | 'nativeSymbol'
    | 'wrapped'
    | 'stable'
    | 'stable2'
  >
): RouterFixture {
  return {
    label: `Uniswap on ${chain}`,
    venue: (reader, client) =>
      createUniswapVenue(chain, { reader: () => reader, client: () => client }),
    ...pinned,
    bestTier: 3000,
    worseTier: 500,
    unverifiedTier: 2500,
    tierOf: (params) => params['fee'] as number,
    encodeSwap,
    encodeOuter,
    deadlineIn: 'outer',
    decodeSwap,
  }
}

describeV3SwapVenue(
  fixture('avalanche', {
    chainId: 43114,
    otherChainId: 143,
    router: '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE',
    quoter: '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
    nativeSymbol: 'AVAX',
    wrapped: { symbol: 'WAVAX', id: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7' },
    stable: { symbol: 'USDC', id: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' },
    stable2: { symbol: 'USDT', id: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7' },
  })
)

const MONAD = fixture('monad', {
  chainId: 143,
  otherChainId: 43114,
  router: '0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900',
  quoter: '0x661E93cca42AfacB172121EF892830cA3b70F08d',
  nativeSymbol: 'MON',
  wrapped: { symbol: 'WMON', id: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A' },
  stable: { symbol: 'USDC', id: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' },
  stable2: { symbol: 'USDT0', id: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D' },
})

describeV3SwapVenue(MONAD)

describe('Uniswap encoding', () => {
  it('uses the selectors in the deployed bytecode', () => {
    expect(toFunctionSelector(ROUTER_ABI[0])).toBe('0x04e45aaf')
    expect(toFunctionSelector(ROUTER_ABI[1])).toBe('0x5ae401dc')
  })

  it('has one id for each chain', () => {
    expect(createUniswapVenue('avalanche').id).toBe('uniswap-avalanche')
    expect(createUniswapVenue('monad').id).toBe('uniswap-monad')
  })

  it('only swaps', () => {
    expect(createUniswapVenue('avalanche').kinds).toEqual(['swap'])
  })

  it('warns of Monad’s reserve when a swap would dip under it', async () => {
    const { reader } = fakeReader(MONAD, { rate: { 3000: BigInt(900_000) } })
    const venue = createUniswapVenue('monad', {
      reader: () => reader,
      client: () => fakeClient({ native: BigInt('11000000000000000000') }),
    })
    const prepared = await venue.prepare(
      { kind: 'swap', amount: '5', tokenIn: 'MON', tokenOut: 'USDC' },
      ACCOUNT
    )
    expect(prepared.notes.join(' ')).toContain('10 MON reserve')
  })

  it('states the risks on the card', async () => {
    const { reader } = fakeReader(MONAD, { rate: { 3000: BigInt(900_000) } })
    const venue = createUniswapVenue('monad', { reader: () => reader, client: () => fakeClient() })
    const prepared = await venue.prepare(
      { kind: 'swap', amount: '5', tokenIn: 'USDC', tokenOut: 'USDT0' },
      ACCOUNT
    )
    expect(prepared.notes.join(' ')).toContain('can’t be upgraded or paused')
  })
})
