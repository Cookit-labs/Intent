import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  maxUint256,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'

import type { EvmReaderClient } from '../chains/evm/call'
import type { EvmClient, EvmReceipt } from '../chains/evm/client'
import {
  assertStreamAsAsked,
  createSablierVenue,
  SABLIER_COMPTROLLER,
  SABLIER_LOCKUP,
  SABLIER_LOCKUP_ABI,
  sablierAvalancheVenue,
  sablierMonadVenue,
} from '../chains/evm/sablier'
import { sablierVenues } from '../chains/evm/sablier-listing'
import { ChainActionRefused, type ChainActionRequest, type SigningPayload } from '../chains/types'

const ME = getAddress('0x1111111111111111111111111111111111111111')
const THEM = getAddress('0x2222222222222222222222222222222222222222')
const STRANGER = getAddress('0x3333333333333333333333333333333333333333')
const LOCKUP = SABLIER_LOCKUP.avalanche as Address
const USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' as Address
const USDT = '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7' as Address
const MONAD_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address
const AVALANCHE_ID = 43114
const MONAD_ID = 143
const DAY = 86_400
const FIVE_HUNDRED = BigInt(500_000_000)

const REQUEST: ChainActionRequest = {
  kind: 'stream',
  amount: '500',
  tokenIn: 'USDC',
  recipient: THEM,
  durationDays: '30',
}

interface StreamArgs {
  sender: Address
  recipient: Address
  depositAmount: bigint
  token: Address
  cancelable: boolean
  transferable: boolean
  shape: string
  start: bigint
  cliffUnlock: bigint
  granularity: number
  cliff: number
  total: number
}

const GOOD: StreamArgs = {
  sender: ME,
  recipient: THEM,
  depositAmount: FIVE_HUNDRED,
  token: USDC,
  cancelable: true,
  transferable: false,
  shape: 'linear',
  start: BigInt(0),
  cliffUnlock: BigInt(0),
  granularity: 1,
  cliff: 0,
  total: 30 * DAY,
}

function create(overrides: Partial<StreamArgs> = {}): Hex {
  const a = { ...GOOD, ...overrides }
  return encodeFunctionData({
    abi: SABLIER_LOCKUP_ABI,
    functionName: 'createWithDurationsLL',
    args: [
      {
        sender: a.sender,
        recipient: a.recipient,
        depositAmount: a.depositAmount,
        token: a.token,
        cancelable: a.cancelable,
        transferable: a.transferable,
        shape: a.shape,
      },
      { start: a.start, cliff: a.cliffUnlock },
      a.granularity,
      { cliff: a.cliff, total: a.total },
    ],
  })
}

function approve(spender: Address = LOCKUP, units: bigint = FIVE_HUNDRED): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, units] })
}

function payload(
  overrides: Partial<Extract<SigningPayload, { family: 'evm' }>> = {}
): Extract<SigningPayload, { family: 'evm' }> {
  return {
    family: 'evm',
    chainId: AVALANCHE_ID,
    to: LOCKUP,
    data: create(),
    value: '0',
    ...overrides,
  }
}

interface FakeOptions {
  allowance?: bigint
  callFails?: boolean
  feeFails?: boolean
  feeWei?: bigint
  comptroller?: string
}

function fakeReader(options: FakeOptions = {}) {
  const calls: { to: string; data: string }[] = []
  const reader = {
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'allowance':
          return options.allowance ?? BigInt(0)
        case 'comptroller':
          if (options.feeFails === true) throw new Error('rpc down')
          return options.comptroller ?? SABLIER_COMPTROLLER
        case 'calculateMinFeeWeiFor':
          if (options.feeFails === true) throw new Error('rpc down')
          return options.feeWei ?? BigInt('98770000000000000')
        case 'getMinFeeUSDFor':
          return BigInt(99_000_000)
        case 'MAX_FEE_USD':
          return BigInt(10_000_000_000)
        default:
          throw new Error(`unexpected read ${functionName}`)
      }
    },
    call: async (args: { to: string; data: string }) => {
      calls.push(args)
      if (options.callFails === true) throw new Error('reverted')
      return { data: '0x' }
    },
  } as unknown as EvmReaderClient
  return { reader, calls }
}

function venueWith(options: FakeOptions = {}) {
  const fake = fakeReader(options)
  return { venue: createSablierVenue('avalanche', fake.reader), calls: fake.calls }
}

interface FakeStream {
  sender?: Address
  status?: number
  cancelable?: boolean
  refundable?: bigint
  withdrawable?: bigint
  token?: Address
  recipient?: Address
}

const LIVE: Required<FakeStream> = {
  sender: ME,
  status: 1,
  cancelable: true,
  refundable: BigInt(300_000_000),
  withdrawable: BigInt(200_000_000),
  token: USDC,
  recipient: THEM,
}

/** Stream ids run from 1, as they do on the chain. */
function streamReader(
  streams: FakeStream[],
  options: { callFails?: boolean; readFails?: string; nextOverride?: bigint } = {}
) {
  const calls: { to: string; data: string; value?: bigint }[] = []
  const readContract = async ({
    functionName,
    args,
  }: {
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown> => {
    if (options.readFails === functionName) throw new Error('rpc down')
    if (functionName === 'nextStreamId') {
      return options.nextOverride ?? BigInt(streams.length + 1)
    }
    const stream = { ...LIVE, ...streams[Number(args?.[0]) - 1] }
    switch (functionName) {
      case 'getSender':
        return stream.sender
      case 'statusOf':
        return stream.status
      case 'isCancelable':
        return stream.cancelable
      case 'refundableAmountOf':
        return stream.refundable
      case 'withdrawableAmountOf':
        return stream.withdrawable
      case 'getUnderlyingToken':
        return stream.token
      case 'getRecipient':
        return stream.recipient
      default:
        throw new Error(`unexpected read ${functionName}`)
    }
  }
  const reader = {
    readContract,
    multicall: async ({ contracts }: { contracts: { functionName: string }[] }) =>
      Promise.all(contracts.map(readContract)),
    call: async (args: { to: string; data: string }) => {
      calls.push(args)
      if (options.callFails === true) throw new Error('reverted')
      return { data: '0x' }
    },
  } as unknown as EvmReaderClient
  return { venue: createSablierVenue('avalanche', reader), calls }
}

function cancelData(streamId: bigint = BigInt(1)): Hex {
  return encodeFunctionData({ abi: SABLIER_LOCKUP_ABI, functionName: 'cancel', args: [streamId] })
}

const CANCEL: ChainActionRequest = {
  kind: 'cancel',
  amount: 'all',
  tokenIn: 'STREAM',
  streamId: '1',
}

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (e) {
    expect(e).toBeInstanceOf(ChainActionRefused)
    return (e as Error).message
  }
  throw new Error('expected a refusal')
}

async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (e) {
    expect(e).toBeInstanceOf(ChainActionRefused)
    return (e as Error).message
  }
  throw new Error('expected a refusal')
}

describe('the pinned call', () => {
  it('encodes the selector of Lockup v4.0 createWithDurationsLL', () => {
    expect(create().slice(0, 10)).toBe('0x7b4dae9e')
  })

  it('has no broker argument anywhere, since v3.0 removed it', () => {
    expect(JSON.stringify(SABLIER_LOCKUP_ABI)).not.toMatch(/broker/i)
  })

  it('funds the stream from the two chains’ own Lockup contracts', () => {
    expect(SABLIER_LOCKUP.avalanche).toBe('0xB891b41533776Ec20f7738c647a11506AA44b8A8')
    expect(SABLIER_LOCKUP.monad).toBe('0x82723C1ffEc9D43dE5FA80b25Da8df99AfD470ba')
  })
})

describe('assertSafe', () => {
  const venue = sablierAvalancheVenue

  it('passes the stream as this venue builds it', () => {
    expect(() => venue.assertSafe(payload(), ME)).not.toThrow()
  })

  it('passes it with an exact approval to the Lockup contract', () => {
    const signing = payload({ approval: { to: USDC, data: approve() } })
    expect(() => venue.assertSafe(signing, ME)).not.toThrow()
  })

  it('passes a USDT stream with its own approval', () => {
    const signing = payload({
      data: create({ token: USDT }),
      approval: { to: USDT, data: approve() },
    })
    expect(() => venue.assertSafe(signing, ME)).not.toThrow()
  })

  it.each<[string, SigningPayload]>([
    ['another family', { family: 'sui', transaction: 'AA==' }],
    ['another chain', payload({ chainId: MONAD_ID })],
    ['an unknown contract', payload({ to: STRANGER })],
    ['the other chain’s Lockup', payload({ to: SABLIER_LOCKUP.monad as string })],
    ['native coin as value', payload({ value: '1' })],
    ['a value that is not a number', payload({ value: 'abc' })],
    ['extra calldata', payload({ data: `${create()}00` })],
    ['a stream from someone else as sender', payload({ data: create({ sender: STRANGER }) })],
    ['the person streaming to themselves', payload({ data: create({ recipient: ME }) })],
    ['the zero address as recipient', payload({ data: create({ recipient: zeroAddress }) })],
    ['the Lockup contract as recipient', payload({ data: create({ recipient: LOCKUP }) })],
    ['a token contract as recipient', payload({ data: create({ recipient: USDC }) })],
    ['a token this venue does not stream', payload({ data: create({ token: STRANGER }) })],
    ['a Monad token on Avalanche', payload({ data: create({ token: MONAD_USDC }) })],
    ['a stream that cannot be canceled', payload({ data: create({ cancelable: false }) })],
    ['a stream that can be moved', payload({ data: create({ transferable: true }) })],
    ['a stream paying out at its start', payload({ data: create({ start: BigInt(1) }) })],
    ['a stream paying out at a cliff', payload({ data: create({ cliffUnlock: BigInt(1) }) })],
    ['a cliff', payload({ data: create({ cliff: DAY }) })],
    ['a coarser unlock step', payload({ data: create({ granularity: DAY }) })],
    ['another shape', payload({ data: create({ shape: 'x'.repeat(8) }) })],
    ['a length of zero', payload({ data: create({ total: 0 }) })],
    ['a length that is not whole days', payload({ data: create({ total: DAY + 1 }) })],
    ['a length past what can be typed', payload({ data: create({ total: 100_000 * DAY }) })],
  ])('refuses %s', (_name, signing) => {
    expect(refusal(() => venue.assertSafe(signing, ME))).toMatch(/Nothing was signed or sent\.$/)
  })

  it('refuses the wrong signer', () => {
    expect(refusal(() => venue.assertSafe(payload(), STRANGER))).toMatch(/your wallet/)
  })

  it.each([
    [
      'withdraw',
      encodeFunctionData({
        abi: parseAbi(['function withdraw(uint256 streamId, address to, uint128 amount)']),
        functionName: 'withdraw',
        args: [BigInt(1), STRANGER, BigInt(1)],
      }),
    ],
    [
      'createWithTimestampsLL',
      encodeFunctionData({
        abi: parseAbi([
          'struct T { uint40 start; uint40 end; }',
          'struct P { address a; address b; uint128 c; address d; bool e; bool f; T g; string h; }',
          'function createWithTimestampsLL(P p, (uint128,uint128) u, uint40 g, uint40 c)',
        ]),
        functionName: 'createWithTimestampsLL',
        args: [
          {
            a: ME,
            b: THEM,
            c: FIVE_HUNDRED,
            d: USDC,
            e: true,
            f: false,
            g: { start: 1, end: 2 },
            h: 'linear',
          },
          [BigInt(0), BigInt(0)],
          1,
          0,
        ],
      }),
    ],
    [
      'the v2 form that paid a broker',
      encodeFunctionData({
        abi: parseAbi([
          'struct B { address account; uint256 fee; }',
          'struct P { address a; address b; uint128 c; address d; bool e; bool f; B broker; }',
          'function createWithDurationsLL(P p, (uint128,uint128) u, (uint40,uint40) d)',
        ]),
        functionName: 'createWithDurationsLL',
        args: [
          {
            a: ME,
            b: THEM,
            c: FIVE_HUNDRED,
            d: USDC,
            e: true,
            f: false,
            broker: { account: STRANGER, fee: BigInt(1) },
          },
          [BigInt(0), BigInt(0)],
          [0, DAY],
        ],
      }),
    ],
  ])('refuses the function %s', (_name, data) => {
    expect(toFunctionSelector(SABLIER_LOCKUP_ABI[0])).not.toBe(data.slice(0, 10))
    expect(refusal(() => venue.assertSafe(payload({ data }), ME))).toMatch(/haven't confirmed/)
  })

  it('refuses an approval to someone else', () => {
    const signing = payload({ approval: { to: USDC, data: approve(STRANGER) } })
    expect(refusal(() => venue.assertSafe(signing, ME))).toMatch(/isn't confirmed/)
  })

  it('refuses an unlimited approval', () => {
    const signing = payload({ approval: { to: USDC, data: approve(LOCKUP, maxUint256) } })
    expect(refusal(() => venue.assertSafe(signing, ME))).toMatch(/unlimited/)
  })

  it('refuses an approval larger than the amount', () => {
    const signing = payload({
      approval: { to: USDC, data: approve(LOCKUP, FIVE_HUNDRED + BigInt(1)) },
    })
    expect(refusal(() => venue.assertSafe(signing, ME))).toMatch(/exactly/)
  })

  it('refuses an approval smaller than the amount', () => {
    const signing = payload({
      approval: { to: USDC, data: approve(LOCKUP, FIVE_HUNDRED - BigInt(1)) },
    })
    expect(refusal(() => venue.assertSafe(signing, ME))).toMatch(/exactly/)
  })

  it('refuses an approval of a different token than the stream’s', () => {
    const signing = payload({ approval: { to: USDT, data: approve() } })
    expect(refusal(() => venue.assertSafe(signing, ME))).toMatch(/different token/)
  })

  it('refuses an approval of a token it does not know', () => {
    const signing = payload({ approval: { to: STRANGER, data: approve() } })
    expect(refusal(() => venue.assertSafe(signing, ME))).toMatch(/haven't confirmed/)
  })
})

describe('assertStreamAsAsked', () => {
  const asked = (signing: SigningPayload, request: ChainActionRequest = REQUEST) =>
    assertStreamAsAsked(signing, request, ME, 'avalanche')

  it('passes a stream that is what was typed', () => {
    expect(() => asked(payload())).not.toThrow()
  })

  it('reads a typed address in any case as the same address', () => {
    const request = { ...REQUEST, recipient: THEM.toLowerCase() }
    expect(() => asked(payload(), request)).not.toThrow()
  })

  it.each<[string, Partial<StreamArgs>, RegExp]>([
    ['another recipient', { recipient: STRANGER }, /address you typed/],
    ['a shorter length', { total: 29 * DAY }, /days/],
    ['another amount', { depositAmount: FIVE_HUNDRED - BigInt(1) }, /amount/],
    ['another token', { token: USDT }, /token/],
    ['another sender', { sender: STRANGER }, /your wallet/],
  ])('refuses %s', (_name, overrides, reason) => {
    const message = refusal(() => asked(payload({ data: create(overrides) })))
    expect(message).toMatch(reason)
    expect(message).toMatch(/Nothing was signed or sent\.$/)
  })

  it('refuses something that is not an EVM call', () => {
    expect(refusal(() => asked({ family: 'sui', transaction: 'AA==' }))).toMatch(/not/)
  })
})

describe('prepare', () => {
  it('builds exactly the stream that was typed, approving first when it must', async () => {
    const { venue } = venueWith()
    const prepared = await venue.prepare(REQUEST, ME)
    expect(prepared.venueId).toBe('sablier-avalanche')
    expect(prepared.kind).toBe('stream')
    expect(prepared.pay).toEqual({ amount: '500', symbol: 'USDC' })
    expect(prepared.summary).toContain(THEM)
    expect(prepared.summary).toContain('30 days')
    expect(prepared.signing).toEqual({
      family: 'evm',
      chainId: AVALANCHE_ID,
      to: LOCKUP,
      data: create(),
      value: '0',
      approval: { to: USDC, data: approve() },
    })
    expect(prepared.notes.some((note) => note.includes('asks twice'))).toBe(true)
  })

  it('tries the call when no approval is needed, and asks only once', async () => {
    const { venue, calls } = venueWith({ allowance: FIVE_HUNDRED })
    const prepared = await venue.prepare(REQUEST, ME)
    const signing = prepared.signing as Extract<SigningPayload, { family: 'evm' }>
    expect(signing.approval).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(prepared.notes.some((note) => note.includes('asks twice'))).toBe(false)
  })

  it('refuses a stream that would fail on the chain', async () => {
    const { venue } = venueWith({ allowance: FIVE_HUNDRED, callFails: true })
    expect(await refusalOf(() => venue.prepare(REQUEST, ME))).toMatch(/would fail/)
  })

  it('passes its own assertSafe', async () => {
    const { venue } = venueWith()
    const prepared = await venue.prepare(REQUEST, ME)
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('builds for Monad against Monad’s contract and token', async () => {
    const { reader } = fakeReader()
    const prepared = await createSablierVenue('monad', reader).prepare(REQUEST, ME)
    const signing = prepared.signing as Extract<SigningPayload, { family: 'evm' }>
    expect(prepared.venueId).toBe('sablier-monad')
    expect(signing.chainId).toBe(MONAD_ID)
    expect(signing.to).toBe(SABLIER_LOCKUP.monad)
    expect(signing.approval?.to).toBe(MONAD_USDC)
    expect(prepared.notes.join(' ')).toContain('MON')
  })

  it.each<[string, Partial<ChainActionRequest>, RegExp]>([
    ['another kind', { kind: 'send' }, /only streams/],
    ['the native coin', { tokenIn: 'AVAX' }, /USDC or USDT/],
    ['a token it does not stream', { tokenIn: 'DOGE' }, /USDC or USDT/],
    ['a token named with another chain’s symbol', { tokenIn: 'USDT0' }, /USDC or USDT/],
    ['no recipient', { recipient: undefined }, /address/],
    ['a bad checksum', { recipient: '0xb891b41533776Ec20f7738c647a11506AA44b8A8' }, /address/],
    ['the zero address', { recipient: zeroAddress }, /address/],
    ['a token as the recipient', { recipient: USDC }, /address/],
    ['the Lockup as the recipient', { recipient: LOCKUP }, /Sablier/],
    ['the fee contract as the recipient', { recipient: SABLIER_COMPTROLLER }, /Sablier/],
    ['the person themselves', { recipient: ME }, /your own/],
    ['no length', { durationDays: undefined }, /days/],
    ['a length of zero', { durationDays: '0' }, /days/],
    ['a part of a day', { durationDays: '1.5' }, /days/],
    ['too long a length', { durationDays: '100000' }, /days/],
    ['an amount of zero', { amount: '0' }, /more than zero/],
    ['too many decimals', { amount: '1.0000001' }, /decimal/],
    ['an amount past what a stream holds', { amount: '9'.repeat(39) }, /too large/],
  ])('refuses %s', async (_name, overrides, reason) => {
    const { venue, calls } = venueWith()
    const message = await refusalOf(() => venue.prepare({ ...REQUEST, ...overrides }, ME))
    expect(message).toMatch(reason)
    expect(calls).toHaveLength(0)
  })

  it('refuses a malformed account', async () => {
    const { venue } = venueWith()
    expect(await refusalOf(() => venue.prepare(REQUEST, 'not-an-address'))).toMatch(/wallet/)
  })

  it('refuses when Lockup points at a fee contract nobody checked', async () => {
    const { venue } = venueWith({ comptroller: STRANGER })
    expect(await refusalOf(() => venue.prepare(REQUEST, ME))).toMatch(/fee contract/)
  })
})

describe('what the card says', () => {
  async function notes(options: FakeOptions = {}): Promise<string> {
    const { venue } = venueWith(options)
    return (await venue.prepare(REQUEST, ME)).notes.join('\n')
  }

  it('says the stream is cancelable, what that does, and how', async () => {
    const text = await notes()
    expect(text).toMatch(/You can cancel/)
    expect(text).toContain('not yet streamed comes back')
    expect(text).toMatch(/asking here to cancel the stream by its number/)
    expect(text).toContain('app.sablier.com')
  })

  it('says the recipient must withdraw what has streamed', async () => {
    expect(await notes()).toMatch(new RegExp(`${THEM} has to withdraw`))
  })

  it('shows the withdrawal fee read from the chain', async () => {
    const text = await notes()
    expect(text).toContain('0.09877 AVAX')
    expect(text).toContain('0.99 dollars')
    expect(text).toContain('100 dollars')
  })

  it('says so plainly when the fee reads as zero', async () => {
    const text = await notes({ feeWei: BigInt(0) })
    expect(text).toContain('reads as zero right now')
    expect(text).toContain('its own site charges 0.99 dollars')
  })

  it('does not count the site’s charge on top of a fee the contract asks for', async () => {
    expect(await notes()).not.toContain('its own site charges')
  })

  it('shows no figure when the fee cannot be read', async () => {
    const text = await notes({ feeFails: true })
    expect(text).toContain("couldn't read Sablier's withdrawal fee")
    expect(text).not.toMatch(/\d AVAX/)
  })

  it('says creating it pays no one else', async () => {
    expect(await notes()).toMatch(/no fee to create/)
  })

  it('names the ended bug bounty', async () => {
    expect(await notes()).toContain('bug bounty ended on May 1, 2026')
  })

  it('names who can change what', async () => {
    const text = await notes()
    expect(text).toContain("can't be upgraded")
    expect(text).toContain('no waiting period')
    expect(text).toContain('A single key')
  })

  it('has no em dash', async () => {
    expect(await notes()).not.toContain('—')
  })
})

describe('submit', () => {
  const HASH = `0x${'a'.repeat(64)}`

  function client(receipt: Partial<EvmReceipt>, data: string = create()): EvmClient {
    return {
      tokenBalance: async () => BigInt(0),
      nativeBalance: async () => BigInt(0),
      allowance: async () => BigInt(0),
      code: async () => undefined,
      waitForReceipt: async () =>
        ({ status: 'success', from: ME, to: LOCKUP, logs: [], ...receipt }) as EvmReceipt,
      transaction: async () => ({ value: BigInt(0), input: data }),
    }
  }

  function submit(fake: EvmClient) {
    const { reader } = fakeReader()
    return createSablierVenue('avalanche', reader, fake).submit?.({
      account: ME,
      venueId: 'sablier-avalanche',
      signed: { family: 'evm', hash: HASH },
    })
  }

  it('confirms what the chain says was sent, with no stream id needed', async () => {
    const result = await submit(client({}))
    expect(result).toMatchObject({ ok: true, hash: HASH })
  })

  it('reports a revert of the real transaction as nothing moved', async () => {
    const result = await submit(client({ status: 'reverted' }))
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
  })

  it('does not vouch for a transaction that streams from someone else', async () => {
    const result = await submit(client({}, create({ sender: STRANGER })))
    expect(result).toMatchObject({ ok: false, pending: true })
  })

  it('does not vouch for a transaction from another wallet', async () => {
    const result = await submit(client({ from: STRANGER }))
    expect(result).toMatchObject({ ok: false, pending: true })
  })
})

describe('ending a stream', () => {
  it('builds a cancel from the sender, with nothing else in it', async () => {
    const { venue, calls } = streamReader([{}])
    const prepared = await venue.prepare(CANCEL, ME)
    expect(prepared).toMatchObject({
      kind: 'cancel',
      pay: { amount: '300', symbol: 'USDC' },
      receive: { amount: '300', symbol: 'USDC', approximate: true },
      signing: { family: 'evm', to: LOCKUP, data: cancelData(), value: '0' },
    })
    expect(prepared.signing).not.toHaveProperty('approval')
    expect(calls).toHaveLength(1)
    expect(() => venue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('says where the money goes, what the recipient keeps, and that there is no fee', async () => {
    const { venue } = streamReader([{}])
    const { notes, summary } = await venue.prepare(CANCEL, ME)
    const text = notes.join(' ')
    expect(summary).toContain(THEM)
    expect(text).toMatch(/comes back to your wallet in this same transaction/)
    expect(text).toMatch(new RegExp(`${THEM} keeps what has already streamed`))
    expect(text).toContain('About 200 USDC')
    expect(text).toMatch(/asks no fee to cancel/)
  })

  it.each<[string, FakeStream[], string, RegExp]>([
    ['someone else’s stream', [{ sender: STRANGER }], '1', /wasn't started by this wallet/],
    ['a stream already canceled', [{ status: 3 }], '1', /already canceled/],
    ['a stream that has run its course', [{ status: 2 }], '1', /finished streaming/],
    ['a stream fully paid out', [{ status: 4 }], '1', /finished streaming/],
    ['a stream that can’t be canceled', [{ cancelable: false }], '1', /can't be canceled/],
    ['a stream with nothing left', [{ refundable: BigInt(0) }], '1', /nothing left to get back/],
    [
      'a token nobody confirmed, which proves nothing about who started it',
      [{ token: STRANGER }],
      '1',
      /a token I haven't confirmed/,
    ],
    ['a stream that does not exist', [{}], '2', /There is no stream 2/],
    ['a stream id of nothing', [{}], '0', /isn't a stream number/],
    ['a stream id that is not a number', [{}], 'AbC123', /isn't a stream number/],
  ])('refuses %s', async (_label, streams, streamId, words) => {
    const { venue } = streamReader(streams)
    const asked = venue.prepare({ ...CANCEL, streamId }, ME)
    await expect(asked).rejects.toThrow(ChainActionRefused)
    await expect(asked).rejects.toThrow(words)
    await expect(asked).rejects.toThrow(/Nothing was signed or sent\.$/)
  })

  it('refuses with no stream id at all', async () => {
    const { venue } = streamReader([{}])
    const { streamId: _none, ...noId } = CANCEL
    await expect(venue.prepare(noId, ME)).rejects.toThrow(/isn't a stream number/)
  })

  it('refuses when the stream can not be read, or would fail', async () => {
    await expect(
      streamReader([{}], { readFails: 'getSender' }).venue.prepare(CANCEL, ME)
    ).rejects.toThrow(/couldn't read stream 1/)
    await expect(streamReader([{}], { callFails: true }).venue.prepare(CANCEL, ME)).rejects.toThrow(
      /keeps running as it was/
    )
  })

  it('still builds when only the recipient can not be read', async () => {
    const { venue } = streamReader([{}], { readFails: 'getRecipient' })
    const { summary } = await venue.prepare(CANCEL, ME)
    expect(summary).toContain('the person being paid')
  })

  it('assertSafe passes the cancel and nothing wider', () => {
    const { venue } = streamReader([{}])
    expect(() => venue.assertSafe(payload({ data: cancelData() }), ME)).not.toThrow()
    expect(() => venue.assertSafe(payload({ data: cancelData(BigInt(0)) }), ME)).toThrow(
      ChainActionRefused
    )
    expect(() => venue.assertSafe(payload({ data: `${cancelData()}00` as Hex }), ME)).toThrow(
      ChainActionRefused
    )
    expect(() => venue.assertSafe(payload({ data: cancelData(), value: '1' }), ME)).toThrow(
      ChainActionRefused
    )
    expect(() => venue.assertSafe(payload({ data: cancelData(), to: STRANGER }), ME)).toThrow(
      ChainActionRefused
    )
    expect(() =>
      venue.assertSafe(payload({ data: cancelData(), approval: { to: USDC, data: approve() } }), ME)
    ).toThrow(ChainActionRefused)
  })
})

describe('streams this wallet started', () => {
  it('lists what each can still bring back, with its id', async () => {
    const { venue } = streamReader([
      {},
      { sender: STRANGER },
      { token: USDT, refundable: BigInt(1_500_000) },
    ])
    await expect(venue.positions?.(ME)).resolves.toEqual([
      { slot: 'supplied', symbol: 'USDC', amount: '300', id: '1' },
      { slot: 'supplied', symbol: 'USDT', amount: '1.5', id: '3' },
    ])
  })

  it('leaves out ended streams, and a token anyone could have named this wallet on', async () => {
    const { venue } = streamReader([
      { status: 3, cancelable: false, refundable: BigInt(0) },
      { status: 4, cancelable: false, refundable: BigInt(0) },
      { token: STRANGER },
    ])
    await expect(venue.positions?.(ME)).resolves.toEqual([])
  })

  it('finds a stream past the first page of reads', async () => {
    const streams: FakeStream[] = Array.from({ length: 501 }, () => ({ sender: STRANGER }))
    streams[500] = {}
    const { venue } = streamReader(streams)
    await expect(venue.positions?.(ME)).resolves.toEqual([
      { slot: 'supplied', symbol: 'USDC', amount: '300', id: '501' },
    ])
  })

  it.each(['nextStreamId', 'getSender', 'refundableAmountOf'])(
    'throws when %s can not be read, rather than saying there are none',
    async (readFails) => {
      await expect(streamReader([{}], { readFails }).venue.positions?.(ME)).rejects.toThrow()
    }
  )

  it('throws rather than read only some of too many streams', async () => {
    const { venue } = streamReader([], { nextOverride: BigInt(5_001) })
    await expect(venue.positions?.(ME)).rejects.toThrow(/Too many/)
  })

  it('reads only ids that exist, starting from 1', async () => {
    await expect(streamReader([]).venue.positions?.(ME)).resolves.toEqual([])
  })
})

describe('the venues and their listing', () => {
  it('offers streams and ending them, and joins no race', () => {
    for (const venue of [sablierAvalancheVenue, sablierMonadVenue]) {
      expect(venue.kinds).toEqual(['stream', 'cancel'])
      expect(venue.quote).toBeUndefined()
    }
  })

  it('lists one executing entry per chain, each with its own logo', () => {
    expect(sablierVenues.map((v) => [v.id, v.family, v.chains, v.integration])).toEqual([
      ['sablier-avalanche', 'evm', ['Avalanche'], 'executes'],
      ['sablier-monad', 'evm', ['Monad'], 'executes'],
    ])
    for (const venue of sablierVenues) {
      expect(venue.capability).toBeTruthy()
      expect(
        existsSync(join(process.cwd(), 'public', 'images', 'venues', `${venue.id}.webp`))
      ).toBe(true)
    }
  })
})
