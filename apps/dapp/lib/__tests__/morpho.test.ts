import { decodeFunctionData, encodeAbiParameters, erc20Abi, keccak256, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import type { EvmReaderClient } from '../chains/evm/call'
import {
  createMorphoVenue,
  MORPHO_ADAPTER,
  MORPHO_REVIEWED_MARKETS,
  MORPHO_VAULT,
  readMorphoLiquidity,
} from '../chains/evm/morpho'
import { morphoListing } from '../chains/evm/morpho-listing'
import { MONAD_TOKENS } from '../chains/evm/tokens'
import { ChainActionRefused, type ChainActionRequest } from '../chains/types'
import { ACCOUNT, describeVaultRefusals, redeemData, STRANGER } from './erc4626-refusals'

const MONAD_ID = 143
const SUPPLY: ChainActionRequest = { kind: 'supply', amount: '100', tokenIn: 'USDC' }
const WITHDRAW: ChainActionRequest = { kind: 'withdraw', amount: '100', tokenIn: 'USDC' }

const units = (usdc: number) => BigInt(usdc) * BigInt(1_000_000)
const PARAMS = [
  { type: 'address' },
  { type: 'address' },
  { type: 'address' },
  { type: 'address' },
  { type: 'uint256' },
] as const
const LIQUIDITY_DATA = encodeAbiParameters(PARAMS, [
  MORPHO_VAULT.asset.id as Address,
  '0x01bFF41798a0BcF287b996046Ca68b395DbC1071',
  '0xE0b4E42B082F639bc95f4EDf95deEBE7b5Ea94aa',
  '0x09475a3D6eA8c314c592b1a3799bDE044E2F400F',
  BigInt('770000000000000000'),
])

interface Scene {
  held?: bigint
  shares?: bigint
  allowance?: bigint
  idle?: bigint
  marketFree?: bigint
  priceNow?: bigint
  priceWas?: bigint
  historyFails?: boolean
  markets?: readonly string[]
  adapters?: bigint
  liquidityFails?: boolean
  simulationFails?: boolean
  gated?: boolean
  sharesFail?: boolean
}

const WEEK = 604_800
const NOW_BLOCK = BigInt(100_000_000)
const NOW_TIME = BigInt(1_800_000_000)
const PRICE = BigInt('1000000000000')

function fakeReader(scene: Scene = {}) {
  const calls: { to?: string; data?: string }[] = []
  const reader = {
    getBlock: async (input?: { blockNumber?: bigint }) => {
      if (input?.blockNumber !== undefined && scene.historyFails) throw new Error('no history')
      return input?.blockNumber === undefined
        ? { number: NOW_BLOCK, timestamp: NOW_TIME }
        : { number: input.blockNumber, timestamp: NOW_TIME - BigInt(WEEK) }
    },
    call: async (input: { to?: string; data?: string }) => {
      calls.push(input)
      if (scene.simulationFails) throw new Error('reverted')
      return {}
    },
    readContract: async ({
      address,
      functionName,
      args,
      blockNumber,
    }: {
      address: string
      functionName: string
      args?: readonly unknown[]
      blockNumber?: bigint
    }) => {
      const isVault = address.toLowerCase() === MORPHO_VAULT.address.toLowerCase()
      switch (functionName) {
        case 'balanceOf':
          if (isVault && scene.sharesFail) throw new Error('no reading')
          if (isVault) return scene.shares ?? BigInt(0)
          return (args?.[0] as string).toLowerCase() === MORPHO_VAULT.address.toLowerCase()
            ? (scene.idle ?? units(50_000))
            : (scene.held ?? units(1_000))
        case 'allowance':
          return scene.allowance ?? BigInt(0)
        case 'totalAssets':
          return units(200_000)
        case 'previewDeposit':
          return BigInt('97000000000000000000')
        case 'convertToAssets':
          if (blockNumber === undefined) return args?.[0] as bigint
          if (blockNumber !== NOW_BLOCK && scene.historyFails) throw new Error('no history')
          return blockNumber === NOW_BLOCK
            ? (scene.priceNow ?? (PRICE * BigInt(1001)) / BigInt(1000))
            : (scene.priceWas ?? PRICE)
        case 'adaptersLength':
          return scene.adapters ?? BigInt(1)
        case 'adapters':
          return MORPHO_ADAPTER
        case 'marketIdsLength':
          return BigInt((scene.markets ?? MORPHO_REVIEWED_MARKETS).length)
        case 'marketIds':
          return (scene.markets ?? MORPHO_REVIEWED_MARKETS)[Number(args?.[0])]
        case 'liquidityAdapter':
          if (scene.liquidityFails) throw new Error('no reading')
          return MORPHO_ADAPTER
        case 'liquidityData':
          return LIQUIDITY_DATA
        case 'market':
          return [
            units(100_000),
            units(100_000),
            units(100_000) - (scene.marketFree ?? units(10_000)),
            BigInt(0),
            BigInt(0),
            BigInt(0),
          ]
        case 'position':
          return [units(30_000), BigInt(0), BigInt(0)]
        case 'canSendShares':
          return scene.gated !== true
        case 'canReceiveAssets':
          return true
        default:
          throw new Error(`Unexpected read: ${functionName}`)
      }
    },
    multicall: async ({
      contracts,
    }: {
      contracts: { address: string; functionName: string; args?: readonly unknown[] }[]
    }): Promise<unknown[]> =>
      Promise.all(contracts.map((contract) => reader.readContract(contract))),
  }
  return { reader: reader as unknown as EvmReaderClient, calls }
}

function venueWith(scene: Scene = {}) {
  const { reader, calls } = fakeReader(scene)
  return { venue: createMorphoVenue({ reader }), calls }
}

describeVaultRefusals(createMorphoVenue({ reader: fakeReader().reader }), MORPHO_VAULT, MONAD_ID, [
  // Hyperithm USDC Apex, SharpByte USDC High Yield and August USDC V2: reviewed and left out.
  '0x78999cc96d2Ba0341588C60CcB0E91c6C33CF371',
  '0xf57E9898575fab80b0f2aCDe5443276BeC8C542D',
  '0x80017bF0f793EBbE9679Cd61ff0e395B62CAbB59',
  // The older Steakhouse vault of the same name.
  '0x802c91d807A8DaCA257c4708ab264B6520964e44',
])

describe('Morpho on Monad', () => {
  it('pins the USDC in the chain table', () => {
    expect(MONAD_TOKENS.find((t) => t.symbol === 'USDC')).toEqual(MORPHO_VAULT.asset)
  })

  it('lists as executing on Monad only', () => {
    expect(morphoListing).toMatchObject({
      id: 'morpho',
      family: 'evm',
      chains: ['Monad'],
      integration: 'executes',
    })
  })

  it('builds a deposit crediting the person, with an exact approval', async () => {
    const { venue } = venueWith()
    const prepared = await venue.prepare(SUPPLY, ACCOUNT)
    expect(prepared.venueId).toBe('morpho')
    expect(prepared.receive).toEqual({ amount: '97', symbol: 'bbqUSDC', approximate: true })
    if (prepared.signing.family !== 'evm') throw new Error('Expected an EVM payload.')
    expect(prepared.signing.to).toBe(MORPHO_VAULT.address)
    const approval = decodeFunctionData({
      abi: erc20Abi,
      data: prepared.signing.approval?.data as `0x${string}`,
    })
    expect(approval.functionName).toBe('approve')
    expect(approval.args).toEqual([MORPHO_VAULT.address, units(100)])
    expect(() => venue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
  })

  it('names the curator and the risk on the card', async () => {
    const { venue } = venueWith()
    const { summary, notes } = await venue.prepare(SUPPLY, ACCOUNT)
    expect(summary).toContain('Steakhouse Financial')
    expect(notes.join(' ')).toMatch(/XAUt0, WMON, WETH and WBTC/)
    expect(notes.join(' ')).toMatch(/\$250,000/)
    expect(notes.join(' ')).toMatch(/About 60,000 of the 200,000 USDC/)
  })

  it('tries the call when the allowance is already there', async () => {
    const { venue, calls } = venueWith({ allowance: units(100) })
    const prepared = await venue.prepare(SUPPLY, ACCOUNT)
    expect(calls).toHaveLength(1)
    expect(prepared.signing).not.toHaveProperty('approval')
  })

  it('reads the rate from a week of share price, with no reward part', async () => {
    const { venue } = venueWith({ priceNow: BigInt('1000500000000') })
    const { apy } = await venue.prepare(SUPPLY, ACCOUNT)
    expect(apy?.basePercent).toBeCloseTo((Math.pow(1.0005, 365 / 7) - 1) * 100, 6)
    expect(apy?.rewardPercent).toBeUndefined()
    await expect(venue.quote?.(SUPPLY, ACCOUNT)).resolves.toEqual({
      apyPercent: apy?.basePercent,
    })
  })

  it('shows no rate when the chain has no history, and still builds', async () => {
    const { venue } = venueWith({ historyFails: true })
    const prepared = await venue.prepare(SUPPLY, ACCOUNT)
    expect(prepared).not.toHaveProperty('apy')
    await expect(venue.quote?.(SUPPLY, ACCOUNT)).resolves.toEqual({})
  })

  it('shows no rate when the price has not moved', async () => {
    const { venue } = venueWith({ priceNow: PRICE })
    expect(await venue.prepare(SUPPLY, ACCOUNT)).not.toHaveProperty('apy')
  })

  it('refuses a deposit into a vault that lost value this week', async () => {
    const { venue } = venueWith({ priceNow: PRICE - BigInt(1) })
    await expect(venue.prepare(SUPPLY, ACCOUNT)).rejects.toThrow(/lost value/)
    await expect(venue.quote?.(SUPPLY, ACCOUNT)).rejects.toThrow(/lost value/)
  })

  it('refuses a vault lending to a market that was not reviewed', async () => {
    const { venue } = venueWith({ markets: [...MORPHO_REVIEWED_MARKETS, keccak256('0x01')] })
    await expect(venue.prepare(SUPPLY, ACCOUNT)).rejects.toThrow(/added a market/)
  })

  it('refuses a vault with another adapter', async () => {
    const { venue } = venueWith({ adapters: BigInt(2) })
    await expect(venue.prepare(SUPPLY, ACCOUNT)).rejects.toThrow(/how it lends/)
  })

  it('refuses a deposit into a vault with almost nothing free', async () => {
    const { venue } = venueWith({ idle: units(1_000), marketFree: units(1_000) })
    await expect(venue.prepare(SUPPLY, ACCOUNT)).rejects.toThrow(/won't add to it/)
  })

  it('refuses a deposit when the vault cannot be read', async () => {
    const { venue } = venueWith({ liquidityFails: true })
    await expect(venue.prepare(SUPPLY, ACCOUNT)).rejects.toThrow(/couldn't read/)
  })

  it('refuses more than the wallet holds', async () => {
    const { venue } = venueWith({ held: units(50) })
    await expect(venue.prepare(SUPPLY, ACCOUNT)).rejects.toThrow(/You hold 50 USDC/)
  })

  it('counts cash plus what the liquidity market can give, up to the position', async () => {
    const { reader } = fakeReader({ idle: units(5), marketFree: units(40_000) })
    await expect(readMorphoLiquidity(reader)).resolves.toBe(units(30_005))
  })

  it('builds a withdrawal to the person from the person, with no approval', async () => {
    const { venue, calls } = venueWith({ shares: units(500) })
    const prepared = await venue.prepare(WITHDRAW, ACCOUNT)
    expect(prepared.kind).toBe('withdraw')
    expect(prepared.pay).toEqual({ amount: '100', symbol: 'USDC' })
    expect(calls).toHaveLength(1)
    expect(prepared.signing).not.toHaveProperty('approval')
    expect(() => venue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
    expect(() => venue.assertSafe(prepared.signing, STRANGER)).toThrow(ChainActionRefused)
  })

  it('refuses a withdrawal with no position, or more than the position', async () => {
    await expect(venueWith().venue.prepare(WITHDRAW, ACCOUNT)).rejects.toThrow(/You have no USDC/)
    await expect(venueWith({ shares: units(50) }).venue.prepare(WITHDRAW, ACCOUNT)).rejects.toThrow(
      /about 50 USDC/
    )
  })

  it('says plainly when the vault cannot pay out that much now', async () => {
    const { venue } = venueWith({
      shares: units(5_000),
      idle: units(10),
      marketFree: units(20),
    })
    const request = { ...WITHDRAW, amount: '1000' }
    await expect(venue.prepare(request, ACCOUNT)).rejects.toThrow(/can pay out about 30 USDC/)
  })

  it('leaves the way out open when liquidity cannot be read, and lets the chain decide', async () => {
    const { venue, calls } = venueWith({ shares: units(500), liquidityFails: true })
    await expect(venue.prepare(WITHDRAW, ACCOUNT)).resolves.toMatchObject({ kind: 'withdraw' })
    expect(calls).toHaveLength(1)
  })

  it('refuses a withdrawal that fails on the chain', async () => {
    const { venue } = venueWith({ shares: units(500), simulationFails: true })
    await expect(venue.prepare(WITHDRAW, ACCOUNT)).rejects.toThrow(/would fail on the chain/)
  })
})

describe('Morpho exits', () => {
  const WHOLE: ChainActionRequest = { ...WITHDRAW, wholePosition: true }

  it('shows what the shares are worth now, in the asset', async () => {
    const { venue } = venueWith({ shares: units(500) })
    await expect(venue.positions?.(ACCOUNT)).resolves.toEqual([
      { slot: 'supplied', symbol: 'USDC', amount: '500' },
    ])
  })

  it('shows nothing when there are no shares', async () => {
    await expect(venueWith().venue.positions?.(ACCOUNT)).resolves.toEqual([])
  })

  it('throws when it can not read, rather than saying nothing is there', async () => {
    const { venue } = venueWith({ sharesFail: true })
    await expect(venue.positions?.(ACCOUNT)).rejects.toThrow()
  })

  it('redeems every share for all of it, to and from the person', async () => {
    const { venue } = venueWith({ shares: units(500) })
    const prepared = await venue.prepare(WHOLE, ACCOUNT)
    expect(prepared.signing).toMatchObject({ data: redeemData(units(500)) })
    expect(prepared.pay).toEqual({ amount: '500', symbol: 'USDC' })
    expect(prepared.signing).not.toHaveProperty('approval')
    expect(() => venue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
    expect(() => venue.assertSafe(prepared.signing, STRANGER)).toThrow(ChainActionRefused)
  })

  it('takes all of it even where interest has passed the figure read', async () => {
    const { venue } = venueWith({ shares: units(100) + BigInt(7) })
    const prepared = await venue.prepare(WHOLE, ACCOUNT)
    expect(prepared.signing).toMatchObject({ data: redeemData(units(100) + BigInt(7)) })
  })

  it('refuses all of it when the vault can not pay that much now', async () => {
    const { venue } = venueWith({ shares: units(50_000), idle: units(10), marketFree: units(20) })
    await expect(venue.prepare(WHOLE, ACCOUNT)).rejects.toThrow(/can pay out about 30 USDC/)
  })

  it('refuses all of it when there is nothing there', async () => {
    await expect(venueWith().venue.prepare(WHOLE, ACCOUNT)).rejects.toThrow(/You have no USDC/)
  })

  it('says so when the curator has closed the gate', async () => {
    const { venue } = venueWith({ shares: units(500), gated: true })
    const asked = venue.prepare(WHOLE, ACCOUNT)
    await expect(asked).rejects.toThrow(/closed withdrawals/)
    await expect(asked).rejects.toThrow(/Nothing was signed or sent\.$/)
  })

  it('tells a failed exit apart from a missing fee, in plain words', async () => {
    const { venue } = venueWith({ shares: units(500), simulationFails: true })
    await expect(venue.prepare(WHOLE, ACCOUNT)).rejects.toThrow(/position is still there/)
  })
})
