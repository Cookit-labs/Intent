import {
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'

import { evmReader } from '../chains/evm/client'
import {
  createEulerAvalancheVenue,
  createEulerMonadVenue,
  EULER_AVALANCHE_COLLATERAL,
  EULER_AVALANCHE_VAULT,
  EULER_FACTORY_AVALANCHE,
  EULER_FACTORY_MONAD,
  EULER_MONAD_COLLATERAL,
  EULER_MONAD_VAULT,
} from '../chains/evm/euler'
import type { ReviewedVault } from '../chains/evm/erc4626'
import { sameAddress } from '../chains/evm/submit'
import type { ChainVenue } from '../chains/types'

/**
 * Whether what's pinned still holds, read-only. Nothing here signs or sends: a deposit is tried
 * with `eth_call` and overridden balances, and a withdrawal from a vault that holds these shares,
 * whose key nobody has. If a holder leaves, swap it for another.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const NOBODY = '0x000000000000000000000000000000000000dEaD'
const SLOW_MS = 90_000
/** Where Circle's USDC keeps balances and allowances, found by probing with an override. */
const USDC_BALANCE_SLOT = BigInt(9)
const USDC_ALLOWANCE_SLOT = BigInt(10)
/** Stream's and Elixir's tokens, which left other Euler vaults on Avalanche stuck. */
const STREAM_TOKENS = ['XUSD', 'DEUSD', 'SDEUSD']

const ABI = parseAbi([
  'function asset() view returns (address)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function governorAdmin() view returns (address)',
  'function isProxy(address) view returns (bool)',
  'function LTVList() view returns (address[])',
  'function cash() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function hookConfig() view returns (address, uint32)',
  'function deposit(uint256, address) returns (uint256)',
])

const slotOf = (key: string, slot: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key as Address, slot]))
const allowanceSlot = (owner: string, spender: string): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes32' }],
      [spender as Address, slotOf(owner, USDC_ALLOWANCE_SLOT)]
    )
  )

interface Case {
  label: string
  chain: 'monad' | 'avalanche'
  rpc: string
  vault: ReviewedVault
  factory: string
  governor: string
  collateral: readonly string[]
  holder: string
  create: (reader: ReturnType<typeof evmReader>) => ChainVenue
}

const CASES: Case[] = [
  {
    label: 'Monad',
    chain: 'monad',
    rpc: process.env['MONAD_RPC_URL']?.trim() || 'https://rpc.monad.xyz',
    vault: EULER_MONAD_VAULT,
    factory: EULER_FACTORY_MONAD,
    governor: '0xb3CF59A5f12cA319861376C5e63Eef4790a42B44',
    collateral: EULER_MONAD_COLLATERAL,
    holder: '0xE1BcA19baA63894D374578320551633320436523',
    create: (reader) => createEulerMonadVenue({ reader }),
  },
  {
    label: 'Avalanche',
    chain: 'avalanche',
    rpc: process.env['AVALANCHE_RPC_URL']?.trim() || 'https://avalanche-c-chain-rpc.publicnode.com',
    vault: EULER_AVALANCHE_VAULT,
    factory: EULER_FACTORY_AVALANCHE,
    governor: '0x23E6aecB76675462Ad8f2B31eC7C492060c2fAEF',
    collateral: EULER_AVALANCHE_COLLATERAL,
    holder: '0x4aF3aBE954259fb70b97C57EBD7Ac1eb822028Ef',
    create: (reader) => createEulerAvalancheVenue({ reader }),
  },
]

describe.skipIf(SKIP).each(CASES)('Euler on $label, live', (item) => {
  const reader = evmReader(item.chain, http(item.rpc, { timeout: 30_000, retryCount: 2 }))
  const vault = item.vault.address as Address
  const read = (address: string, functionName: string, args: unknown[] = []) =>
    reader.readContract({
      address: address as Address,
      abi: ABI,
      functionName,
      args,
    } as never) as Promise<unknown>

  it('finds code at the factory and the vault', { timeout: SLOW_MS }, async () => {
    for (const address of [item.factory, vault]) {
      const code = await reader.getCode({ address: address as Address })
      expect(code?.length ?? 0).toBeGreaterThan(2)
    }
  })

  it('is still the reviewed vault', { timeout: SLOW_MS }, async () => {
    expect(await read(item.factory, 'isProxy', [vault])).toBe(true)
    expect(sameAddress((await read(vault, 'asset')) as string, item.vault.asset.id)).toBe(true)
    expect(await read(vault, 'symbol')).toBe(item.vault.shareSymbol)
    expect(await read(vault, 'decimals')).toBe(item.vault.shareDecimals)
    expect(sameAddress((await read(vault, 'governorAdmin')) as string, item.governor)).toBe(true)
  })

  it('has no hook that could block a deposit or a withdrawal', { timeout: SLOW_MS }, async () => {
    const [hook, ops] = (await read(vault, 'hookConfig')) as readonly [string, number]
    expect(sameAddress(hook, `0x${'0'.repeat(40)}`)).toBe(true)
    expect(ops).toBe(0)
  })

  it('takes only reviewed collateral, with no Stream token', { timeout: SLOW_MS }, async () => {
    const listed = (await read(vault, 'LTVList')) as readonly string[]
    expect([...listed].sort()).toEqual([...item.collateral].sort())
    for (const entry of listed) {
      const asset = (await read(entry, 'asset')) as string
      const symbol = ((await read(asset, 'symbol')) as string).toUpperCase()
      expect(STREAM_TOKENS).not.toContain(symbol)
    }
  })

  it('still has money free', { timeout: SLOW_MS }, async () => {
    const [cash, total] = await Promise.all([read(vault, 'cash'), read(vault, 'totalAssets')])
    expect((cash as bigint) * BigInt(100)).toBeGreaterThan((total as bigint) * BigInt(5))
  })

  it('prepares a deposit with a believable rate', { timeout: SLOW_MS }, async () => {
    const venue = item.create(reader)
    // The vault's own cash stands in for a person with USDC. Nothing is signed.
    const prepared = await venue.prepare({ kind: 'supply', amount: '5', tokenIn: 'USDC' }, vault)
    expect(() => venue.assertSafe(prepared.signing, vault)).not.toThrow()
    expect(prepared.apy?.basePercent).toBeGreaterThan(0)
    expect(prepared.apy?.basePercent).toBeLessThan(50)
  })

  it(
    'accepts the deposit this code builds, with funds overridden',
    { timeout: SLOW_MS },
    async () => {
      const units = BigInt(5_000_000)
      await expect(
        reader.call({
          account: NOBODY,
          to: vault,
          data: encodeFunctionData({ abi: ABI, functionName: 'deposit', args: [units, NOBODY] }),
          stateOverride: [
            {
              address: item.vault.asset.id as Address,
              stateDiff: [
                { slot: slotOf(NOBODY, USDC_BALANCE_SLOT), value: pad(toHex(units)) },
                { slot: allowanceSlot(NOBODY, vault), value: pad(toHex(units)) },
              ],
            },
          ],
        })
      ).resolves.toBeDefined()
    }
  )

  it('prepares and tries a withdrawal for a real holder', { timeout: SLOW_MS }, async () => {
    const venue = item.create(reader)
    const prepared = await venue.prepare(
      { kind: 'withdraw', amount: '5', tokenIn: 'USDC' },
      item.holder
    )
    expect(() => venue.assertSafe(prepared.signing, item.holder)).not.toThrow()
  })
})
