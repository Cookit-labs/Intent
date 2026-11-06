import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import type { EvmReaderClient } from '../chains/evm/call'
import type { EvmClient, EvmReceipt } from '../chains/evm/client'
import {
  createCurvanceVenue,
  CURVANCE_CUSDC,
  CURVANCE_MARKET_MANAGER,
  CURVANCE_USDC,
} from '../chains/evm/curvance'
import { curvanceListing } from '../chains/evm/curvance-listing'
import { MONAD_TOKENS } from '../chains/evm/tokens'
import { ChainActionRefused, type ChainActionRequest, type SigningPayload } from '../chains/types'

const ACCOUNT = '0x1111111111111111111111111111111111111111'
const STRANGER = '0x2222222222222222222222222222222222222222'
/** Curvance's cUSDC in its WBTC market: real, but not the one this venue is confirmed for. */
const OTHER_MARKET = '0x7C9d4f1695C6282Da5e5509Aa51fC9fb417C6f1d'
const USDT0 = '0xe7cd86e13AC4309349F30B3435a9d337750fC82D'
const MONAD_ID = 143
const HASH = `0x${'a'.repeat(64)}`
const NOW = BigInt(1_800_000_000)

const CALLS = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'function depositAsCollateral(uint256 assets, address receiver) returns (uint256)',
  'function withdrawCollateral(uint256 assets, address receiver, address owner) returns (uint256)',
  'function borrow(uint256 assets, address receiver)',
  'function repay(uint256 assets)',
  'function transfer(address to, uint256 amount) returns (bool)',
])

function deposit(assets = BigInt(5_000_000), receiver: string = ACCOUNT): string {
  return encodeFunctionData({
    abi: CALLS,
    functionName: 'deposit',
    args: [assets, receiver as Address],
  })
}

function withdraw(
  assets = BigInt(5_000_000),
  receiver: string = ACCOUNT,
  owner: string = ACCOUNT
): string {
  return encodeFunctionData({
    abi: CALLS,
    functionName: 'withdraw',
    args: [assets, receiver as Address, owner as Address],
  })
}

function redeem(
  shares = BigInt(5_000_000),
  receiver: string = ACCOUNT,
  owner: string = ACCOUNT
): string {
  return encodeFunctionData({
    abi: CALLS,
    functionName: 'redeem',
    args: [shares, receiver as Address, owner as Address],
  })
}

function approve(spender: string = CURVANCE_CUSDC, units = BigInt(5_000_000)): string {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender as Address, units],
  })
}

function payload(overrides: Partial<Extract<SigningPayload, { family: 'evm' }>> = {}) {
  return {
    family: 'evm' as const,
    chainId: MONAD_ID,
    to: CURVANCE_CUSDC,
    data: deposit(),
    value: '0',
    ...overrides,
  }
}

interface ChainState {
  usdc: bigint
  allowance: bigint
  shares: bigint
  posted: bigint
  held: bigint
  debt: bigint
  mintPaused: boolean
  listed: boolean
  redeemPaused: number
  cooldown: bigint
  rate: bigint | Error
  callFails: boolean
  readFails: string | undefined
}

const HEALTHY: ChainState = {
  usdc: BigInt(100_000_000),
  allowance: BigInt(0),
  shares: BigInt(50_000_000),
  posted: BigInt(0),
  held: BigInt(30_000_000_000),
  debt: BigInt(270_000_000_000),
  mintPaused: false,
  listed: true,
  redeemPaused: 1,
  cooldown: BigInt(0),
  // 10% a year, per second, in WAD.
  rate: BigInt(3_170_979_198),
  callFails: false,
  readFails: undefined,
}

interface FakeRead {
  address: string
  functionName: string
  args?: readonly unknown[]
}

/** The rate of the real market, one cUSDC to 1.04 USDC, so shares and assets differ as they do live. */
function fakeReader(overrides: Partial<ChainState> = {}): EvmReaderClient & { calls: unknown[] } {
  const state = { ...HEALTHY, ...overrides }
  const calls: unknown[] = []
  const reads: Record<string, (args: readonly unknown[], address: string) => unknown> = {
    balanceOf: (_args, address) => (address === CURVANCE_CUSDC ? state.shares : state.usdc),
    allowance: () => state.allowance,
    collateralPosted: () => state.posted,
    previewDeposit: ([assets]) => ((assets as bigint) * BigInt(100)) / BigInt(104),
    previewWithdraw: ([assets]) => ((assets as bigint) * BigInt(100)) / BigInt(104) + BigInt(1),
    exchangeRateUpdated: () => BigInt('1040000000000000000'),
    assetsHeld: () => state.held,
    marketOutstandingDebt: () => state.debt,
    interestFee: () => 1000,
    IRM: () => '0x1622D77E311638C77779e6D9B212E3e7D73AaFB4',
    actionsPaused: () => [state.mintPaused, false, false],
    isListed: () => state.listed,
    redeemPaused: () => state.redeemPaused,
    accountAssets: () => state.cooldown,
    supplyRate: () => {
      if (state.rate instanceof Error) throw state.rate
      return state.rate
    },
  }
  const readContract = async ({ address, functionName, args = [] }: FakeRead) => {
    if (state.readFails === functionName) throw new Error('rpc down')
    const read = reads[functionName]
    if (read === undefined) throw new Error(`unexpected read ${functionName}`)
    return read(args, address)
  }
  return {
    calls,
    readContract,
    multicall: async ({ contracts }: { contracts: FakeRead[] }) =>
      Promise.all(contracts.map(readContract)),
    call: async (request: unknown) => {
      calls.push(request)
      if (state.callFails) throw new Error('reverted')
      return { data: '0x' }
    },
    getBlock: async () => ({ timestamp: NOW }),
  } as unknown as EvmReaderClient & { calls: unknown[] }
}

function supply(amount = '5', tokenIn = 'USDC'): ChainActionRequest {
  return { kind: 'supply', amount, tokenIn, venue: 'curvance' }
}

function takeOut(amount = '5', tokenIn = 'USDC'): ChainActionRequest {
  return { kind: 'withdraw', amount, tokenIn, venue: 'curvance' }
}

function venue(overrides: Partial<ChainState> = {}) {
  return createCurvanceVenue(() => fakeReader(overrides))
}

function evmSigning(signing: SigningPayload) {
  if (signing.family !== 'evm') throw new Error('expected evm')
  return signing
}

describe('pinned ids', () => {
  it('uses the same USDC as the chain table', () => {
    expect(MONAD_TOKENS.find((t) => t.symbol === 'USDC')?.id).toBe(CURVANCE_USDC)
  })

  it('offers only what it builds', () => {
    expect(venue().kinds).toEqual(['supply', 'withdraw'])
  })

  it('lists the venue as executing on Monad', () => {
    expect(curvanceListing).toMatchObject({
      id: 'curvance',
      family: 'evm',
      category: 'lending',
      chains: ['Monad'],
      integration: 'executes',
    })
  })
})

describe('assertSafe', () => {
  const safe = venue()

  it('passes the deposit and withdrawal it builds', () => {
    expect(() => safe.assertSafe(payload(), ACCOUNT)).not.toThrow()
    expect(() => safe.assertSafe(payload({ data: withdraw() }), ACCOUNT)).not.toThrow()
  })

  it('passes a deposit with its exact approval', () => {
    const signing = payload({ approval: { to: CURVANCE_USDC, data: approve() } })
    expect(() => safe.assertSafe(signing, ACCOUNT)).not.toThrow()
  })

  it('refuses a deposit the wrong account would sign', () => {
    expect(() => safe.assertSafe(payload(), STRANGER)).toThrow(ChainActionRefused)
  })

  it('refuses a withdrawal the wrong account would sign', () => {
    expect(() => safe.assertSafe(payload({ data: withdraw() }), STRANGER)).toThrow(
      ChainActionRefused
    )
  })

  it.each<[string, SigningPayload]>([
    ['another family', { family: 'sui', transaction: 'AA==' }],
    ['another chain', payload({ chainId: 43114 })],
    ['an unknown contract', payload({ to: STRANGER })],
    ["cUSDC in another of Curvance's markets", payload({ to: OTHER_MARKET })],
    ['the market manager', payload({ to: CURVANCE_MARKET_MANAGER })],
    ['native value', payload({ value: '1' })],
    ['calldata that decodes as nothing', payload({ data: '0xdeadbeef' })],
    ['extra calldata on a deposit', payload({ data: `${deposit()}00` })],
    ['extra calldata on a withdrawal', payload({ data: `${withdraw()}00` })],
    ['a deposit credited to someone else', payload({ data: deposit(BigInt(5), STRANGER) })],
    ['a withdrawal paid to someone else', payload({ data: withdraw(BigInt(5), STRANGER) })],
    [
      "a withdrawal of someone else's shares",
      payload({ data: withdraw(BigInt(5), ACCOUNT, STRANGER) }),
    ],
    ['an empty deposit', payload({ data: deposit(BigInt(0)) })],
    ['an empty withdrawal', payload({ data: withdraw(BigInt(0)) })],
    [
      'an unlimited approval',
      payload({ approval: { to: CURVANCE_USDC, data: approve(CURVANCE_CUSDC, maxUint256) } }),
    ],
    [
      'an approval larger than the deposit',
      payload({
        approval: { to: CURVANCE_USDC, data: approve(CURVANCE_CUSDC, BigInt(6_000_000)) },
      }),
    ],
    [
      'an approval smaller than the deposit',
      payload({
        approval: { to: CURVANCE_USDC, data: approve(CURVANCE_CUSDC, BigInt(4_000_000)) },
      }),
    ],
    [
      'an approval to a stranger',
      payload({ approval: { to: CURVANCE_USDC, data: approve(STRANGER) } }),
    ],
    ['an approval of the wrong token', payload({ approval: { to: USDT0, data: approve() } })],
    [
      'an approval with trailing data',
      payload({ approval: { to: CURVANCE_USDC, data: `${approve()}00` } }),
    ],
    [
      'a withdrawal carrying an approval',
      payload({ data: withdraw(), approval: { to: CURVANCE_USDC, data: approve() } }),
    ],
    [
      'a first step that is a transfer',
      payload({
        approval: {
          to: CURVANCE_USDC,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [STRANGER as Address, BigInt(5_000_000)],
          }),
        },
      }),
    ],
  ])('refuses %s', (_label, signing) => {
    expect(() => safe.assertSafe(signing, ACCOUNT)).toThrow(ChainActionRefused)
  })

  it('passes a redeem of the shares, to and from the person', () => {
    expect(() => safe.assertSafe(payload({ data: redeem() }), ACCOUNT)).not.toThrow()
    expect(() => safe.assertSafe(payload({ data: redeem() }), STRANGER)).toThrow(ChainActionRefused)
  })

  it.each<[string, string]>([
    ['paying someone else', redeem(BigInt(5), STRANGER)],
    ['from someone else', redeem(BigInt(5), ACCOUNT, STRANGER)],
    ['of nothing', redeem(BigInt(0))],
    ['naming no amount', redeem(maxUint256)],
    ['with extra data', `${redeem()}00`],
  ])('refuses a redeem %s', (_label, data) => {
    expect(() => safe.assertSafe(payload({ data }), ACCOUNT)).toThrow(ChainActionRefused)
  })

  it('refuses an approval beside a redeem', () => {
    const signing = payload({ data: redeem(), approval: { to: CURVANCE_USDC, data: approve() } })
    expect(() => safe.assertSafe(signing, ACCOUNT)).toThrow(ChainActionRefused)
  })

  it.each<[string, string]>([
    [
      'depositAsCollateral',
      encodeFunctionData({
        abi: CALLS,
        functionName: 'depositAsCollateral',
        args: [BigInt(5), ACCOUNT as Address],
      }),
    ],
    [
      'withdrawCollateral',
      encodeFunctionData({
        abi: CALLS,
        functionName: 'withdrawCollateral',
        args: [BigInt(5), ACCOUNT as Address, ACCOUNT as Address],
      }),
    ],
    [
      'borrow',
      encodeFunctionData({
        abi: CALLS,
        functionName: 'borrow',
        args: [BigInt(5), ACCOUNT as Address],
      }),
    ],
    ['repay', encodeFunctionData({ abi: CALLS, functionName: 'repay', args: [BigInt(0)] })],
    [
      'transfer',
      encodeFunctionData({
        abi: CALLS,
        functionName: 'transfer',
        args: [STRANGER as Address, BigInt(5)],
      }),
    ],
  ])('refuses the unconfirmed function %s', (_label, data) => {
    expect(() => safe.assertSafe(payload({ data }), ACCOUNT)).toThrow(ChainActionRefused)
  })
})

describe('supply', () => {
  it('builds a plain deposit to the person with an exact approval', async () => {
    const prepared = await venue().prepare(supply(), ACCOUNT)
    expect(prepared).toMatchObject({
      venueId: 'curvance',
      kind: 'supply',
      pay: { amount: '5', symbol: 'USDC' },
      receive: { symbol: 'cUSDC', approximate: true },
    })
    const signing = evmSigning(prepared.signing)
    expect(signing.to).toBe(CURVANCE_CUSDC)
    expect(signing.data).toBe(deposit())
    expect(signing.value).toBe('0')
    expect(signing.approval).toEqual({ to: CURVANCE_USDC, data: approve() })
  })

  it('leaves the approval off when one is in place, and tries the call', async () => {
    const reader = fakeReader({ allowance: BigInt(5_000_000) })
    const prepared = await createCurvanceVenue(() => reader).prepare(supply(), ACCOUNT)
    expect(evmSigning(prepared.signing).approval).toBeUndefined()
    expect(reader.calls).toHaveLength(1)
    expect(prepared.notes.join(' ')).not.toContain('asks twice')
  })

  it('says the wallet asks twice when it does', async () => {
    const prepared = await venue().prepare(supply(), ACCOUNT)
    expect(prepared.notes.join(' ')).toContain('exactly 5 USDC')
  })

  it('reads the rate from the chain as a yearly figure, with no reward part', async () => {
    const prepared = await venue().prepare(supply(), ACCOUNT)
    expect(prepared.apy?.basePercent).toBeCloseTo(10, 1)
    expect(prepared.apy?.rewardPercent).toBeUndefined()
  })

  it('shows no rate when it cannot be read, rather than a guess', async () => {
    const prepared = await venue({ rate: new Error('rpc') }).prepare(supply(), ACCOUNT)
    expect(prepared.apy).toBeUndefined()
  })

  it('tells the person about the hold, the market, the admins and what is free', async () => {
    const { notes } = await venue().prepare(supply(), ACCOUNT)
    const text = notes.join(' ')
    expect(text).toContain('WMON')
    expect(text).toContain('20 minutes')
    expect(text).toMatch(/pause/i)
    expect(text).toContain('30000 USDC')
    expect(text).not.toMatch(/—/)
  })

  it.each<[string, ChainActionRequest, Partial<ChainState>]>([
    ['another token', supply('5', 'USDT0'), {}],
    ['the native coin', supply('5', 'MON'), {}],
    ['a zero amount', supply('0'), {}],
    ['more decimals than USDC has', supply('1.0000001'), {}],
    ['more than the wallet holds', supply(), { usdc: BigInt(4_999_999) }],
    ['a market with deposits paused', supply(), { mintPaused: true }],
    ['a token no longer listed', supply(), { listed: false }],
    ['an amount too small to mint a share', supply('0.000001'), {}],
    ['an unreadable pause flag', supply(), { readFails: 'actionsPaused' }],
    ['an unreadable balance', supply(), { readFails: 'balanceOf' }],
    ['a call that would fail', supply(), { allowance: BigInt(5_000_000), callFails: true }],
  ])('refuses %s', async (_label, request, state) => {
    await expect(venue(state).prepare(request, ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })

  it('refuses an account that is not an address', async () => {
    await expect(venue().prepare(supply(), 'not-an-address')).rejects.toThrow(ChainActionRefused)
  })
})

describe('quote', () => {
  it('gives the rate and calls nothing', async () => {
    const reader = fakeReader()
    const quote = await createCurvanceVenue(() => reader).quote?.(supply(), ACCOUNT)
    expect(quote?.apyPercent).toBeCloseTo(10, 1)
    expect(reader.calls).toHaveLength(0)
  })

  it('gives no rate when it cannot be read', async () => {
    const quote = await venue({ rate: new Error('rpc') }).quote?.(supply(), ACCOUNT)
    expect(quote).toEqual({})
  })

  it('refuses a paused market', async () => {
    await expect(venue({ mintPaused: true }).quote?.(supply(), ACCOUNT)).rejects.toThrow(
      ChainActionRefused
    )
  })
})

describe('withdraw', () => {
  it('builds a withdrawal to and from the person, with no approval', async () => {
    const reader = fakeReader()
    const prepared = await createCurvanceVenue(() => reader).prepare(takeOut(), ACCOUNT)
    expect(prepared).toMatchObject({
      venueId: 'curvance',
      kind: 'withdraw',
      pay: { amount: '5', symbol: 'USDC' },
    })
    const signing = evmSigning(prepared.signing)
    expect(signing.to).toBe(CURVANCE_CUSDC)
    expect(signing.data).toBe(withdraw())
    expect(signing.approval).toBeUndefined()
    expect(reader.calls).toHaveLength(1)
  })

  it('refuses during the hold, saying how long is left', async () => {
    const cooldown = NOW - BigInt(300)
    await expect(venue({ cooldown }).prepare(takeOut(), ACCOUNT)).rejects.toThrow(/15 minutes/)
  })

  it('goes ahead the moment the hold ends', async () => {
    const cooldown = NOW - BigInt(1200)
    await expect(venue({ cooldown }).prepare(takeOut(), ACCOUNT)).resolves.toMatchObject({
      kind: 'withdraw',
    })
  })

  it('never takes posted collateral, which could weaken a loan', async () => {
    const state = { shares: BigInt(10_000_000), posted: BigInt(8_000_000) }
    await expect(venue(state).prepare(takeOut(), ACCOUNT)).rejects.toThrow(/collateral/)
  })

  it('takes idle shares while collateral stays posted', async () => {
    const state = { shares: BigInt(10_000_000), posted: BigInt(2_000_000) }
    const prepared = await venue(state).prepare(takeOut(), ACCOUNT)
    expect(evmSigning(prepared.signing).data).toBe(withdraw())
  })

  it('says what is there when asked for more', async () => {
    const state = { shares: BigInt(1_000_000) }
    await expect(venue(state).prepare(takeOut(), ACCOUNT)).rejects.toThrow(/1\.04 USDC/)
  })

  it('says what the market has free when it has too little', async () => {
    const state = { held: BigInt(4_000_000) }
    await expect(venue(state).prepare(takeOut(), ACCOUNT)).rejects.toThrow(/4 USDC/)
  })

  it.each<[string, ChainActionRequest, Partial<ChainState>]>([
    ['another token', takeOut('5', 'USDT0'), {}],
    ['a zero amount', takeOut('0'), {}],
    ['no position', takeOut(), { shares: BigInt(0) }],
    ['a market with withdrawals paused', takeOut(), { redeemPaused: 2 }],
    ['an unknown pause flag', takeOut(), { redeemPaused: 0 }],
    ['a token no longer listed', takeOut(), { listed: false }],
    ['an unreadable hold', takeOut(), { readFails: 'accountAssets' }],
    ['unreadable collateral', takeOut(), { readFails: 'collateralPosted' }],
    ['a call that would fail', takeOut(), { callFails: true }],
  ])('refuses %s', async (_label, request, state) => {
    await expect(venue(state).prepare(request, ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })

  it('refuses the kinds it does not offer', async () => {
    const borrow: ChainActionRequest = { kind: 'borrow', amount: '5', tokenIn: 'USDC' }
    await expect(venue().prepare(borrow, ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })
})

describe('exits', () => {
  const whole: ChainActionRequest = { ...takeOut(), wholePosition: true }

  it('shows everything here at the live rate, posted collateral included', async () => {
    const state = { shares: BigInt(10_000_000), posted: BigInt(8_000_000) }
    await expect(venue(state).positions?.(ACCOUNT)).resolves.toEqual([
      { slot: 'supplied', symbol: 'USDC', amount: '10.4' },
    ])
  })

  it('shows nothing with no shares', async () => {
    await expect(venue({ shares: BigInt(0) }).positions?.(ACCOUNT)).resolves.toEqual([])
  })

  it.each(['balanceOf', 'exchangeRateUpdated'])(
    'throws when %s can not be read, rather than saying nothing is there',
    async (readFails) => {
      await expect(venue({ readFails }).positions?.(ACCOUNT)).rejects.toThrow()
    }
  )

  it('redeems every share for all of it, to and from the person', async () => {
    const safe = venue()
    const prepared = await safe.prepare(whole, ACCOUNT)
    const signing = evmSigning(prepared.signing)
    expect(signing.data).toBe(redeem(BigInt(50_000_000)))
    expect(signing.approval).toBeUndefined()
    expect(prepared.pay).toEqual({ amount: '52', symbol: 'USDC' })
    expect(() => safe.assertSafe(signing, ACCOUNT)).not.toThrow()
  })

  it('does not mistake interest since the figure was read for asking too much', async () => {
    const prepared = await venue().prepare({ ...whole, amount: '52.000001' }, ACCOUNT)
    expect(evmSigning(prepared.signing).data).toBe(redeem(BigInt(50_000_000)))
  })

  it.each<[string, Partial<ChainState>, RegExp]>([
    ['nothing there', { shares: BigInt(0) }, /no USDC lent/],
    ['withdrawals paused', { redeemPaused: 2 }, /paused.*still yours/],
    ['a hold running', { cooldown: NOW }, /holding this account/],
    [
      'collateral posted',
      { shares: BigInt(10_000_000), posted: BigInt(8_000_000) },
      /2.08 USDC of yours.*remove the collateral/,
    ],
    ['too little free', { held: BigInt(4_000_000) }, /only 4 USDC free/],
    ['a call that would fail', { callFails: true }, /still yours/],
  ])('refuses all of it with %s', async (_label, state, words) => {
    const asked = venue(state).prepare(whole, ACCOUNT)
    await expect(asked).rejects.toThrow(ChainActionRefused)
    await expect(asked).rejects.toThrow(words)
    await expect(asked).rejects.toThrow(/Nothing was signed or sent\.$/)
  })
})

function fakeClient(receipt: Partial<EvmReceipt>, input: string = deposit()): EvmClient {
  return {
    tokenBalance: async () => BigInt(0),
    nativeBalance: async () => BigInt(0),
    allowance: async () => BigInt(0),
    code: async () => undefined,
    waitForReceipt: async () =>
      ({
        status: 'success',
        from: ACCOUNT,
        to: CURVANCE_CUSDC,
        logs: [],
        ...receipt,
      }) as EvmReceipt,
    transaction: async () => ({ input, value: BigInt(0) }),
  }
}

describe('submit', () => {
  const signed = {
    account: ACCOUNT,
    venueId: 'curvance',
    signed: { family: 'evm' as const, hash: HASH },
  }

  function submitWith(client: EvmClient) {
    return createCurvanceVenue(() => fakeReader(), client).submit?.(signed)
  }

  it('settles a landed deposit from the person', async () => {
    await expect(submitWith(fakeClient({}))).resolves.toMatchObject({ ok: true, hash: HASH })
  })

  it.each<[string, EvmClient]>([
    ['another signer', fakeClient({ from: STRANGER })],
    ['another market', fakeClient({ to: OTHER_MARKET })],
    ['a withdrawal paid to someone else', fakeClient({}, withdraw(BigInt(5), STRANGER))],
  ])('stays pending for %s', async (_label, client) => {
    await expect(submitWith(client)).resolves.toMatchObject({ ok: false, pending: true })
  })
})
