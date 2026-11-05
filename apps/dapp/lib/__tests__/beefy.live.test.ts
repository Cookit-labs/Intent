import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'

import { BEEFY_MONAD_STRATEGY, BEEFY_MONAD_USDC, BEEFY_MONAD_VAULT } from '../chains/evm/beefy'
import { evmReader } from '../chains/evm/client'

/**
 * The real contracts on Monad, read-only: nothing signs or sends. Deposit and withdrawal are only
 * tried with eth_call, for an empty address given the balance it needs by a state override.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const THROWAWAY = '0x00000000000000000000000000000000000abcde'
const VAULT = BEEFY_MONAD_VAULT as Address
const STRATEGY = BEEFY_MONAD_STRATEGY as Address
const VAULT_IMPLEMENTATION = '91bb303e972995ebe5f593bcddbb6f5ef49dbcbd'
const AAVE_POOL = '0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef'
const AAVE_USDC = '0x35a73BAcb179d3740395A3ceCc87FF2e581d6042'
const SIX_HOURS = BigInt(21_600)
const STRATEGY_TIMELOCK = '0x09D19184F46A32213DF06b981122e06882B61309'
const STRATEGY_FACTORY = '0xE6e5732245b3e886DD8897a93D21D29bb652d683'
const STRATEGY_BEACON = '0xe419fb039022d9b9192ebd7d2ba4fe7ad73d9e8b'
/** The depth under which this vault would be too thin to offer. It held about $3.01M when reviewed. */
const MIN_VAULT_USDC = BigInt(500_000) * BigInt(1_000_000)
// Circle's FiatToken keeps balances at slot 9 and allowances at slot 10; the vault's ERC20 at slot 51.
const USDC_BALANCE_SLOT = BigInt(9)
const USDC_ALLOWANCE_SLOT = BigInt(10)
const SHARE_BALANCE_SLOT = BigInt(51)
const AMOUNT = BigInt(25_000_000)

const VAULT_ABI = parseAbi([
  'function want() view returns (address)',
  'function strategy() view returns (address)',
  'function approvalDelay() view returns (uint256)',
  'function stratCandidate() view returns (address implementation, uint256 proposedTime)',
  'function balance() view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function deposit(uint256 amount)',
  'function withdraw(uint256 shares)',
])
const STRATEGY_ABI = parseAbi([
  'function vault() view returns (address)',
  'function want() view returns (address)',
  'function aToken() view returns (address)',
  'function lendingPool() view returns (address)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function withdrawFee() view returns (uint256)',
  'function getAllFees() view returns (((uint256 total, uint256 beefy, uint256 call, uint256 strategist, string label, bool active) performance, uint256 deposit, uint256 withdraw))',
])
const ADMIN_ABI = parseAbi([
  'function getMinDelay() view returns (uint256)',
  'function owner() view returns (address)',
])

const reader = evmReader('monad')

function mappingSlot(key: string, slot: bigint): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key as Address, slot])
  )
}

function word(value: bigint): Hex {
  return pad(toHex(value), { size: 32 })
}

describe.skipIf(SKIP)('the pinned Beefy vault on Monad', () => {
  it('is a minimal proxy of the reviewed implementation, so it can’t be upgraded', async () => {
    const code = await reader.getCode({ address: VAULT })
    expect(code).toBe(`0x363d3d373d3d3d363d73${VAULT_IMPLEMENTATION}5af43d82803e903d91602b57fd5bf3`)
  }, 30_000)

  it('holds USDC with the strategy that was reviewed', async () => {
    const vault = { address: VAULT, abi: VAULT_ABI }
    const strategy = { address: STRATEGY, abi: STRATEGY_ABI }
    expect(await reader.readContract({ ...vault, functionName: 'want' })).toBe(BEEFY_MONAD_USDC)
    expect(await reader.readContract({ ...vault, functionName: 'strategy' })).toBe(STRATEGY)
    expect(await reader.readContract({ ...vault, functionName: 'symbol' })).toBe(
      'mooAaveV3MonadUSDC'
    )
    expect(await reader.readContract({ ...strategy, functionName: 'vault' })).toBe(VAULT)
    expect(await reader.readContract({ ...strategy, functionName: 'want' })).toBe(BEEFY_MONAD_USDC)
    expect(await reader.readContract({ ...strategy, functionName: 'lendingPool' })).toBe(AAVE_POOL)
    expect(await reader.readContract({ ...strategy, functionName: 'aToken' })).toBe(AAVE_USDC)
    expect(await reader.readContract({ ...strategy, functionName: 'paused' })).toBe(false)
  }, 30_000)

  it('is not too thin to offer', async () => {
    const held = await reader.readContract({
      address: VAULT,
      abi: VAULT_ABI,
      functionName: 'balance',
    })
    expect(held).toBeGreaterThan(MIN_VAULT_USDC)
  }, 30_000)

  it('still has the shares and fees the card states', async () => {
    expect(
      await reader.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'decimals' })
    ).toBe(18)
    const fees = await reader.readContract({
      address: STRATEGY,
      abi: STRATEGY_ABI,
      functionName: 'getAllFees',
    })
    expect(fees.performance.total).toBe(BigInt(95_000_000_000_000_000))
    expect(fees.deposit).toBe(BigInt(0))
    expect(fees.withdraw).toBe(BigInt(0))
  }, 30_000)

  it('still has the 6-hour delays the card states', async () => {
    expect(
      await reader.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'approvalDelay' })
    ).toBe(SIX_HOURS)
    expect(
      await reader.readContract({ address: STRATEGY, abi: STRATEGY_ABI, functionName: 'owner' })
    ).toBe(STRATEGY_TIMELOCK)
    expect(
      await reader.readContract({
        address: STRATEGY_TIMELOCK,
        abi: ADMIN_ABI,
        functionName: 'getMinDelay',
      })
    ).toBe(SIX_HOURS)
    expect(
      await reader.readContract({
        address: STRATEGY_BEACON,
        abi: ADMIN_ABI,
        functionName: 'owner',
      })
    ).toBe(STRATEGY_FACTORY)
    expect(
      await reader.readContract({
        address: STRATEGY_FACTORY,
        abi: ADMIN_ABI,
        functionName: 'owner',
      })
    ).toBe(STRATEGY_TIMELOCK)
  }, 30_000)

  it('takes a deposit, tried and not sent', async () => {
    const allowance = keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [VAULT, mappingSlot(THROWAWAY, USDC_ALLOWANCE_SLOT)]
      )
    )
    await expect(
      reader.call({
        account: THROWAWAY,
        to: VAULT,
        data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'deposit', args: [AMOUNT] }),
        stateOverride: [
          {
            address: BEEFY_MONAD_USDC,
            stateDiff: [
              { slot: mappingSlot(THROWAWAY, USDC_BALANCE_SLOT), value: word(AMOUNT) },
              { slot: allowance, value: word(AMOUNT) },
            ],
          },
        ],
      })
    ).resolves.toBeDefined()
  }, 30_000)

  it('pays out a withdrawal, tried and not sent', async () => {
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'withdraw', args: [AMOUNT] })
    await expect(reader.call({ account: THROWAWAY, to: VAULT, data })).rejects.toThrow()
    await expect(
      reader.call({
        account: THROWAWAY,
        to: VAULT,
        data,
        stateOverride: [
          {
            address: VAULT,
            stateDiff: [{ slot: mappingSlot(THROWAWAY, SHARE_BALANCE_SLOT), value: word(AMOUNT) }],
          },
        ],
      })
    ).resolves.toBeDefined()
  }, 30_000)
})
