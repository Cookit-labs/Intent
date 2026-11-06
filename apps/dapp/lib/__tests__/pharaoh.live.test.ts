import { formatUnits, parseAbi, parseUnits, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { evmReader } from '../chains/evm/client'
import { createPharaohVenue, pharaohRouter } from '../chains/evm/pharaoh'
import { ChainActionRefused } from '../chains/types'
import { WAVAX } from '../chains/evm/v3-swap'
import { fakeClient, fundedReader, wethHolding } from './v3-swap-suite'

/**
 * The real contracts, read-only. Nothing signs or sends: the swaps below are `eth_call`s from an
 * account that only exists inside the call, given a balance by a state override.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const ME = '0x00000000000000000000000000000000000feed1'
const MUCH = BigInt('1000000000000000000000000')
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const DEPLOYER = '0x6a4113ed0915bCf5E48e758e8f4cEBFFC07C66f9'
const FACTORY = '0xAE6E5c62328ade73ceefD42228528b70c8157D0d'

const IMMUTABLES = parseAbi([
  'function deployer() view returns (address)',
  'function WETH9() view returns (address)',
])
const FACTORY_ABI = parseAbi([
  'function ramsesV3PoolDeployer() view returns (address)',
  'function tickSpacingInitialFee(int24) view returns (uint24)',
])

describe.skipIf(SKIP)('Pharaoh, live', () => {
  const router = pharaohRouter()
  const reader = evmReader('avalanche')

  it.each([
    ['router', router.router],
    ['quoter', router.quoter],
  ])(
    'the %s answers with the docs’ deployer and wrapped coin',
    async (_label, address) => {
      const [deployer, weth] = await Promise.all([
        reader.readContract({
          address: address as Address,
          abi: IMMUTABLES,
          functionName: 'deployer',
        }),
        reader.readContract({
          address: address as Address,
          abi: IMMUTABLES,
          functionName: 'WETH9',
        }),
      ])
      expect(deployer.toLowerCase()).toBe(DEPLOYER.toLowerCase())
      expect(weth.toLowerCase()).toBe(WAVAX.id.toLowerCase())
    },
    30_000
  )

  it('the factory names that deployer', async () => {
    const deployer = await reader.readContract({
      address: FACTORY,
      abi: FACTORY_ABI,
      functionName: 'ramsesV3PoolDeployer',
    })
    expect(deployer.toLowerCase()).toBe(DEPLOYER.toLowerCase())
  }, 30_000)

  it('the router holds the functions this venue calls, and is no proxy', async () => {
    const [code, implementation] = await Promise.all([
      reader.getCode({ address: router.router as Address }),
      reader.getStorageAt({ address: router.router as Address, slot: IMPLEMENTATION_SLOT }),
    ])
    expect(code).toContain('ac9650d8')
    expect(code).toContain('12210e8a')
    expect(BigInt(implementation ?? '0x0')).toBe(BigInt(0))
  }, 30_000)

  it('every tick spacing is switched on in the factory', async () => {
    for (const tier of router.tiers) {
      const fee = await reader.readContract({
        address: FACTORY,
        abi: FACTORY_ABI,
        functionName: 'tickSpacingInitialFee',
        args: [tier],
      })
      expect(fee).toBeGreaterThan(0)
    }
  }, 30_000)

  it('quotes a real price', async () => {
    const quoted = await createPharaohVenue().quote?.(
      { kind: 'swap', amount: '20', tokenIn: 'USDC', tokenOut: 'WAVAX' },
      ME
    )
    expect(Number(quoted?.receive?.amount)).toBeGreaterThan(0)
  }, 30_000)

  it('swaps AVAX in, wrapped by the router, in a call from a funded account', async () => {
    const venue = createPharaohVenue({
      reader: () => fundedReader(reader, [{ address: ME as Address, balance: MUCH }], BigInt(0)),
      client: () => fakeClient(),
    })
    // `prepare` runs the call against the chain and refuses if it would fail.
    const prepared = await venue.prepare(
      { kind: 'swap', amount: '1', tokenIn: 'AVAX', tokenOut: 'USDC' },
      ME
    )
    expect(Number(prepared.receive?.amount)).toBeGreaterThan(0)
  }, 60_000)

  it('swaps WAVAX in, pulled under an exact allowance, in a call from a funded account', async () => {
    const units = parseUnits('2', WAVAX.decimals)
    const venue = createPharaohVenue({
      reader: () =>
        fundedReader(
          reader,
          [
            { address: ME as Address, balance: MUCH },
            { address: WAVAX.id as Address, stateDiff: wethHolding(ME, router.router, units) },
          ],
          units
        ),
      client: () => fakeClient(),
    })
    const prepared = await venue.prepare(
      {
        kind: 'swap',
        amount: formatUnits(units, WAVAX.decimals),
        tokenIn: 'WAVAX',
        tokenOut: 'USDC',
      },
      ME
    )
    expect(prepared.signing).not.toHaveProperty('approval')
    expect(Number(prepared.receive?.amount)).toBeGreaterThan(0)
  }, 60_000)

  it('refuses that same swap from an account that holds none, so the two above prove something', async () => {
    const units = parseUnits('2', WAVAX.decimals)
    const venue = createPharaohVenue({
      reader: () => fundedReader(reader, [{ address: ME as Address, balance: MUCH }], units),
      client: () => fakeClient(),
    })
    await expect(
      venue.prepare(
        {
          kind: 'swap',
          amount: formatUnits(units, WAVAX.decimals),
          tokenIn: 'WAVAX',
          tokenOut: 'USDC',
        },
        ME
      )
    ).rejects.toThrow(ChainActionRefused)
  }, 60_000)
})
