import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'

import { evmReader } from '../chains/evm/client'
import {
  CURVANCE_CUSDC,
  CURVANCE_MARKET_MANAGER,
  CURVANCE_USDC,
  curvanceVenue,
} from '../chains/evm/curvance'

/**
 * The real contracts on Monad, read-only: nothing signs or sends. A withdrawal is only built and
 * tried for Curvance's DAO multisig, which holds cUSDC and whose key nobody here has. When it leaves
 * the market that case fails on balance, so swap it for another holder.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const REGISTRY = '0x1310f352f1389969Ece6741671c4B919523912fF'
const DAO = '0x0Acb7eF4D8733C719d60e0992B489b629bc55C02'
const EMERGENCY_COUNCIL = '0x379D4a8FBc23A8Fd8c2b3738Dbf1fEBe9a64399c'
const RAPID_RESPONSE = '0x25D4134861b30Ba7215d2A280DD84C57c5780902'
const RAPID_RESPONSE_PAUSER = '0x89D2253b13c718d06B78fCcE3d973a520bD07803'
const THROWAWAY = '0x00000000000000000000000000000000000abcde'
const EIP1967_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbd'
const EMPTY_SLOT = `0x${'0'.repeat(64)}`
// Circle's FiatToken keeps balances at slot 9 and allowances at slot 10.
const USDC_BALANCE_SLOT = BigInt(9)
const USDC_ALLOWANCE_SLOT = BigInt(10)

const CTOKEN = parseAbi([
  'function asset() view returns (address)',
  'function marketManager() view returns (address)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function centralRegistry() view returns (address)',
  'function MAX_INTEREST_ACCRUAL_FEE() view returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
])
const MANAGER = parseAbi([
  'function isListed(address cToken) view returns (bool)',
  'function queryTokensListed() view returns (address[])',
  'function MIN_HOLD_PERIOD() view returns (uint256)',
])
const SAFE = parseAbi(['function getThreshold() view returns (uint256)'])
const PAUSER = parseAbi(['function owner() view returns (address)'])
const REGISTRY_ABI = parseAbi([
  'function hasMarketPermissions(address account) view returns (bool)',
  'function emergencyCouncil() view returns (address)',
])

const reader = evmReader('monad')

function mappingSlot(key: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key, slot]))
}

function allowanceSlot(owner: Address, spender: Address): Hex {
  const inner = mappingSlot(owner, USDC_ALLOWANCE_SLOT)
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, inner])
  )
}

describe.skipIf(SKIP)('the pinned Curvance contracts', () => {
  it('has code at each', async () => {
    for (const address of [CURVANCE_CUSDC, CURVANCE_MARKET_MANAGER, CURVANCE_USDC]) {
      const code = await reader.getCode({ address: address as Address })
      expect(code?.length ?? 0, address).toBeGreaterThan(2)
    }
  }, 30_000)

  it('holds the market together as the docs say', async () => {
    const cToken = { address: CURVANCE_CUSDC as Address, abi: CTOKEN }
    const manager = { address: CURVANCE_MARKET_MANAGER as Address, abi: MANAGER }
    expect(await reader.readContract({ ...cToken, functionName: 'asset' })).toBe(CURVANCE_USDC)
    expect(await reader.readContract({ ...cToken, functionName: 'marketManager' })).toBe(
      CURVANCE_MARKET_MANAGER
    )
    expect(await reader.readContract({ ...cToken, functionName: 'decimals' })).toBe(6)
    expect(await reader.readContract({ ...cToken, functionName: 'symbol' })).toBe('cUSDC')
    expect(await reader.readContract({ ...cToken, functionName: 'centralRegistry' })).toBe(REGISTRY)
    expect(
      await reader.readContract({ ...manager, functionName: 'isListed', args: [CURVANCE_CUSDC] })
    ).toBe(true)
    expect(await reader.readContract({ ...manager, functionName: 'queryTokensListed' })).toContain(
      CURVANCE_CUSDC
    )
  }, 30_000)

  it('still has the 20 minute hold the card states', async () => {
    const hold = await reader.readContract({
      address: CURVANCE_MARKET_MANAGER,
      abi: MANAGER,
      functionName: 'MIN_HOLD_PERIOD',
    })
    expect(hold).toBe(BigInt(1200))
  }, 30_000)

  it('still has the admins the card states', async () => {
    const threshold = (address: string) =>
      reader.readContract({ address: address as Address, abi: SAFE, functionName: 'getThreshold' })
    expect(
      await reader.readContract({
        address: CURVANCE_CUSDC as Address,
        abi: CTOKEN,
        functionName: 'MAX_INTEREST_ACCRUAL_FEE',
      })
    ).toBe(BigInt(6000))
    expect(await threshold(RAPID_RESPONSE)).toBe(BigInt(1))
    expect(await threshold(EMERGENCY_COUNCIL)).toBe(BigInt(4))
    expect(
      await reader.readContract({
        address: RAPID_RESPONSE_PAUSER,
        abi: PAUSER,
        functionName: 'owner',
      })
    ).toBe(RAPID_RESPONSE)
    expect(
      await reader.readContract({
        address: REGISTRY,
        abi: REGISTRY_ABI,
        functionName: 'hasMarketPermissions',
        args: [RAPID_RESPONSE_PAUSER],
      })
    ).toBe(true)
    expect(
      await reader.readContract({
        address: REGISTRY,
        abi: REGISTRY_ABI,
        functionName: 'emergencyCouncil',
      })
    ).toBe(EMERGENCY_COUNCIL)
  }, 30_000)

  it('is not behind a standard upgrade proxy', async () => {
    for (const address of [CURVANCE_CUSDC, CURVANCE_MARKET_MANAGER]) {
      const slot = await reader.getStorageAt({
        address: address as Address,
        slot: EIP1967_IMPLEMENTATION,
      })
      expect(slot ?? EMPTY_SLOT, address).toBe(EMPTY_SLOT)
    }
  }, 30_000)
})

describe.skipIf(SKIP)('Curvance against the live market', () => {
  it('reads a real rate for the race', async () => {
    const quote = await curvanceVenue.quote?.(
      { kind: 'supply', amount: '1', tokenIn: 'USDC', venue: 'curvance' },
      THROWAWAY
    )
    expect(quote?.apyPercent).toBeGreaterThan(0)
    expect(quote?.apyPercent).toBeLessThan(200)
  }, 30_000)

  it('accepts its deposit from an account given USDC and an allowance', async () => {
    const account = THROWAWAY as Address
    const spender = CURVANCE_CUSDC as Address
    const value = toHex(BigInt(1_000_000_000), { size: 32 })
    const units = BigInt(100_000_000)
    const { data } = await reader.call({
      account,
      to: spender,
      data: encodeFunctionData({ abi: CTOKEN, functionName: 'deposit', args: [units, account] }),
      stateOverride: [
        {
          address: CURVANCE_USDC as Address,
          stateDiff: [
            { slot: mappingSlot(account, USDC_BALANCE_SLOT), value },
            { slot: allowanceSlot(account, spender), value },
          ],
        },
      ],
    })
    expect(BigInt(data ?? '0x0')).toBeGreaterThan(BigInt(0))
  }, 30_000)

  it('builds a withdrawal a real holder could send, and it passes its own check', async () => {
    const prepared = await curvanceVenue.prepare(
      { kind: 'withdraw', amount: '1', tokenIn: 'USDC', venue: 'curvance' },
      DAO
    )
    expect(() => curvanceVenue.assertSafe(prepared.signing, DAO)).not.toThrow()
  }, 30_000)

  it('refuses a withdrawal for an account that lent nothing', async () => {
    await expect(
      curvanceVenue.prepare(
        { kind: 'withdraw', amount: '1', tokenIn: 'USDC', venue: 'curvance' },
        THROWAWAY
      )
    ).rejects.toThrow(/no USDC lent/)
  }, 30_000)
})
