import {
  decodeFunctionResult,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'

import { evmReader } from '../chains/evm/client'
import {
  createSablierVenue,
  SABLIER_COMPTROLLER,
  SABLIER_LOCKUP,
  SABLIER_LOCKUP_ABI,
  SABLIER_STREAMABLE,
} from '../chains/evm/sablier'
import { EVM_CHAINS, type EvmChain } from '../chains/evm/tokens'
import type { SigningPayload } from '../chains/types'

/**
 * The real contracts, read-only: nothing signs or sends. The stream is tried with `eth_call`, with
 * the sender's balance and allowance overridden for that one call, so the real contract runs it.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const SENDER = getAddress('0x1111111111111111111111111111111111111111')
const RECIPIENT = getAddress('0x2222222222222222222222222222222222222222')
const CHAINS: EvmChain[] = ['avalanche', 'monad']

// Slots in Circle's FiatToken: balanceAndBlacklistStates is 9, allowed is 10.
const USDC_BALANCE_SLOT = BigInt(9)
const USDC_ALLOWANCE_SLOT = BigInt(10)

const VIEWS = parseAbi([
  'function name() view returns (string)',
  'function nextStreamId() view returns (uint256)',
  'function comptroller() view returns (address)',
  'function getSender(uint256 streamId) view returns (address)',
  'function calculateMinFeeWei(uint256 streamId) view returns (uint256)',
])

// The public RPCs rate-limit a burst, so these reads go one at a time with room to retry.
function patientReader(chain: EvmChain) {
  const url = process.env[EVM_CHAINS[chain].rpcEnv]?.trim() || undefined
  return evmReader(chain, http(url, { timeout: 15_000, retryCount: 6, retryDelay: 2_000 }))
}

const FEES = parseAbi([
  'function VERSION() view returns (string)',
  'function MAX_FEE_USD() view returns (uint256)',
  'function admin() view returns (address)',
  'function oracle() view returns (address)',
  'function getMinFeeUSD(uint8 protocol) view returns (uint256)',
  'function getMinFeeUSDFor(uint8 protocol, address user) view returns (uint256)',
  'function calculateMinFeeWeiFor(uint8 protocol, address user) view returns (uint256)',
])

const EIP1967_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

function mappingSlot(key: Address | Hex, slot: bigint): Hex {
  const type = key.length === 42 ? 'address' : 'bytes32'
  return keccak256(encodeAbiParameters([{ type }, { type: 'uint256' }], [key, slot] as never))
}

function usdcOf(chain: EvmChain): Address {
  const token = EVM_CHAINS[chain].tokens.find((t) => t.symbol === 'USDC')
  return token?.id as Address
}

describe.skipIf(SKIP)('Sablier Lockup against mainnet', () => {
  describe.each(CHAINS)('%s', (chain) => {
    const reader = patientReader(chain)
    const lockup = SABLIER_LOCKUP[chain] as Address

    it('has the v4.0 contract at the pinned address', async () => {
      const code = await reader.getCode({ address: lockup })
      expect((code ?? '0x').length).toBeGreaterThan(2)
      expect(code).toContain(toFunctionSelector(SABLIER_LOCKUP_ABI[0]).slice(2))
      const name = await reader.readContract({ address: lockup, abi: VIEWS, functionName: 'name' })
      expect(name).toBe('Sablier Lockup NFT')
    }, 60_000)

    it('uses the pinned comptroller, which reads a capped fee', async () => {
      const comptroller = await reader.readContract({
        address: lockup,
        abi: VIEWS,
        functionName: 'comptroller',
      })
      expect(getAddress(comptroller)).toBe(SABLIER_COMPTROLLER)
      const address = SABLIER_COMPTROLLER as Address
      const version = await reader.readContract({ address, abi: FEES, functionName: 'VERSION' })
      const max = await reader.readContract({ address, abi: FEES, functionName: 'MAX_FEE_USD' })
      const admin = await reader.readContract({ address, abi: FEES, functionName: 'admin' })
      const oracle = await reader.readContract({ address, abi: FEES, functionName: 'oracle' })
      const usd = await reader.readContract({
        address,
        abi: FEES,
        functionName: 'getMinFeeUSDFor',
        args: [2, SENDER],
      })
      const wei = await reader.readContract({
        address,
        abi: FEES,
        functionName: 'calculateMinFeeWeiFor',
        args: [2, SENDER],
      })
      const implementation = await reader.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION })
      const adminCode = await reader.getCode({ address: admin })
      console.info(chain, {
        version,
        max,
        admin,
        adminCodeBytes: ((adminCode ?? '0x').length - 2) / 2,
        oracle,
        usd,
        wei,
        implementation,
      })
      expect(max).toBe(BigInt(10_000_000_000))
      expect(usd).toBeLessThanOrEqual(max)
      // The card says a single key holds this. If that changes, the card should too.
      expect((adminCode ?? '0x').length).toBe(2)
      const defaults = []
      for (const protocol of [0, 1, 2, 3, 4]) {
        defaults.push(
          await reader.readContract({
            address,
            abi: FEES,
            functionName: 'getMinFeeUSD',
            args: [protocol],
          })
        )
      }
      console.info(chain, { defaultFeesUsdByProtocol: defaults })
    }, 120_000)

    it('reads the fee under the same protocol number Lockup itself asks with', async () => {
      const next = await reader.readContract({
        address: lockup,
        abi: VIEWS,
        functionName: 'nextStreamId',
      })
      console.info(chain, { nextStreamId: next })
      if (next <= BigInt(1)) return
      const streamId = next - BigInt(1)
      const sender = await reader.readContract({
        address: lockup,
        abi: VIEWS,
        functionName: 'getSender',
        args: [streamId],
      })
      const fromLockup = await reader.readContract({
        address: lockup,
        abi: VIEWS,
        functionName: 'calculateMinFeeWei',
        args: [streamId],
      })
      const fromComptroller = await reader.readContract({
        address: SABLIER_COMPTROLLER as Address,
        abi: FEES,
        functionName: 'calculateMinFeeWeiFor',
        args: [2, sender],
      })
      console.info(chain, { streamId, sender, fromLockup, fromComptroller })
      expect(fromComptroller).toBe(fromLockup)
    }, 120_000)

    it.each(SABLIER_STREAMABLE[chain])(
      '%s is a real token with six decimals',
      async (symbol) => {
        const token = EVM_CHAINS[chain].tokens.find((t) => t.symbol === symbol)
        const address = token?.id as Address
        const decimals = await reader.readContract({
          address,
          abi: erc20Abi,
          functionName: 'decimals',
        })
        expect(decimals).toBe(token?.decimals)
        expect(decimals).toBe(6)
      },
      60_000
    )

    it('runs the built stream on the real contract', async () => {
      const venue = createSablierVenue(chain, reader)
      const prepared = await venue.prepare(
        {
          kind: 'stream',
          amount: '5',
          tokenIn: 'USDC',
          recipient: RECIPIENT,
          durationDays: '30',
        },
        SENDER
      )
      const signing = prepared.signing as Extract<SigningPayload, { family: 'evm' }>
      expect(signing.approval).toBeDefined()
      expect(prepared.notes.join('\n')).toContain('bug bounty ended on May 1, 2026')
      console.info(chain, prepared.notes)

      const usdc = usdcOf(chain)
      const balanceSlot = mappingSlot(SENDER, USDC_BALANCE_SLOT)
      const allowanceSlot = mappingSlot(
        lockup,
        keccak256(
          encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }],
            [SENDER, USDC_ALLOWANCE_SLOT]
          )
        ) as never
      )
      const lots = `0x${BigInt(1_000_000_000).toString(16).padStart(64, '0')}` as Hex
      const stateOverride = [
        {
          address: usdc,
          stateDiff: [
            { slot: balanceSlot, value: lots },
            { slot: allowanceSlot, value: lots },
          ],
        },
      ]

      const result = await reader.call({
        account: SENDER,
        to: signing.to as Address,
        data: signing.data as Hex,
        stateOverride,
      })
      const streamId = decodeFunctionResult({
        abi: SABLIER_LOCKUP_ABI,
        functionName: 'createWithDurationsLL',
        data: result.data as Hex,
      })
      const next = await reader.readContract({
        address: lockup,
        abi: VIEWS,
        functionName: 'nextStreamId',
      })
      expect(streamId).toBe(next)
    }, 180_000)
  })
})
