import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseAbiItem,
  zeroAddress,
  type Address,
} from 'viem'
import { describe, expect, it } from 'vitest'

import { evmReader } from '../chains/evm/client'
import { createFastlaneVenue, SHMON, shmonPriceUsd } from '../chains/evm/fastlane'

/**
 * Read-only, against Monad mainnet: nothing here signs or sends. These fail when FastLane upgrades
 * or moves its keys, which is the cue to review the new code and the card's notes.
 *
 * The account is whoever recently received shMON and still holds it with some MON, found from the
 * chain's logs, since any fixed holder can sell out. It is only ever read and dry-run.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const SLOW_MS = 120_000
const LOG_WINDOW = BigInt(100)
const WINDOWS_TO_SCAN = 200
const ENOUGH = BigInt(10) ** BigInt(17)

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'

const IMPLEMENTATION = '0x8Ee4FF5FF50198dcbB7B882A0781F42724Dd095f'
const PROXY_ADMIN = '0x00b16590295092f12F4cec655296B6129C49489C' as Address
const TIMELOCK = '0x4B7f4A4316c44B6928FB449B14Bd21b9718932F3' as Address
const OPERATIONS_SAFE = '0x48a3267BCc4Cf230e9Bc4cae0c11EEbDb9a6A687' as Address

const ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function previewDeposit(uint256) view returns (uint256)',
  'function getMinDelay() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function getFeeCurveParams() view returns (uint256, uint256)',
  'function getOwners() view returns (address[])',
  'function deposit(uint256 assets, address receiver) payable returns (uint256)',
  'function redeemWithSlippageProtection(uint256 shares, address receiver, address owner, uint256 minAssetsOut) returns (uint256)',
])

const reader = evmReader('monad')
const shmon = SHMON as Address

function addressIn(word: string | undefined): string {
  return getAddress(`0x${(word ?? '').slice(-40)}`)
}

const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
)

let holder: Promise<Address> | undefined

/** A plain account: a contract may refuse MON, which would say nothing about FastLane. */
async function scanForHolder(): Promise<Address> {
  const latest = await reader.getBlockNumber()
  const seen = new Set<Address>()
  for (let i = 0; i < WINDOWS_TO_SCAN; i++) {
    const toBlock = latest - BigInt(i) * LOG_WINDOW
    const logs = await reader.getLogs({
      address: shmon,
      event: TRANSFER,
      fromBlock: toBlock - LOG_WINDOW + BigInt(1),
      toBlock,
    })
    for (const { args } of logs) {
      const to = args.to
      if (to === undefined || to === zeroAddress || seen.has(to)) continue
      seen.add(to)
      const [code, shares, coin] = await Promise.all([
        reader.getCode({ address: to }),
        reader.readContract({ address: shmon, abi: ABI, functionName: 'balanceOf', args: [to] }),
        reader.getBalance({ address: to }),
      ])
      if ((code === undefined || code === '0x') && shares >= ENOUGH && coin >= ENOUGH) return to
    }
  }
  throw new Error('No plain account holding shMON and MON turned up in the logs scanned.')
}

const findHolder = (): Promise<Address> => (holder ??= scanForHolder())

describe.skipIf(SKIP)('FastLane on Monad', () => {
  it(
    'is still the token we pinned',
    async () => {
      const [symbol, decimals] = await Promise.all([
        reader.readContract({ address: shmon, abi: ABI, functionName: 'symbol' }),
        reader.readContract({ address: shmon, abi: ABI, functionName: 'decimals' }),
      ])
      expect(symbol).toBe('shMON')
      expect(decimals).toBe(18)
    },
    SLOW_MS
  )

  it(
    'still runs the implementation we read',
    async () => {
      const word = await reader.getStorageAt({ address: shmon, slot: IMPLEMENTATION_SLOT })
      expect(addressIn(word)).toBe(IMPLEMENTATION)
    },
    SLOW_MS
  )

  it(
    'still has the keys the card describes',
    async () => {
      const [admin, adminOwner, delay, owner, threshold, owners] = await Promise.all([
        reader.getStorageAt({ address: shmon, slot: ADMIN_SLOT }),
        reader.readContract({ address: PROXY_ADMIN, abi: ABI, functionName: 'owner' }),
        reader.readContract({ address: TIMELOCK, abi: ABI, functionName: 'getMinDelay' }),
        reader.readContract({ address: shmon, abi: ABI, functionName: 'owner' }),
        reader.readContract({ address: OPERATIONS_SAFE, abi: ABI, functionName: 'getThreshold' }),
        reader.readContract({ address: OPERATIONS_SAFE, abi: ABI, functionName: 'getOwners' }),
      ])
      expect(addressIn(admin)).toBe(PROXY_ADMIN)
      expect(adminOwner).toBe(TIMELOCK)
      expect(delay).toBe(BigInt(3 * 24 * 60 * 60))
      expect(owner).toBe(OPERATIONS_SAFE)
      expect(threshold).toBe(BigInt(5))
      expect(owners).toHaveLength(7)
    },
    SLOW_MS
  )

  it(
    'still charges the instant exit the fee range the card states',
    async () => {
      const [slope, base] = await reader.readContract({
        address: shmon,
        abi: ABI,
        functionName: 'getFeeCurveParams',
      })
      const ray = BigInt(10) ** BigInt(27)
      expect(slope).toBe(ray / BigInt(100))
      expect(base).toBe((ray * BigInt(5)) / BigInt(100_000))
    },
    SLOW_MS
  )

  it(
    'mints in a dry run what the preview says, and refuses value that does not match',
    async () => {
      const account = await findHolder()
      const amount = BigInt(10) ** BigInt(15)
      const data = encodeFunctionData({
        abi: ABI,
        functionName: 'deposit',
        args: [amount, account],
      })
      const [preview, dry] = await Promise.all([
        reader.readContract({
          address: shmon,
          abi: ABI,
          functionName: 'previewDeposit',
          args: [amount],
        }),
        reader.call({ account, to: shmon, data, value: amount }),
      ])
      // The two reads can land a block apart, and the rate moves a little between blocks.
      const gap = BigInt(dry.data ?? '0x0') - preview
      expect(gap < BigInt(0) ? -gap : gap).toBeLessThan(preview / BigInt(100_000))
      await expect(
        reader.call({ account, to: shmon, data, value: amount - BigInt(1) })
      ).rejects.toThrow()
    },
    SLOW_MS
  )

  it(
    'builds a stake, and passes its own check',
    async () => {
      const account = await findHolder()
      const venue = createFastlaneVenue()
      const prepared = await venue.prepare(
        { kind: 'stake', amount: '0.001', tokenIn: 'MON' },
        account
      )
      expect(() => venue.assertSafe(prepared.signing, account)).not.toThrow()
      expect(Number(prepared.receive?.amount)).toBeGreaterThan(0)
    },
    SLOW_MS
  )

  it(
    'builds an unstake that dry-runs, and the chain refuses a minimum above what it pays',
    async () => {
      const account = await findHolder()
      const venue = createFastlaneVenue()
      const prepared = await venue.prepare(
        { kind: 'unstake', amount: '0.01', tokenIn: 'shMON' },
        account
      )
      expect(() => venue.assertSafe(prepared.signing, account)).not.toThrow()
      expect(Number(prepared.receive?.amount)).toBeGreaterThan(0)
      const tooMuch = encodeFunctionData({
        abi: ABI,
        functionName: 'redeemWithSlippageProtection',
        args: [BigInt(10) ** BigInt(16), account, account, BigInt(10) ** BigInt(18)],
      })
      await expect(reader.call({ account, to: shmon, data: tooMuch })).rejects.toThrow()
    },
    SLOW_MS
  )

  it(
    'values a shMON above a MON',
    async () => {
      const price = await shmonPriceUsd(1)
      expect(price).toBeGreaterThan(1)
    },
    SLOW_MS
  )
})
