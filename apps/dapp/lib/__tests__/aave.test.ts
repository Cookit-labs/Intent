import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  parseAbi,
  toFunctionSelector,
  type Address,
} from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AAVE_AVALANCHE_MARKET,
  AAVE_MONAD_MARKET,
  aaveAvalancheVenue,
  aaveMonadVenue,
  aaveOraclePriceUsd,
  createAaveVenue,
  neverlandVenue,
  NEVERLAND_MARKET,
  MIN_HEALTH_FACTOR,
  type AaveMarket,
} from '../chains/evm/aave'
import { aaveListings } from '../chains/evm/aave-listing'
import type { EvmReaderClient } from '../chains/evm/call'
import { neverlandListing } from '../chains/evm/neverland-listing'
import { ChainActionRefused, type ChainActionKind, type SigningPayload } from '../chains/types'

const ACCOUNT = '0x1111111111111111111111111111111111111111'
const STRANGER = '0x2222222222222222222222222222222222222222'
const ORACLE = '0x4444444444444444444444444444444444444444'
const NOT_A_RESERVE = '0x5555555555555555555555555555555555555555'
const USDC = AAVE_AVALANCHE_MARKET.tokens.find((t) => t.symbol === 'USDC')!.id as Address
const USDT = AAVE_AVALANCHE_MARKET.tokens.find((t) => t.symbol === 'USDT')!.id as Address
const POOL = AAVE_AVALANCHE_MARKET.pool as Address
const AVALANCHE_ID = 43114
const UNITS = BigInt(10_000_000)
const RAY = BigInt(10) ** BigInt(27)

const POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function setUserEMode(uint8 categoryId)',
])

function supplyData(asset: Address = USDC, onBehalfOf = ACCOUNT, amount = UNITS, referral = 0) {
  return encodeFunctionData({
    abi: POOL_ABI,
    functionName: 'supply',
    args: [asset, amount, onBehalfOf as Address, referral],
  })
}

function withdrawData(to = ACCOUNT, amount = UNITS) {
  return encodeFunctionData({
    abi: POOL_ABI,
    functionName: 'withdraw',
    args: [USDC, amount, to as Address],
  })
}

function borrowData(onBehalfOf = ACCOUNT, mode = BigInt(2), amount = UNITS) {
  return encodeFunctionData({
    abi: POOL_ABI,
    functionName: 'borrow',
    args: [USDC, amount, mode, 0, onBehalfOf as Address],
  })
}

function repayData(onBehalfOf = ACCOUNT, mode = BigInt(2), amount = UNITS) {
  return encodeFunctionData({
    abi: POOL_ABI,
    functionName: 'repay',
    args: [USDC, amount, mode, onBehalfOf as Address],
  })
}

function approveData(spender: string = POOL, units = UNITS) {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender as Address, units],
  })
}

function payload(overrides: Partial<Extract<SigningPayload, { family: 'evm' }>> = {}) {
  return {
    family: 'evm' as const,
    chainId: AVALANCHE_ID,
    to: POOL,
    data: supplyData(),
    value: '0',
    ...overrides,
  }
}

/** How the older Aave code Neverland runs says why: Error(string), with a numbered code. */
function errorString(code: string): string {
  return `0x08c379a0${encodeAbiParameters([{ type: 'string' }], [code]).slice(2)}`
}

function refusesAvalanche(signing: SigningPayload, account: string = ACCOUNT) {
  expect(() => aaveAvalancheVenue.assertSafe(signing, account)).toThrow(ChainActionRefused)
}

describe('what each market takes', () => {
  it('is what it lists, whatever else the chain’s table holds', () => {
    const symbols = (market: { tokens: readonly { symbol: string }[] }): string[] =>
      market.tokens.map((token) => token.symbol)
    expect(symbols(AAVE_AVALANCHE_MARKET)).toEqual(['USDC', 'USDT', 'WAVAX', 'WETH.e'])
    expect(symbols(AAVE_MONAD_MARKET)).toEqual(['USDC', 'USDT0', 'WETH'])
    expect(symbols(NEVERLAND_MARKET)).toEqual(['USDC', 'USDT0'])
  })
})

describe('Aave and Neverland assertSafe', () => {
  it.each<[string, SigningPayload]>([
    ['a supply for the person', payload()],
    ['a supply with an exact approval', payload({ approval: { to: USDC, data: approveData() } })],
    ['a withdraw to the person', payload({ data: withdrawData() })],
    [
      'a withdraw of everything, to the person',
      payload({ data: withdrawData(ACCOUNT, maxUint256) }),
    ],
    ['a variable borrow for the person', payload({ data: borrowData() })],
    ['a repay for the person', payload({ data: repayData() })],
    [
      'a repay with an exact approval',
      payload({ data: repayData(), approval: { to: USDC, data: approveData() } }),
    ],
  ])('passes %s', (_name, signing) => {
    expect(() => aaveAvalancheVenue.assertSafe(signing, ACCOUNT)).not.toThrow()
  })

  it.each<[string, SigningPayload]>([
    ['another family', { family: 'sui', transaction: 'AA==' }],
    ['another chain', payload({ chainId: 143 })],
    ['an unknown contract', payload({ to: STRANGER })],
    ["Neverland's pool on Aave's venue", payload({ to: NEVERLAND_MARKET.pool })],
    [
      'the legacy deposit function',
      payload({
        data: encodeFunctionData({
          abi: POOL_ABI,
          functionName: 'deposit',
          args: [USDC, UNITS, ACCOUNT as Address, 0],
        }),
      }),
    ],
    [
      'a function outside the list',
      payload({
        data: encodeFunctionData({ abi: POOL_ABI, functionName: 'setUserEMode', args: [1] }),
      }),
    ],
    ['extra calldata', payload({ data: `${supplyData()}00` })],
    ['native value', payload({ value: '1' })],
    ['a supply credited to someone else', payload({ data: supplyData(USDC, STRANGER) })],
    ['a withdraw paid to someone else', payload({ data: withdrawData(STRANGER) })],
    ['a borrow on someone else’s credit', payload({ data: borrowData(STRANGER) })],
    ['a repay of someone else’s debt', payload({ data: repayData(STRANGER) })],
    ['a stable-rate borrow', payload({ data: borrowData(ACCOUNT, BigInt(1)) })],
    ['a stable-rate repay', payload({ data: repayData(ACCOUNT, BigInt(1)) })],
    ['a token that is not listed', payload({ data: supplyData(NOT_A_RESERVE) })],
    ['a referral code', payload({ data: supplyData(USDC, ACCOUNT, UNITS, 7) })],
    ['a zero amount', payload({ data: supplyData(USDC, ACCOUNT, BigInt(0)) })],
    ['a repay of everything owed', payload({ data: repayData(ACCOUNT, BigInt(2), maxUint256) })],
    ['a supply of max-uint', payload({ data: supplyData(USDC, ACCOUNT, maxUint256) })],
    ['a borrow of max-uint', payload({ data: borrowData(ACCOUNT, BigInt(2), maxUint256) })],
    [
      'a whole withdraw paid to someone else',
      payload({ data: withdrawData(STRANGER, maxUint256) }),
    ],
    [
      'an approval beside a whole withdraw',
      payload({
        data: withdrawData(ACCOUNT, maxUint256),
        approval: { to: USDC, data: approveData() },
      }),
    ],
    [
      'an unlimited approval',
      payload({ approval: { to: USDC, data: approveData(POOL, maxUint256) } }),
    ],
    ['an approval to a stranger', payload({ approval: { to: USDC, data: approveData(STRANGER) } })],
    [
      'an approval of an unlisted token',
      payload({ approval: { to: NOT_A_RESERVE, data: approveData() } }),
    ],
    [
      'an approval of another token than the supply',
      payload({ approval: { to: USDT, data: approveData() } }),
    ],
    [
      'an approval above the amount',
      payload({ approval: { to: USDC, data: approveData(POOL, UNITS + BigInt(1)) } }),
    ],
    [
      'an approval below the amount',
      payload({ approval: { to: USDC, data: approveData(POOL, UNITS - BigInt(1)) } }),
    ],
    [
      'an approval beside a withdraw',
      payload({ data: withdrawData(), approval: { to: USDC, data: approveData() } }),
    ],
    [
      'an approval beside a borrow',
      payload({ data: borrowData(), approval: { to: USDC, data: approveData() } }),
    ],
  ])('refuses %s', (_name, signing) => {
    refusesAvalanche(signing)
  })

  it('refuses a call built for a different signer', () => {
    refusesAvalanche(payload(), STRANGER)
  })

  it('keeps each venue to its own pool', () => {
    const monadSupply = {
      family: 'evm' as const,
      chainId: 143,
      to: AAVE_MONAD_MARKET.pool,
      data: supplyData(tokenOf(AAVE_MONAD_MARKET, 'USDC')),
      value: '0',
    }
    expect(() => aaveMonadVenue.assertSafe(monadSupply, ACCOUNT)).not.toThrow()
    expect(() => neverlandVenue.assertSafe(monadSupply, ACCOUNT)).toThrow(ChainActionRefused)
    expect(() =>
      neverlandVenue.assertSafe({ ...monadSupply, to: NEVERLAND_MARKET.pool }, ACCOUNT)
    ).not.toThrow()
  })
})

function tokenOf(market: AaveMarket, symbol: string): Address {
  return market.tokens.find((t) => t.symbol === symbol)!.id as Address
}

interface Fixture {
  frozen?: boolean
  paused?: boolean
  active?: boolean
  borrowingEnabled?: boolean
  liquidityRate?: bigint
  variableBorrowRate?: bigint
  totalAToken?: bigint
  totalDebt?: bigint
  supplyCap?: bigint
  borrowCap?: bigint
  allowance?: bigint
  balance?: bigint
  aTokenBalance?: bigint
  variableDebt?: bigint
  usedAsCollateral?: boolean
  collateralBase?: bigint
  debtBase?: bigint
  availableBase?: bigint
  thresholdBps?: bigint
  eMode?: bigint
  reserveThresholdBps?: bigint
  price?: bigint
  simulationFails?: boolean
  revertData?: string
  failRead?: string
}

/** Stands in for the chain, with an ordinary healthy account: $1000 of collateral and no debt. */
function fakeReader(fixture: Fixture = {}) {
  const calls: { to: string; data: string }[] = []
  const reads: string[] = []
  const f = {
    frozen: false,
    paused: false,
    active: true,
    borrowingEnabled: true,
    liquidityRate: RAY / BigInt(25),
    variableBorrowRate: RAY / BigInt(10),
    totalAToken: BigInt(1_000_000_000_000),
    totalDebt: BigInt(500_000_000_000),
    supplyCap: BigInt(0),
    borrowCap: BigInt(0),
    allowance: BigInt(0),
    balance: BigInt(1_000_000_000),
    aTokenBalance: BigInt(100_000_000),
    variableDebt: BigInt(0),
    usedAsCollateral: true,
    collateralBase: BigInt(100_000_000_000),
    debtBase: BigInt(0),
    availableBase: BigInt(75_000_000_000),
    thresholdBps: BigInt(8000),
    eMode: BigInt(0),
    reserveThresholdBps: BigInt(8000),
    price: BigInt(100_000_000),
    ...fixture,
  }
  const reader = {
    readContract: async ({ functionName }: { functionName: string }) => {
      reads.push(functionName)
      if (f.failRead === functionName) throw new Error('rpc down')
      switch (functionName) {
        case 'getReserveConfigurationData':
          return [
            BigInt(6),
            BigInt(7500),
            f.reserveThresholdBps,
            BigInt(10500),
            BigInt(1000),
            true,
            f.borrowingEnabled,
            false,
            f.active,
            f.frozen,
          ]
        case 'getReserveData':
          return [
            BigInt(0),
            BigInt(0),
            f.totalAToken,
            BigInt(0),
            f.totalDebt,
            f.liquidityRate,
            f.variableBorrowRate,
            BigInt(0),
            BigInt(0),
            RAY,
            RAY,
            1,
          ]
        case 'getPaused':
          return f.paused
        case 'getReserveCaps':
          return [f.borrowCap, f.supplyCap]
        case 'getUserReserveData':
          return [
            f.aTokenBalance,
            BigInt(0),
            f.variableDebt,
            BigInt(0),
            f.variableDebt,
            BigInt(0),
            f.liquidityRate,
            0,
            f.usedAsCollateral,
          ]
        case 'getUserAccountData':
          return [
            f.collateralBase,
            f.debtBase,
            f.availableBase,
            f.thresholdBps,
            BigInt(7500),
            maxUint256,
          ]
        case 'getUserEMode':
          return f.eMode
        case 'getPriceOracle':
          return ORACLE
        case 'getAssetPrice':
          return f.price
        case 'allowance':
          return f.allowance
        case 'balanceOf':
          return f.balance
        default:
          throw new Error(`Unexpected read: ${functionName}`)
      }
    },
    multicall: async ({
      contracts,
    }: {
      contracts: { functionName: string }[]
    }): Promise<unknown[]> =>
      Promise.all(contracts.map((contract) => reader.readContract(contract))),
    call: async (call: { to: string; data: string }) => {
      calls.push(call)
      if (f.revertData !== undefined) {
        throw Object.assign(new Error('reverted'), { cause: { data: f.revertData } })
      }
      if (f.simulationFails === true) throw new Error('reverted')
      return { data: '0x' }
    },
  }
  return { reader: reader as unknown as EvmReaderClient, calls, reads }
}

function venueWith(fixture: Fixture = {}, market: AaveMarket = AAVE_AVALANCHE_MARKET) {
  const fake = fakeReader(fixture)
  return { venue: createAaveVenue(market, fake.reader), ...fake }
}

function ask(kind: ChainActionKind, amount = '10', tokenIn = 'USDC') {
  return { kind, amount, tokenIn }
}

function evmSigning(signing: SigningPayload) {
  if (signing.family !== 'evm') throw new Error('Expected an EVM payload.')
  return signing
}

describe('supply', () => {
  it('builds the supply with an exact approval and reads the base rate', async () => {
    const { venue } = venueWith()
    const prepared = await venue.prepare(ask('supply'), ACCOUNT)
    const signing = evmSigning(prepared.signing)
    expect(signing.to).toBe(POOL)
    expect(signing.data).toBe(supplyData())
    expect(signing.approval).toEqual({ to: USDC, data: approveData() })
    expect(prepared.apy?.basePercent).toBeCloseTo(4.08, 2)
    expect(prepared.apy?.rewardPercent).toBeUndefined()
    expect(prepared.pay).toEqual({ amount: '10', symbol: 'USDC' })
    expect(() => venue.assertSafe(signing, ACCOUNT)).not.toThrow()
  })

  it('skips the approval when the allowance covers it, and tries the call', async () => {
    const { venue, calls } = venueWith({ allowance: UNITS })
    const prepared = await venue.prepare(ask('supply'), ACCOUNT)
    expect(evmSigning(prepared.signing).approval).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('tells the person the wallet asks twice only when it does', async () => {
    const twice = await venueWith().venue.prepare(ask('supply'), ACCOUNT)
    const once = await venueWith({ allowance: UNITS }).venue.prepare(ask('supply'), ACCOUNT)
    expect(twice.notes.join(' ')).toContain('asks twice')
    expect(once.notes.join(' ')).not.toContain('asks twice')
  })

  it('quotes the rate with nothing built or tried', async () => {
    const { venue, calls, reads } = venueWith()
    const quote = await venue.quote!(ask('supply'), ACCOUNT)
    expect(quote.apyPercent).toBeCloseTo(4.08, 2)
    expect(calls).toHaveLength(0)
    expect(reads).not.toContain('allowance')
  })

  it.each<[string, Fixture, RegExp]>([
    ['a frozen reserve', { frozen: true }, /frozen/],
    ['a paused reserve', { paused: true }, /paused/],
    ['an inactive reserve', { active: false }, /isn't open/],
    [
      'a full supply cap',
      { supplyCap: BigInt(1_000_000), totalAToken: BigInt(1_000_000_000_000) },
      /supply cap/,
    ],
    ['too little in the wallet', { balance: BigInt(1) }, /hold/],
    ['an unreadable reserve', { failRead: 'getReserveConfigurationData' }, /read/],
    ['an unreadable balance', { failRead: 'balanceOf' }, /read/],
    ['an unreadable allowance', { failRead: 'allowance' }, /read/],
  ])('refuses %s', async (_name, fixture, words) => {
    const { venue } = venueWith(fixture)
    const asked = venue.prepare(ask('supply'), ACCOUNT)
    await expect(asked).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(asked).rejects.toThrow(words)
    await expect(asked).rejects.toThrow(/Nothing was signed or sent\.$/)
  })

  it('refuses a token this market does not take', async () => {
    const { venue } = venueWith()
    await expect(venue.prepare(ask('supply', '1', 'DOGE'), ACCOUNT)).rejects.toBeInstanceOf(
      ChainActionRefused
    )
  })

  it('refuses an account that is not an address', async () => {
    const { venue } = venueWith()
    await expect(venue.prepare(ask('supply'), 'not-an-address')).rejects.toBeInstanceOf(
      ChainActionRefused
    )
  })

  it('refuses a call the chain says would fail', async () => {
    const { venue } = venueWith({ allowance: UNITS, simulationFails: true })
    await expect(venue.prepare(ask('supply'), ACCOUNT)).rejects.toBeInstanceOf(ChainActionRefused)
  })
})

describe('borrow', () => {
  it('sets the floor at 1.5', () => {
    expect(MIN_HEALTH_FACTOR).toBe(1.5)
  })

  it('builds a variable-rate borrow for the person, tried against the chain', async () => {
    const { venue, calls } = venueWith()
    const prepared = await venue.prepare(ask('borrow'), ACCOUNT)
    const signing = evmSigning(prepared.signing)
    expect(signing.data).toBe(borrowData())
    expect(signing.approval).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(prepared.pay).toEqual({ amount: '10', symbol: 'USDC' })
    expect(() => venue.assertSafe(signing, ACCOUNT)).not.toThrow()
  })

  it('says plainly the loan can be liquidated, and shows the health it would leave', async () => {
    const { venue } = venueWith()
    const { notes } = await venue.prepare(ask('borrow'), ACCOUNT)
    const text = notes.join(' ')
    expect(text).toMatch(/liquidat/i)
    expect(text).toContain('80.00')
    expect(text).toMatch(/rate/i)
  })

  it('reads the health before it builds', async () => {
    const { venue, reads } = venueWith()
    await venue.prepare(ask('borrow'), ACCOUNT)
    expect(reads).toContain('getUserAccountData')
    expect(reads).toContain('getAssetPrice')
  })

  it('passes a borrow landing on the floor', async () => {
    // $1000 of collateral at an 80% threshold, over a $533 loan, is just above 1.5.
    const { venue } = venueWith({ debtBase: BigInt(0) })
    const prepared = await venue.prepare(ask('borrow', '533'), ACCOUNT)
    expect(prepared.kind).toBe('borrow')
  })

  it('refuses a borrow that would land just under the floor', async () => {
    const { venue } = venueWith({ debtBase: BigInt(0) })
    await expect(venue.prepare(ask('borrow', '534'), ACCOUNT)).rejects.toThrow(/1\.5/)
  })

  it('counts existing debt against the floor', async () => {
    const { venue } = venueWith({ debtBase: BigInt(50_000_000_000) })
    await expect(venue.prepare(ask('borrow', '40'), ACCOUNT)).rejects.toThrow(/1\.5/)
  })

  it.each<[string, Fixture, RegExp]>([
    ['no collateral', { collateralBase: BigInt(0), availableBase: BigInt(0) }, /collateral/],
    ['collateral that can back no new loan', { availableBase: BigInt(0) }, /back/],
    ['a frozen reserve', { frozen: true }, /frozen/],
    ['a paused reserve', { paused: true }, /paused/],
    ['borrowing switched off', { borrowingEnabled: false }, /borrow/],
    ['no price', { price: BigInt(0) }, /price/],
    ['an unreadable account', { failRead: 'getUserAccountData' }, /read/],
    ['an unreadable price', { failRead: 'getAssetPrice' }, /read/],
    ['an unreadable oracle', { failRead: 'getPriceOracle' }, /read/],
    ['a full borrow cap', { borrowCap: BigInt(1), totalDebt: BigInt(1_000_000) }, /borrow cap/],
    ['too little free in the pool', { totalAToken: BigInt(1), totalDebt: BigInt(1) }, /free/],
  ])('refuses %s', async (_name, fixture, words) => {
    const { venue } = venueWith(fixture)
    const asked = venue.prepare(ask('borrow'), ACCOUNT)
    await expect(asked).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(asked).rejects.toThrow(words)
  })
})

describe('repay', () => {
  it('builds a repay of the person’s own variable debt', async () => {
    const { venue } = venueWith({ variableDebt: UNITS })
    const prepared = await venue.prepare(ask('repay'), ACCOUNT)
    const signing = evmSigning(prepared.signing)
    expect(signing.data).toBe(repayData())
    expect(signing.approval).toEqual({ to: USDC, data: approveData() })
    expect(() => venue.assertSafe(signing, ACCOUNT)).not.toThrow()
  })

  it('stays open on a frozen reserve', async () => {
    const { venue } = venueWith({ variableDebt: UNITS, frozen: true })
    await expect(venue.prepare(ask('repay'), ACCOUNT)).resolves.toMatchObject({ kind: 'repay' })
  })

  it('says only what is owed is taken when asked to pay more', async () => {
    const { venue } = venueWith({ variableDebt: BigInt(5_000_000) })
    const { notes } = await venue.prepare(ask('repay'), ACCOUNT)
    expect(notes.join(' ')).toContain('5')
    expect(notes.join(' ')).toMatch(/only what you owe/i)
  })

  it('lets a wallet holding only what is owed pay more than it holds', async () => {
    const { venue } = venueWith({ variableDebt: BigInt(5_000_000), balance: BigInt(5_000_000) })
    await expect(venue.prepare(ask('repay'), ACCOUNT)).resolves.toMatchObject({ kind: 'repay' })
  })

  it.each<[string, Fixture, RegExp]>([
    ['no debt', { variableDebt: BigInt(0) }, /owe/],
    ['too little in the wallet', { variableDebt: UNITS, balance: BigInt(1) }, /hold/],
    ['a paused reserve', { variableDebt: UNITS, paused: true }, /paused/],
    ['an unreadable debt', { failRead: 'getUserReserveData' }, /read/],
  ])('refuses %s', async (_name, fixture, words) => {
    const { venue } = venueWith(fixture)
    const asked = venue.prepare(ask('repay'), ACCOUNT)
    await expect(asked).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(asked).rejects.toThrow(words)
  })
})

describe('withdraw', () => {
  it('builds a withdraw to the person, with no approval', async () => {
    const { venue, calls } = venueWith()
    const prepared = await venue.prepare(ask('withdraw'), ACCOUNT)
    const signing = evmSigning(prepared.signing)
    expect(signing.data).toBe(withdrawData())
    expect(signing.approval).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(prepared.pay).toEqual({ amount: '10', symbol: 'USDC' })
  })

  it('stays open on a frozen reserve', async () => {
    const { venue } = venueWith({ frozen: true })
    await expect(venue.prepare(ask('withdraw'), ACCOUNT)).resolves.toMatchObject({
      kind: 'withdraw',
    })
  })

  it('passes a withdraw from a position with no debt, whatever it does to the collateral', async () => {
    const { venue } = venueWith({ aTokenBalance: BigInt(100_000_000_000), debtBase: BigInt(0) })
    await expect(venue.prepare(ask('withdraw', '900'), ACCOUNT)).resolves.toMatchObject({
      kind: 'withdraw',
    })
  })

  it('passes a withdraw of a supply that backs no loan', async () => {
    const { venue } = venueWith({ debtBase: BigInt(50_000_000_000), usedAsCollateral: false })
    await expect(venue.prepare(ask('withdraw'), ACCOUNT)).resolves.toMatchObject({
      kind: 'withdraw',
    })
  })

  it.each<[string, Fixture, string, RegExp]>([
    ['more than is supplied', { aTokenBalance: BigInt(1) }, '10', /supplied/],
    ['nothing supplied', { aTokenBalance: BigInt(0) }, '10', /supplied/],
    ['a paused reserve', { paused: true }, '10', /paused/],
    ['too little free in the pool', { totalAToken: BigInt(1), totalDebt: BigInt(1) }, '10', /free/],
    [
      'taking collateral a loan needs below the floor',
      {
        aTokenBalance: BigInt(1_000_000_000),
        debtBase: BigInt(50_000_000_000),
      },
      '400',
      /1\.5/,
    ],
    [
      'collateral backing a loan under E-Mode',
      { debtBase: BigInt(1_000_000_000), eMode: BigInt(1) },
      '10',
      /E-Mode/,
    ],
    ['an unreadable account', { failRead: 'getUserAccountData' }, '10', /read/],
  ])('refuses %s', async (_name, fixture, amount, words) => {
    const { venue } = venueWith(fixture)
    const asked = venue.prepare(ask('withdraw', amount), ACCOUNT)
    await expect(asked).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(asked).rejects.toThrow(words)
  })
})

describe('where the money is', () => {
  it('reads supplied and borrowed with interest, for every token this market lists', async () => {
    const { venue } = venueWith({ aTokenBalance: BigInt(12_345_678), variableDebt: BigInt(5) })
    const positions = await venue.positions!(ACCOUNT)
    expect(positions).toContainEqual({ slot: 'supplied', symbol: 'USDC', amount: '12.345678' })
    expect(positions).toContainEqual({ slot: 'borrowed', symbol: 'USDC', amount: '0.000005' })
  })

  it('shows nothing where nothing is there', async () => {
    const { venue } = venueWith({ aTokenBalance: BigInt(0) })
    await expect(venue.positions!(ACCOUNT)).resolves.toEqual([])
  })

  it('throws when it can not read, rather than saying nothing is there', async () => {
    const { venue } = venueWith({ failRead: 'getUserReserveData' })
    await expect(venue.positions!(ACCOUNT)).rejects.toThrow()
  })

  it('refuses an account that is not an address', async () => {
    const { venue } = venueWith()
    await expect(venue.positions!('nope')).rejects.toBeInstanceOf(ChainActionRefused)
  })

  it.each([AAVE_AVALANCHE_MARKET, AAVE_MONAD_MARKET, NEVERLAND_MARKET])(
    'reads on every market',
    async (market) => {
      const { venue } = venueWith({}, market)
      await expect(venue.positions!(ACCOUNT)).resolves.not.toEqual([])
    }
  )
})

describe('all of a supply', () => {
  const whole = { ...ask('withdraw'), wholePosition: true }

  it('uses the Pool’s own max, so interest leaves no dust, and pays only the person', async () => {
    const { venue } = venueWith({ aTokenBalance: BigInt(100_000_123) })
    const prepared = await venue.prepare(whole, ACCOUNT)
    const signing = evmSigning(prepared.signing)
    expect(signing.data).toBe(withdrawData(ACCOUNT, maxUint256))
    expect(signing.approval).toBeUndefined()
    expect(prepared.pay).toEqual({ amount: '100.000123', symbol: 'USDC' })
    expect(prepared.summary).toMatch(/all of your USDC/)
    expect(prepared.notes.join(' ')).toMatch(/nothing stays behind/)
    expect(() => venue.assertSafe(signing, ACCOUNT)).not.toThrow()
    expect(() => venue.assertSafe(signing, STRANGER)).toThrow(ChainActionRefused)
  })

  it('stays a number when only part is asked for', async () => {
    const { venue } = venueWith()
    const prepared = await venue.prepare(ask('withdraw'), ACCOUNT)
    expect(evmSigning(prepared.signing).data).toBe(withdrawData())
  })

  it('stays open on a frozen reserve', async () => {
    const { venue } = venueWith({ frozen: true })
    await expect(venue.prepare(whole, ACCOUNT)).resolves.toMatchObject({ kind: 'withdraw' })
  })

  it.each<[string, Fixture, RegExp]>([
    ['nothing there', { aTokenBalance: BigInt(0) }, /no USDC supplied/],
    ['a paused reserve', { paused: true }, /paused.*stays yours/],
    [
      'less free in the pool than the position',
      { totalAToken: BigInt(1_000), totalDebt: BigInt(0) },
      /Only about 0.001 USDC is free/,
    ],
    [
      'collateral a loan needs',
      {
        aTokenBalance: BigInt(1_000_000_000),
        collateralBase: BigInt(100_000_000_000),
        debtBase: BigInt(50_000_000_000),
      },
      /backs your loan.*Repay some of the loan first/,
    ],
    [
      'a loan under E-Mode',
      { debtBase: BigInt(1_000_000_000), eMode: BigInt(1) },
      /Repay the loan/,
    ],
    ['an unreadable account', { failRead: 'getUserAccountData' }, /read/],
  ])('refuses %s', async (_name, fixture, words) => {
    const { venue } = venueWith(fixture)
    const asked = venue.prepare(whole, ACCOUNT)
    await expect(asked).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(asked).rejects.toThrow(words)
    await expect(asked).rejects.toThrow(/Nothing was signed or sent\.$/)
  })

  it.each<[string, string, RegExp]>([
    [
      'Aave V3’s LTV error',
      toFunctionSelector('LtvValidationFailed()'),
      /withdraw that token first/,
    ],
    [
      'Aave V3’s health error',
      toFunctionSelector('HealthFactorLowerThanLiquidationThreshold()'),
      /loan needs it/,
    ],
    ['Aave V3’s pause error', toFunctionSelector('ReservePaused()'), /paused/],
    ['Neverland’s LTV code', errorString('57'), /withdraw that token first/],
    ['Neverland’s health code', errorString('35'), /loan needs it/],
    ['Neverland’s pause code', errorString('29'), /paused/],
    ['a reason nobody knows', errorString('99'), /would fail on the chain/],
  ])('says why the Pool turned it down, for %s', async (_name, revertData, words) => {
    const { venue } = venueWith({ revertData })
    const asked = venue.prepare(whole, ACCOUNT)
    await expect(asked).rejects.toThrow(words)
    await expect(asked).rejects.toThrow(/Nothing was signed or sent\.$/)
  })
})

describe('all of a loan', () => {
  const whole = { ...ask('repay'), wholePosition: true }
  const OWED = BigInt(50_000_000)
  const NAMED = OWED + OWED / BigInt(10_000) + BigInt(1)

  it('names a little over the debt, with an approval of exactly that, never max-uint', async () => {
    const { venue } = venueWith({ variableDebt: OWED })
    const prepared = await venue.prepare(whole, ACCOUNT)
    const signing = evmSigning(prepared.signing)
    expect(signing.data).toBe(repayData(ACCOUNT, BigInt(2), NAMED))
    expect(signing.approval).toEqual({ to: USDC, data: approveData(POOL, NAMED) })
    expect(prepared.pay).toEqual({ amount: '50', symbol: 'USDC' })
    expect(prepared.summary).toMatch(/all of your USDC loan/)
    expect(() => venue.assertSafe(signing, ACCOUNT)).not.toThrow()
  })

  it('tells the person what the approval covers, and that only the debt is taken', async () => {
    const { venue } = venueWith({ variableDebt: OWED })
    const { notes } = await venue.prepare(whole, ACCOUNT)
    const text = notes.join(' ')
    expect(text).toContain('50.005001')
    expect(text).toMatch(/Only what you owe is taken/)
    expect(text).toMatch(/take exactly 50.005001 USDC/)
  })

  it('needs no approval where the allowance covers it, and tries the call', async () => {
    const { venue, calls } = venueWith({ variableDebt: OWED, allowance: NAMED })
    const prepared = await venue.prepare(whole, ACCOUNT)
    expect(evmSigning(prepared.signing).approval).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('asks for a new approval where one is left short by an earlier repay', async () => {
    const { venue } = venueWith({ variableDebt: OWED, allowance: BigInt(1_000) })
    const prepared = await venue.prepare(whole, ACCOUNT)
    expect(evmSigning(prepared.signing).approval).toEqual({
      to: USDC,
      data: approveData(POOL, NAMED),
    })
  })

  it('passes a wallet holding what is owed and no more, and says it needs a little over', async () => {
    const { venue } = venueWith({ variableDebt: OWED, balance: OWED })
    const { notes } = await venue.prepare(whole, ACCOUNT)
    expect(notes.join(' ')).toMatch(/needs a little more than the loan/)
  })

  it('still refuses a tampered margin: an approval above the amount named', () => {
    const signing = payload({
      data: repayData(ACCOUNT, BigInt(2), NAMED),
      approval: { to: USDC, data: approveData(POOL, NAMED + BigInt(1)) },
    })
    expect(() => aaveAvalancheVenue.assertSafe(signing, ACCOUNT)).toThrow(ChainActionRefused)
  })

  it.each<[string, Fixture, RegExp]>([
    ['nothing owed', { variableDebt: BigInt(0) }, /don't owe/],
    ['a wallet short of the debt', { variableDebt: OWED, balance: OWED - BigInt(1) }, /hold/],
    ['a paused reserve', { variableDebt: OWED, paused: true }, /paused/],
    ['an unreadable debt', { failRead: 'getUserReserveData' }, /read/],
  ])('refuses %s', async (_name, fixture, words) => {
    const { venue } = venueWith(fixture)
    const asked = venue.prepare(whole, ACCOUNT)
    await expect(asked).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(asked).rejects.toThrow(words)
  })

  it('stays open on a frozen reserve', async () => {
    const { venue } = venueWith({ variableDebt: OWED, frozen: true })
    await expect(venue.prepare(whole, ACCOUNT)).resolves.toMatchObject({ kind: 'repay' })
  })
})

describe('aaveOraclePriceUsd', () => {
  const usdc = AAVE_AVALANCHE_MARKET.tokens.find((t) => t.symbol === 'USDC')!

  it('reads dollars from the market’s oracle', async () => {
    const { reader } = fakeReader({ price: BigInt(242_500_000_000) })
    await expect(aaveOraclePriceUsd(AAVE_AVALANCHE_MARKET, usdc, reader)).resolves.toBe(2425)
  })

  it.each<[string, Fixture]>([
    ['a failed read', { failRead: 'getAssetPrice' }],
    ['a zero price', { price: BigInt(0) }],
  ])('gives no price on %s', async (_name, fixture) => {
    const { reader } = fakeReader(fixture)
    await expect(aaveOraclePriceUsd(AAVE_AVALANCHE_MARKET, usdc, reader)).resolves.toBeUndefined()
  })
})

describe('listings and logos', () => {
  it.each([...aaveListings, neverlandListing].map((listing) => [listing.id, listing] as const))(
    '%s says it executes, and has its logo',
    (id, listing) => {
      expect(listing.integration).toBe('executes')
      expect(listing.family).toBe('evm')
      expect(existsSync(join(__dirname, '../../public/images/venues', `${id}.webp`))).toBe(true)
    }
  )

  it('lists the ids the venues answer to', () => {
    expect(aaveListings.map((l) => l.id)).toEqual([aaveAvalancheVenue.id, aaveMonadVenue.id])
    expect(neverlandListing.id).toBe(neverlandVenue.id)
  })
})

describe('notes', () => {
  it('names admin risk, the freeze and the KelpDAO bad debt on Aave', async () => {
    const { notes } = await venueWith().venue.prepare(ask('supply'), ACCOUNT)
    const text = notes.join(' ')
    expect(text).toMatch(/upgrade/i)
    expect(text).toMatch(/KelpDAO/)
    expect(text).toMatch(/frozen|froze/i)
  })

  it('says Neverland is separate from Aave, and its upgrade delay', async () => {
    const { notes } = await venueWith({}, NEVERLAND_MARKET).venue.prepare(
      ask('supply', '10', 'USDC'),
      ACCOUNT
    )
    const text = notes.join(' ')
    expect(text).toMatch(/not run by Aave|not Aave/i)
    expect(text).toMatch(/24-hour/)
    expect(text).not.toMatch(/KelpDAO/)
  })

  it('tells a supplier how to get out', async () => {
    const { notes } = await venueWith().venue.prepare(ask('supply'), ACCOUNT)
    expect(notes.join(' ')).toMatch(/withdraw/i)
  })

  it('has no em dash in anything the person reads', async () => {
    const { notes, summary } = await venueWith({ variableDebt: UNITS }).venue.prepare(
      ask('repay'),
      ACCOUNT
    )
    expect([...notes, summary].join(' ')).not.toContain('—')
  })
})
