import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, type Address } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { EvmReaderClient } from '../chains/evm/call'
import type { EvmClient, EvmReceipt } from '../chains/evm/client'
import { createFastlaneVenue, FASTLANE_TOKENS, SHMON, shmonPriceUsd } from '../chains/evm/fastlane'
import { EVM_CHAINS } from '../chains/evm/tokens'
import { ChainActionRefused, type ChainActionRequest, type SigningPayload } from '../chains/types'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const STRANGER = '0x2222222222222222222222222222222222222222' as Address
const OTHER_CONTRACT = '0x4444444444444444444444444444444444444444'
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'
const HASH = `0x${'a'.repeat(64)}`
const MONAD_ID = EVM_CHAINS.monad.chain.id

const E18 = BigInt(10) ** BigInt(18)
const ONE = E18
const TWO = BigInt(2) * E18

const ABI = parseAbi([
  'function deposit(uint256 assets, address receiver) payable returns (uint256)',
  'function redeemWithSlippageProtection(uint256 shares, address receiver, address owner, uint256 minAssetsOut) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
  'function mint(uint256 shares, address receiver) payable returns (uint256)',
  'function requestUnstake(uint256 shares) returns (uint64)',
  'function completeUnstake()',
  'function boostYield(uint256 shares, address from, address yieldOriginator)',
])

function deposit(receiver: Address = ACCOUNT, assets = ONE): string {
  return encodeFunctionData({ abi: ABI, functionName: 'deposit', args: [assets, receiver] })
}

function redeem(
  receiver: Address = ACCOUNT,
  owner: Address = ACCOUNT,
  minOut = ONE,
  shares = ONE
): string {
  return encodeFunctionData({
    abi: ABI,
    functionName: 'redeemWithSlippageProtection',
    args: [shares, receiver, owner, minOut],
  })
}

function stakePayload(overrides: Partial<Extract<SigningPayload, { family: 'evm' }>> = {}) {
  return {
    family: 'evm' as const,
    chainId: MONAD_ID,
    to: SHMON,
    data: deposit(),
    value: ONE.toString(),
    ...overrides,
  }
}

function unstakePayload(overrides: Partial<Extract<SigningPayload, { family: 'evm' }>> = {}) {
  return stakePayload({ data: redeem(), value: '0', ...overrides })
}

interface Chain {
  preview?: bigint | Error
  shares?: bigint
  redeemable?: bigint
  fee?: bigint
  net?: bigint
  coin?: bigint | Error
  rate?: bigint | Error
  callFails?: boolean
}

function fakeReader(chain: Chain = {}) {
  const call = vi.fn(async () => {
    if (chain.callFails === true) throw new Error('reverted')
    return { data: '0x' }
  })
  const reader = {
    call,
    getBalance: async () => {
      const coin = chain.coin ?? BigInt(100) * E18
      if (coin instanceof Error) throw coin
      return coin
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'previewDeposit': {
          const preview = chain.preview ?? (BigInt(6) * E18) / BigInt(10)
          if (preview instanceof Error) throw preview
          return preview
        }
        case 'balanceOf':
          return chain.shares ?? TWO
        case 'maxRedeem':
          return chain.redeemable ?? TWO
        case 'previewRedeemDetailed':
          return [
            BigInt(0),
            chain.fee ?? BigInt(5) * BigInt(10) ** BigInt(15),
            chain.net ?? (BigInt(16) * E18) / BigInt(10),
          ]
        case 'previewUnstake': {
          const rate = chain.rate ?? (BigInt(165) * E18) / BigInt(100)
          if (rate instanceof Error) throw rate
          return rate
        }
        default:
          throw new Error(`unexpected read of ${functionName}`)
      }
    },
  } as unknown as EvmReaderClient
  return { reader, call }
}

function fakeClient(
  status: EvmReceipt['status'],
  sent: { input: string; value: bigint }
): EvmClient {
  return {
    tokenBalance: async () => BigInt(0),
    nativeBalance: async () => BigInt(0),
    waitForReceipt: async () =>
      ({ status, from: ACCOUNT, to: SHMON, logs: [] }) as unknown as EvmReceipt,
    transaction: async () => sent,
  }
}

const venueWith = (chain: Chain = {}, client?: EvmClient) =>
  createFastlaneVenue(
    fakeReader(chain).reader,
    client ?? fakeClient('success', { input: deposit(), value: ONE })
  )

const STAKE: ChainActionRequest = { kind: 'stake', amount: '1', tokenIn: 'MON' }
const UNSTAKE: ChainActionRequest = { kind: 'unstake', amount: '1', tokenIn: 'shMON' }

const evm = (payload: SigningPayload) => {
  if (payload.family !== 'evm') throw new Error('Expected an EVM payload.')
  return payload
}

describe('the FastLane policy', () => {
  const venue = venueWith()

  it('passes a stake and an unstake for this person', () => {
    expect(() => venue.assertSafe(stakePayload(), ACCOUNT)).not.toThrow()
    expect(() => venue.assertSafe(unstakePayload(), ACCOUNT)).not.toThrow()
  })

  const call = (functionName: string, args: readonly unknown[]): string =>
    encodeFunctionData({ abi: ABI, functionName, args } as Parameters<typeof encodeFunctionData>[0])

  it.each<[string, SigningPayload]>([
    ['another family', { family: 'sui', transaction: 'AA==' }],
    ['another chain', stakePayload({ chainId: 43114 })],
    ['an unknown contract', stakePayload({ to: OTHER_CONTRACT })],
    [
      'the shMON address on another function: redeem',
      unstakePayload({ data: call('redeem', [ONE, ACCOUNT, ACCOUNT]) }),
    ],
    ['withdraw', unstakePayload({ data: call('withdraw', [ONE, ACCOUNT, ACCOUNT]) })],
    ['mint', stakePayload({ data: call('mint', [ONE, ACCOUNT]) })],
    ['the queue', unstakePayload({ data: call('requestUnstake', [ONE]) })],
    ['a claim', unstakePayload({ data: call('completeUnstake', []) })],
    ['a burn as a donation', unstakePayload({ data: call('boostYield', [ONE, ACCOUNT, ACCOUNT]) })],
    [
      'a shMON transfer',
      unstakePayload({
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [STRANGER, ONE],
        }),
      }),
    ],
    ['calldata that decodes as nothing', stakePayload({ data: '0xdeadbeef' })],
    ['extra calldata on a stake', stakePayload({ data: `${deposit()}00` })],
    ['extra calldata on an unstake', unstakePayload({ data: `${redeem()}00` })],
    ['shMON credited to someone else', stakePayload({ data: deposit(STRANGER) })],
    ['MON paid to someone else', unstakePayload({ data: redeem(STRANGER) })],
    ['shMON burned from someone else', unstakePayload({ data: redeem(ACCOUNT, STRANGER) })],
    ['value below the stake', stakePayload({ value: (ONE - BigInt(1)).toString() })],
    ['value above the stake', stakePayload({ value: (ONE + BigInt(1)).toString() })],
    ['a stake of nothing', stakePayload({ data: deposit(ACCOUNT, BigInt(0)), value: '0' })],
    ['value on an unstake', unstakePayload({ value: '1' })],
    ['an unstake with no minimum', unstakePayload({ data: redeem(ACCOUNT, ACCOUNT, BigInt(0)) })],
    ['a value that is not digits', stakePayload({ value: '0x1' })],
    [
      'an unlimited approval',
      unstakePayload({
        approval: {
          to: USDC,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [SHMON as Address, maxUint256],
          }),
        },
      }),
    ],
    [
      'an approval of the shMON itself',
      unstakePayload({
        approval: {
          to: SHMON,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [SHMON as Address, ONE],
          }),
        },
      }),
    ],
  ])('refuses %s', (_label, payload) => {
    expect(() => venue.assertSafe(payload, ACCOUNT)).toThrow(ChainActionRefused)
  })

  it.each<[string, SigningPayload, RegExp]>([
    ['the shMON', stakePayload({ data: deposit(STRANGER) }), /credits the shMON to someone else/],
    ['the MON', unstakePayload({ data: redeem(STRANGER) }), /pays the MON to someone else/],
    ['the burn', unstakePayload({ data: redeem(ACCOUNT, STRANGER) }), /belongs to someone else/],
    ['the value', stakePayload({ value: '1' }), /different amount of MON/],
    ['the unstake value', unstakePayload({ value: '1' }), /does not spend MON/],
    ['the minimum', unstakePayload({ data: redeem(ACCOUNT, ACCOUNT, BigInt(0)) }), /no minimum/],
    [
      'the function',
      unstakePayload({ data: call('redeem', [ONE, ACCOUNT, ACCOUNT]) }),
      /does something I haven't confirmed/,
    ],
    ['the contract', stakePayload({ to: OTHER_CONTRACT }), /contract I haven't confirmed/],
    ['the extra data', stakePayload({ data: `${deposit()}00` }), /extra data/],
    [
      'the approval',
      unstakePayload({
        approval: {
          to: SHMON,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [SHMON as Address, ONE],
          }),
        },
      }),
      /approve a token I haven't confirmed/,
    ],
  ])('refuses %s for the reason it should', (_label, payload, reason) => {
    expect(() => venue.assertSafe(payload, ACCOUNT)).toThrow(reason)
  })

  it('refuses the wrong account', () => {
    expect(() => venue.assertSafe(stakePayload(), STRANGER)).toThrow(ChainActionRefused)
    expect(() => venue.assertSafe(unstakePayload(), STRANGER)).toThrow(ChainActionRefused)
  })
})

describe('staking', () => {
  it('builds a deposit of exactly the amount, for this person, with no approval', async () => {
    const { reader, call } = fakeReader()
    const venue = createFastlaneVenue(
      reader,
      fakeClient('success', { input: deposit(), value: ONE })
    )
    const prepared = await venue.prepare(STAKE, ACCOUNT)
    const signing = evm(prepared.signing)
    expect(signing.to).toBe(SHMON)
    expect(signing.value).toBe(ONE.toString())
    expect(signing.data).toBe(deposit())
    expect(signing).not.toHaveProperty('approval')
    expect(call).toHaveBeenCalledOnce()
    expect(() => venue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
  })

  it('shows what the preview read, and no rate', async () => {
    const prepared = await venueWith().prepare(STAKE, ACCOUNT)
    expect(prepared.receive).toEqual({ amount: '0.6', symbol: 'shMON', approximate: true })
    expect(prepared.apy).toBeUndefined()
  })

  it('says how the person gets out, and who can change the contract', async () => {
    const { notes } = await venueWith().prepare(STAKE, ACCOUNT)
    const text = notes.join(' ')
    expect(text).toContain('0.005% to 1.005%')
    expect(text).toContain('4 to 5 epochs')
    expect(text).toContain('3-day wait')
    expect(text).toContain('5 of 7')
  })

  it('warns only when the stake would leave under the 10 MON reserve', async () => {
    const reserve = /10 MON reserve/
    const under = await venueWith({ coin: BigInt(10) * E18 }).prepare(STAKE, ACCOUNT)
    expect(under.notes.join(' ')).toMatch(reserve)
    expect(under.notes.join(' ')).toContain('this stake may fail')
    expect(under.notes.join(' ')).not.toContain('this swap')
    const over = await venueWith({ coin: BigInt(11) * E18 }).prepare(STAKE, ACCOUNT)
    expect(over.notes.join(' ')).not.toMatch(reserve)
  })

  it.each<[string, ChainActionRequest, Chain]>([
    ['another token', { ...STAKE, tokenIn: 'USDC' }, {}],
    ['shMON', { ...STAKE, tokenIn: 'shMON' }, {}],
    ['a zero amount', { ...STAKE, amount: '0' }, {}],
    ['too many decimals', { ...STAKE, amount: '0.0000000000000000001' }, {}],
    ['a preview that can not be read', STAKE, { preview: new Error('rpc') }],
    ['a preview of nothing', STAKE, { preview: BigInt(0) }],
    ['a balance that can not be read', STAKE, { coin: new Error('rpc') }],
    ['a balance with no gas left over', STAKE, { coin: ONE }],
    ['a call that would fail', STAKE, { callFails: true }],
  ])('refuses %s', async (_label, request, chain) => {
    await expect(venueWith(chain).prepare(request, ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })

  it('refuses a malformed account', async () => {
    await expect(venueWith().prepare(STAKE, 'nope')).rejects.toThrow(ChainActionRefused)
  })
})

describe('the race quote', () => {
  it('reads the preview and tries nothing', async () => {
    const { reader, call } = fakeReader()
    const venue = createFastlaneVenue(
      reader,
      fakeClient('success', { input: deposit(), value: ONE })
    )
    await expect(venue.quote?.(STAKE, ACCOUNT)).resolves.toEqual({
      receive: { amount: '0.6', symbol: 'shMON' },
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses when no preview can be read, rather than guessing', async () => {
    await expect(venueWith({ preview: new Error('rpc') }).quote?.(STAKE, ACCOUNT)).rejects.toThrow(
      ChainActionRefused
    )
  })
})

describe('unstaking', () => {
  it('builds the atomic exit with a minimum 1% under the preview, paying this person', async () => {
    const venue = venueWith()
    const prepared = await venue.prepare(UNSTAKE, ACCOUNT)
    const signing = evm(prepared.signing)
    const minOut = (BigInt(16) * E18 * BigInt(99)) / BigInt(1000)
    expect(signing.data).toBe(redeem(ACCOUNT, ACCOUNT, minOut))
    expect(signing.value).toBe('0')
    expect(signing).not.toHaveProperty('approval')
    expect(prepared.pay).toEqual({ amount: '1', symbol: 'shMON' })
    expect(prepared.receive).toEqual({ amount: '1.6', symbol: 'MON', approximate: true })
    expect(() => venue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
  })

  it('states the fee it read, the range, and the queue it does not offer', async () => {
    const { notes } = await venueWith().prepare(UNSTAKE, ACCOUNT)
    const text = notes.join(' ')
    expect(text).toContain('about 0.005 MON')
    expect(text).toContain('0.005% to 1.005%')
    expect(text).toContain('requestUnstake')
    expect(text).toContain('does not offer')
  })

  it.each<[string, ChainActionRequest, Chain]>([
    ['MON, which is what comes out', { ...UNSTAKE, tokenIn: 'MON' }, {}],
    ['another token', { ...UNSTAKE, tokenIn: 'USDC' }, {}],
    ['more than the person holds', UNSTAKE, { shares: ONE - BigInt(1) }],
    ['more than the pool can cover', UNSTAKE, { redeemable: ONE - BigInt(1) }],
    ['a preview of nothing', UNSTAKE, { net: BigInt(0) }],
    ['a minimum of nothing', UNSTAKE, { net: BigInt(1) }],
    ['no gas', UNSTAKE, { coin: BigInt(1) }],
    ['a balance that can not be read', UNSTAKE, { coin: new Error('rpc') }],
    ['a call that would fail', UNSTAKE, { callFails: true }],
  ])('refuses %s', async (_label, request, chain) => {
    await expect(venueWith(chain).prepare(request, ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })

  it('names the free queue when the pool falls short', async () => {
    await expect(venueWith({ redeemable: BigInt(0) }).prepare(UNSTAKE, ACCOUNT)).rejects.toThrow(
      /queue with no fee/
    )
  })

  it('has nothing to quote, since an unstake does not race', async () => {
    await expect(venueWith().quote?.(UNSTAKE, ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })
})

describe('after the wallet sends', () => {
  const signed = { family: 'evm' as const, hash: HASH }
  const input = { account: ACCOUNT, venueId: 'fastlane', signed }

  it('settles a landed stake', async () => {
    const venue = venueWith({}, fakeClient('success', { input: deposit(), value: ONE }))
    await expect(venue.submit?.(input)).resolves.toMatchObject({ ok: true, hash: HASH })
  })

  it('names the reserve when a stake reverts', async () => {
    const venue = venueWith({}, fakeClient('reverted', { input: deposit(), value: ONE }))
    const result = await venue.submit?.(input)
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    expect(JSON.stringify(result)).toContain('10 MON reserve')
  })

  it('does not blame the reserve when an unstake reverts', async () => {
    const venue = venueWith({}, fakeClient('reverted', { input: redeem(), value: BigInt(0) }))
    const result = await venue.submit?.(input)
    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).not.toContain('reserve')
  })

  it('stays pending for a transaction that pays someone else', async () => {
    const venue = venueWith(
      {},
      fakeClient('success', { input: redeem(STRANGER), value: BigInt(0) })
    )
    await expect(venue.submit?.(input)).resolves.toMatchObject({ ok: false, pending: true })
  })
})

describe('following a swap', () => {
  it('can stake MON and nothing else', async () => {
    const venue = venueWith()
    await expect(
      venue.assertCanFollow?.({ kind: 'stake', tokenIn: 'MON' }, ACCOUNT)
    ).resolves.toBeUndefined()
    await expect(
      venue.assertCanFollow?.({ kind: 'stake', tokenIn: 'USDC' }, ACCOUNT)
    ).rejects.toThrow(ChainActionRefused)
    await expect(
      venue.assertCanFollow?.({ kind: 'unstake', tokenIn: 'MON' }, ACCOUNT)
    ).rejects.toThrow(ChainActionRefused)
  })
})

describe('shmonPriceUsd', () => {
  it('values a shMON at what the contract says it is worth in MON', async () => {
    await expect(shmonPriceUsd(2, fakeReader().reader)).resolves.toBeCloseTo(3.3)
  })

  it('gives no price when either side can not be read', async () => {
    await expect(shmonPriceUsd(undefined, fakeReader().reader)).resolves.toBeUndefined()
    await expect(
      shmonPriceUsd(2, fakeReader({ rate: new Error('rpc') }).reader)
    ).resolves.toBeUndefined()
  })
})

describe('the shMON token', () => {
  it('is the pinned contract', () => {
    expect(FASTLANE_TOKENS).toEqual([{ symbol: 'shMON', id: SHMON, decimals: 18, name: 'ShMonad' }])
  })
})
