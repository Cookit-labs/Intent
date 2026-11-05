import { formatUnits, parseAbi, parseUnits, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { evmReader } from '../chains/evm/client'
import { ChainActionRefused } from '../chains/types'
import { EVM_CHAINS, type EvmChain } from '../chains/evm/tokens'
import { createUniswapVenue, uniswapRouter } from '../chains/evm/uniswap'
import { WAVAX, WMON } from '../chains/evm/v3-swap'
import { fakeClient, fundedReader, wethHolding } from './v3-swap-suite'

/**
 * The real contracts, read-only. Nothing signs or sends: the swaps below are `eth_call`s from an
 * account that only exists inside the call, given a balance by a state override.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const ME = '0x00000000000000000000000000000000000feed1'
const MUCH = BigInt('1000000000000000000000000')
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

const FACTORY: Record<EvmChain, string> = {
  avalanche: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
  monad: '0x204FAca1764B154221e35c0d20aBb3c525710498',
}

const IMMUTABLES = parseAbi([
  'function factory() view returns (address)',
  'function WETH9() view returns (address)',
])
const FACTORY_ABI = parseAbi(['function feeAmountTickSpacing(uint24) view returns (int24)'])

describe.skipIf(SKIP).each<[EvmChain, string, string]>([
  ['avalanche', 'AVAX', 'USDC'],
  ['monad', 'MON', 'USDC'],
])('Uniswap on %s, live', (chain, native, stable) => {
  const router = uniswapRouter(chain)
  const wrapped = chain === 'avalanche' ? WAVAX : WMON
  const reader = evmReader(chain)

  it.each([
    ['router', router.router],
    ['quoter', router.quoter],
  ])(
    'the %s answers with the registry’s factory and wrapped coin',
    async (_label, address) => {
      const [factory, weth] = await Promise.all([
        reader.readContract({
          address: address as Address,
          abi: IMMUTABLES,
          functionName: 'factory',
        }),
        reader.readContract({
          address: address as Address,
          abi: IMMUTABLES,
          functionName: 'WETH9',
        }),
      ])
      expect(factory.toLowerCase()).toBe(FACTORY[chain].toLowerCase())
      expect(weth.toLowerCase()).toBe(wrapped.id.toLowerCase())
    },
    30_000
  )

  it('the router holds the functions this venue calls, and is no proxy', async () => {
    const [code, implementation] = await Promise.all([
      reader.getCode({ address: router.router as Address }),
      reader.getStorageAt({ address: router.router as Address, slot: IMPLEMENTATION_SLOT }),
    ])
    for (const selector of ['5ae401dc', '04e45aaf', '12210e8a']) {
      expect(code).toContain(selector)
    }
    expect(BigInt(implementation ?? '0x0')).toBe(BigInt(0))
  }, 30_000)

  it('every fee tier is switched on in the factory', async () => {
    for (const tier of router.tiers) {
      const spacing = await reader.readContract({
        address: FACTORY[chain] as Address,
        abi: FACTORY_ABI,
        functionName: 'feeAmountTickSpacing',
        args: [tier],
      })
      expect(spacing).toBeGreaterThan(0)
    }
  }, 30_000)

  it('quotes a real price', async () => {
    const quoted = await createUniswapVenue(chain).quote?.(
      { kind: 'swap', amount: '20', tokenIn: stable, tokenOut: wrapped.symbol },
      ME
    )
    expect(Number(quoted?.receive?.amount)).toBeGreaterThan(0)
  }, 30_000)

  it('swaps the native coin in, wrapped by the router, in a call from a funded account', async () => {
    const venue = createUniswapVenue(chain, {
      reader: () => fundedReader(reader, [{ address: ME as Address, balance: MUCH }], BigInt(0)),
      client: () => fakeClient(),
    })
    // `prepare` runs the call against the chain and refuses if it would fail.
    const prepared = await venue.prepare(
      { kind: 'swap', amount: '1', tokenIn: native, tokenOut: stable },
      ME
    )
    expect(Number(prepared.receive?.amount)).toBeGreaterThan(0)
  }, 60_000)

  it('swaps the wrapped coin in, pulled under an exact allowance, in a call from a funded account', async () => {
    const units = parseUnits('5', wrapped.decimals)
    const venue = createUniswapVenue(chain, {
      reader: () =>
        fundedReader(
          reader,
          [
            { address: ME as Address, balance: MUCH },
            {
              address: wrapped.id as Address,
              stateDiff: wethHolding(ME, router.router, units),
            },
          ],
          units
        ),
      client: () => fakeClient(),
    })
    const prepared = await venue.prepare(
      {
        kind: 'swap',
        amount: formatUnits(units, wrapped.decimals),
        tokenIn: wrapped.symbol,
        tokenOut: stable,
      },
      ME
    )
    expect(prepared.signing).not.toHaveProperty('approval')
    expect(Number(prepared.receive?.amount)).toBeGreaterThan(0)
  }, 60_000)

  it('refuses that same swap from an account that holds none, so the two above prove something', async () => {
    const units = parseUnits('5', wrapped.decimals)
    const venue = createUniswapVenue(chain, {
      reader: () => fundedReader(reader, [{ address: ME as Address, balance: MUCH }], units),
      client: () => fakeClient(),
    })
    await expect(
      venue.prepare(
        {
          kind: 'swap',
          amount: formatUnits(units, wrapped.decimals),
          tokenIn: wrapped.symbol,
          tokenOut: stable,
        },
        ME
      )
    ).rejects.toThrow(ChainActionRefused)
  }, 60_000)

  it('uses tokens from the chain’s own table', () => {
    const table = EVM_CHAINS[chain].tokens
    for (const token of router.tokens) {
      if (token.id === wrapped.id) continue
      expect(table.find((t) => t.id === token.id)?.decimals).toBe(token.decimals)
    }
  })
})
