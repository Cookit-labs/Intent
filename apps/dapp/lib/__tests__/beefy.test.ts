import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, zeroAddress, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  BEEFY_MONAD_STRATEGY,
  BEEFY_MONAD_USDC,
  BEEFY_MONAD_VAULT,
  createBeefyMonadVenue,
} from '../chains/evm/beefy'
import { beefyMonadListing } from '../chains/evm/beefy-listing'
import type { EvmReaderClient } from '../chains/evm/call'
import type { EvmClient, EvmReceipt } from '../chains/evm/client'
import { MONAD_TOKENS } from '../chains/evm/tokens'
import { ChainActionRefused, type ChainActionRequest, type SigningPayload } from '../chains/types'

const ACCOUNT = '0x1111111111111111111111111111111111111111'
const STRANGER = '0x2222222222222222222222222222222222222222'
/** Beefy's Morpho USDC vault on Monad: real, but not the one this venue is confirmed for. */
const OTHER_VAULT = '0xA3d999114BCE3d9771703f06C490e77EE83E589a'
const USDT0 = '0xe7cd86e13AC4309349F30B3435a9d337750fC82D'
const MONAD_ID = 143
const HASH = `0x${'a'.repeat(64)}`
const FIVE_USDC = BigInt(5_000_000)

const CALLS = parseAbi([
  'function deposit(uint256 amount)',
  'function withdraw(uint256 shares)',
  'function depositAll()',
  'function withdrawAll()',
  'function earn()',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

function deposit(amount = FIVE_USDC): string {
  return encodeFunctionData({ abi: CALLS, functionName: 'deposit', args: [amount] })
}

function withdraw(shares = FIVE_USDC): string {
  return encodeFunctionData({ abi: CALLS, functionName: 'withdraw', args: [shares] })
}

function approve(units = FIVE_USDC, spender: string = BEEFY_MONAD_VAULT): string {
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
    to: BEEFY_MONAD_VAULT,
    data: deposit(),
    value: '0',
    ...overrides,
  }
}

interface ChainState {
  usdc: bigint
  allowance: bigint
  shares: bigint
  vaultBalance: bigint
  totalSupply: bigint
  want: string
  strategy: string
  candidate: string
  paused: boolean
  callFails: boolean
  readFails: string | undefined
  aaveActive: boolean
  aavePaused: boolean
  aaveSupplied: bigint
  aaveLent: bigint
}

/** One share to 1.02 USDC, so shares and USDC differ as they do live. */
const HEALTHY: ChainState = {
  usdc: BigInt(100_000_000),
  allowance: BigInt(0),
  shares: BigInt(50_000_000),
  vaultBalance: BigInt(3_060_000_000_000),
  totalSupply: BigInt(3_000_000_000_000),
  want: BEEFY_MONAD_USDC,
  strategy: BEEFY_MONAD_STRATEGY,
  candidate: zeroAddress,
  paused: false,
  callFails: false,
  readFails: undefined,
  aaveActive: true,
  aavePaused: false,
  aaveSupplied: BigInt(1_000_000_000_000),
  aaveLent: BigInt(500_000_000_000),
}

interface FakeRead {
  address: string
  functionName: string
}

function fakeReader(overrides: Partial<ChainState> = {}): EvmReaderClient & { calls: unknown[] } {
  const state = { ...HEALTHY, ...overrides }
  const calls: unknown[] = []
  const reads: Record<string, (address: string) => unknown> = {
    balanceOf: (address) => (address === BEEFY_MONAD_VAULT ? state.shares : state.usdc),
    allowance: () => state.allowance,
    want: () => state.want,
    strategy: () => state.strategy,
    stratCandidate: () => [state.candidate, BigInt(0)],
    balance: () => state.vaultBalance,
    totalSupply: () => state.totalSupply,
    paused: () => state.paused,
    // Aave's market, which this vault lends into. Each stops being readable with `aaveUnread`.
    getReserveConfigurationData: () => [
      BigInt(6),
      BigInt(0),
      BigInt(7800),
      BigInt(10500),
      BigInt(1000),
      true,
      true,
      false,
      state.aaveActive,
      false,
    ],
    getReserveData: () => [
      BigInt(0),
      BigInt(0),
      state.aaveSupplied,
      BigInt(0),
      state.aaveLent,
      BigInt(0),
      BigInt(0),
      BigInt(0),
      BigInt(0),
      BigInt(0),
      BigInt(0),
      0,
    ],
    getPaused: () => state.aavePaused,
    getReserveCaps: () => [BigInt(0), BigInt(0)],
  }
  const readContract = async ({ address, functionName }: FakeRead) => {
    if (state.readFails === functionName) throw new Error('rpc down')
    const read = reads[functionName]
    if (read === undefined) throw new Error(`unexpected read ${functionName}`)
    return read(address)
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
  } as unknown as EvmReaderClient & { calls: unknown[] }
}

const RATES = {
  'aavev3-monad-usdc': { totalApy: 0.05, lendingApr: 0.04, vaultApr: 0.0095 },
}

function fakeFetch(body: unknown = RATES, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch
}

function venueWith(
  overrides: Partial<ChainState> = {},
  fetcher: typeof fetch = fakeFetch(),
  client?: EvmClient
) {
  return createBeefyMonadVenue(() => fakeReader(overrides), client, fetcher)
}

function supply(overrides: Partial<ChainActionRequest> = {}): ChainActionRequest {
  return { kind: 'supply', amount: '5', tokenIn: 'USDC', ...overrides }
}

function takeOut(overrides: Partial<ChainActionRequest> = {}): ChainActionRequest {
  return { kind: 'withdraw', amount: '5.1', tokenIn: 'USDC', ...overrides }
}

function evm(signing: SigningPayload) {
  if (signing.family !== 'evm') throw new Error('not evm')
  return signing
}

describe('pinned ids', () => {
  it('uses the Monad token table’s USDC', () => {
    expect(MONAD_TOKENS.find((t) => t.symbol === 'USDC')?.id).toBe(BEEFY_MONAD_USDC)
  })

  it('lists itself as executing on Monad under the id the logo is named for', () => {
    expect(beefyMonadListing).toMatchObject({
      id: 'beefy-monad',
      family: 'evm',
      chains: ['Monad'],
      integration: 'executes',
    })
    expect(createBeefyMonadVenue().id).toBe(beefyMonadListing.id)
  })
})

describe('assertSafe', () => {
  const { assertSafe } = venueWith()

  it.each<[string, SigningPayload]>([
    ['a deposit', payload()],
    [
      'a deposit with its exact approval',
      payload({ approval: { to: BEEFY_MONAD_USDC, data: approve() } }),
    ],
    ['a withdrawal', payload({ data: withdraw() })],
    [
      'withdrawAll, which names no one and pays only the sender',
      payload({ data: encodeFunctionData({ abi: CALLS, functionName: 'withdrawAll' }) }),
    ],
  ])('passes %s', (_label, signing) => {
    expect(() => assertSafe(signing, ACCOUNT)).not.toThrow()
  })

  it.each<[string, SigningPayload]>([
    ['another family', { family: 'sui', transaction: 'AA==' }],
    ['another chain', payload({ chainId: 43114 })],
    ['Beefy’s other USDC vault on Monad', payload({ to: OTHER_VAULT })],
    ['the USDC contract as the target', payload({ to: BEEFY_MONAD_USDC })],
    ['the strategy as the target', payload({ to: BEEFY_MONAD_STRATEGY })],
    [
      'depositAll, which takes whatever is there',
      payload({ data: encodeFunctionData({ abi: CALLS, functionName: 'depositAll' }) }),
    ],
    [
      'withdrawAll with an approval beside it',
      payload({
        data: encodeFunctionData({ abi: CALLS, functionName: 'withdrawAll' }),
        approval: { to: BEEFY_MONAD_USDC, data: approve() },
      }),
    ],
    [
      'withdrawAll with extra data',
      payload({ data: `${encodeFunctionData({ abi: CALLS, functionName: 'withdrawAll' })}00` }),
    ],
    ['earn', payload({ data: encodeFunctionData({ abi: CALLS, functionName: 'earn' }) })],
    [
      'sending shares to someone else',
      payload({
        data: encodeFunctionData({
          abi: CALLS,
          functionName: 'transfer',
          args: [STRANGER as Address, FIVE_USDC],
        }),
      }),
    ],
    [
      'letting someone else spend the shares',
      payload({
        data: encodeFunctionData({
          abi: CALLS,
          functionName: 'approve',
          args: [STRANGER as Address, FIVE_USDC],
        }),
      }),
    ],
    ['calldata that decodes as nothing', payload({ data: '0xdeadbeef' })],
    ['anything after a deposit’s arguments', payload({ data: `${deposit()}00` })],
    ['anything after a withdrawal’s arguments', payload({ data: `${withdraw()}00` })],
    ['an empty deposit', payload({ data: deposit(BigInt(0)) })],
    ['an empty withdrawal', payload({ data: withdraw(BigInt(0)) })],
    ['native value', payload({ value: '1' })],
    [
      'an unlimited approval',
      payload({ approval: { to: BEEFY_MONAD_USDC, data: approve(maxUint256) } }),
    ],
    [
      'an approval to a stranger',
      payload({ approval: { to: BEEFY_MONAD_USDC, data: approve(FIVE_USDC, STRANGER) } }),
    ],
    ['an approval of another token', payload({ approval: { to: USDT0, data: approve() } })],
    [
      'an approval larger than the deposit',
      payload({ approval: { to: BEEFY_MONAD_USDC, data: approve(FIVE_USDC + BigInt(1)) } }),
    ],
    [
      'an approval smaller than the deposit',
      payload({ approval: { to: BEEFY_MONAD_USDC, data: approve(FIVE_USDC - BigInt(1)) } }),
    ],
    [
      'an approval on a withdrawal',
      payload({ data: withdraw(), approval: { to: BEEFY_MONAD_USDC, data: approve() } }),
    ],
    [
      'a first step that pays someone else',
      payload({
        approval: {
          to: BEEFY_MONAD_USDC,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [STRANGER as Address, FIVE_USDC],
          }),
        },
      }),
    ],
  ])('refuses %s', (_label, signing) => {
    expect(() => assertSafe(signing, ACCOUNT)).toThrow(ChainActionRefused)
  })

  it('refuses an account that is not an address', () => {
    expect(() => assertSafe(payload(), 'not-an-address')).toThrow(ChainActionRefused)
  })
})

describe('supply', () => {
  it('asks for an exact approval and a deposit of what was typed', async () => {
    const prepared = await venueWith().prepare(supply(), ACCOUNT)
    const signing = evm(prepared.signing)
    expect(signing.to).toBe(BEEFY_MONAD_VAULT)
    expect(signing.data).toBe(deposit())
    expect(signing.approval).toEqual({ to: BEEFY_MONAD_USDC, data: approve() })
    expect(prepared.kind).toBe('supply')
    expect(prepared.pay).toEqual({ amount: '5', symbol: 'USDC' })
    expect(prepared.notes.join(' ')).toContain('exactly 5 USDC')
  })

  it('leaves off the approval when one is in place, and tries the call', async () => {
    const reader = fakeReader({ allowance: FIVE_USDC })
    const prepared = await createBeefyMonadVenue(() => reader, undefined, fakeFetch()).prepare(
      supply(),
      ACCOUNT
    )
    expect(evm(prepared.signing).approval).toBeUndefined()
    expect(reader.calls).toHaveLength(1)
    expect(reader.calls[0]).toMatchObject({ account: ACCOUNT, to: BEEFY_MONAD_VAULT })
  })

  it('passes what it built through its own assertSafe', async () => {
    const venue = venueWith()
    const prepared = await venue.prepare(supply(), ACCOUNT)
    expect(() => venue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
  })

  it('tells the person a withdrawal pays what the strategy returns', async () => {
    const { notes } = await venueWith().prepare(supply(), ACCOUNT)
    expect(notes.join(' ')).toContain('pays what the strategy returns')
  })

  it('says who can change the vault, and how quickly', async () => {
    const { notes } = await venueWith().prepare(supply(), ACCOUNT)
    expect(notes.join(' ')).toContain('6-hour')
  })

  it('keeps Aave’s rate apart from the rewards', async () => {
    const { apy } = await venueWith().prepare(supply(), ACCOUNT)
    expect(apy).toEqual({ basePercent: 4, rewardPercent: 1 })
  })

  it.each<[string, typeof fetch]>([
    [
      'the rate service fails',
      (async () => {
        throw new Error('down')
      }) as unknown as typeof fetch,
    ],
    ['it answers an error', fakeFetch(RATES, false)],
    ['this vault is missing', fakeFetch({})],
    [
      'the rate is not a number',
      fakeFetch({ 'aavev3-monad-usdc': { totalApy: 'lots', lendingApr: 0.04 } }),
    ],
    [
      'the rate is negative',
      fakeFetch({ 'aavev3-monad-usdc': { totalApy: -0.1, lendingApr: 0.04 } }),
    ],
    ['the rate is absurd', fakeFetch({ 'aavev3-monad-usdc': { totalApy: 40, lendingApr: 0.04 } })],
    [
      'the parts exceed the whole',
      fakeFetch({ 'aavev3-monad-usdc': { totalApy: 0.01, lendingApr: 0.04 } }),
    ],
    ['the parts are not given', fakeFetch({ 'aavev3-monad-usdc': { totalApy: 0.05 } })],
  ])('shows no rate when %s, and still builds', async (_label, fetcher) => {
    const prepared = await venueWith({}, fetcher).prepare(supply(), ACCOUNT)
    expect(prepared.apy).toBeUndefined()
    expect(prepared.signing.family).toBe('evm')
  })

  it.each<[string, Partial<ChainActionRequest>]>([
    ['another token', { tokenIn: 'USDT0' }],
    ['the native coin', { tokenIn: 'MON' }],
    ['a token this chain doesn’t list', { tokenIn: 'AUSD' }],
    ['a zero amount', { amount: '0' }],
    ['more precision than USDC has', { amount: '1.0000001' }],
    ['a recipient other than the signer', { recipient: STRANGER }],
  ])('refuses %s', async (_label, request) => {
    await expect(venueWith().prepare(supply(request), ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })

  it.each<[string, Partial<ChainState>]>([
    ['less USDC than asked', { usdc: BigInt(1) }],
    ['a vault that no longer takes USDC', { want: USDT0 }],
    ['a strategy nobody reviewed', { strategy: STRANGER }],
    ['a proposed strategy change', { candidate: STRANGER }],
    ['a paused strategy', { paused: true }],
    ['an amount too small to earn a share', { vaultBalance: BigInt(10) ** BigInt(30) }],
    ['an unreadable vault', { readFails: 'strategy' }],
    ['an unreadable balance', { readFails: 'balanceOf' }],
    ['a call that would fail', { allowance: FIVE_USDC, callFails: true }],
  ])('refuses %s', async (_label, state) => {
    await expect(venueWith(state).prepare(supply(), ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })

  it('refuses an account that is not an address', async () => {
    await expect(venueWith().prepare(supply(), 'nope')).rejects.toThrow(ChainActionRefused)
  })

  it('refuses a kind it doesn’t do', async () => {
    await expect(
      venueWith().prepare({ kind: 'borrow', amount: '5', tokenIn: 'USDC' }, ACCOUNT)
    ).rejects.toThrow(ChainActionRefused)
  })
})

describe('withdraw', () => {
  it('burns the shares that pay what was typed, rounded in the person’s favour', async () => {
    const prepared = await venueWith().prepare(takeOut(), ACCOUNT)
    expect(evm(prepared.signing).data).toBe(withdraw(FIVE_USDC))
    expect(prepared.kind).toBe('withdraw')
    expect(prepared.pay).toEqual({ amount: '5.1', symbol: 'USDC' })
    expect(prepared.receive).toEqual({ amount: '5.1', symbol: 'USDC', approximate: true })

    const uneven = await venueWith().prepare(takeOut({ amount: '1' }), ACCOUNT)
    // 1 USDC at 1.02 is 980392.15 shares, so 980393 and never fewer.
    expect(evm(uneven.signing).data).toBe(withdraw(BigInt(980_393)))
  })

  it('takes all of a holding at exactly its worth, and refuses one unit more', async () => {
    // 980392 shares at 1.02 are worth 999999.84 units, so 0.999999 USDC.
    const shares = BigInt(980_392)
    const all = await venueWith({ shares }).prepare(takeOut({ amount: '0.999999' }), ACCOUNT)
    expect(evm(all.signing).data).toBe(withdraw(shares))
    await expect(venueWith({ shares }).prepare(takeOut({ amount: '1' }), ACCOUNT)).rejects.toThrow(
      ChainActionRefused
    )
  })

  it('needs no approval, and tries the call as this person', async () => {
    const reader = fakeReader()
    const prepared = await createBeefyMonadVenue(() => reader, undefined, fakeFetch()).prepare(
      takeOut(),
      ACCOUNT
    )
    expect(evm(prepared.signing).approval).toBeUndefined()
    expect(reader.calls[0]).toMatchObject({ account: ACCOUNT, to: BEEFY_MONAD_VAULT })
  })

  it('passes what it built through its own assertSafe', async () => {
    const venue = venueWith()
    const prepared = await venue.prepare(takeOut(), ACCOUNT)
    expect(() => venue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
  })

  it('says a withdrawal pays what the strategy returns', async () => {
    const { notes } = await venueWith().prepare(takeOut(), ACCOUNT)
    expect(notes.join(' ')).toContain('pays what the strategy returns')
  })

  it.each<[string, Partial<ChainState>]>([
    ['a strategy nobody reviewed', { strategy: STRANGER }],
    ['a proposed strategy change', { candidate: STRANGER }],
    ['a paused strategy', { paused: true }],
  ])('still lets a person out with %s', async (_label, state) => {
    const prepared = await venueWith(state).prepare(takeOut(), ACCOUNT)
    expect(prepared.kind).toBe('withdraw')
  })

  it.each<[string, Partial<ChainActionRequest>, Partial<ChainState>]>([
    ['another token', { tokenIn: 'USDT0' }, {}],
    ['more than the person holds here', { amount: '51.1' }, {}],
    ['a person with nothing here', {}, { shares: BigInt(0) }],
    ['an empty vault', {}, { totalSupply: BigInt(0) }],
    ['a vault that no longer pays USDC', {}, { want: USDT0 }],
    ['an unreadable vault', {}, { readFails: 'balance' }],
    ['a call that would fail', {}, { callFails: true }],
    ['a recipient other than the signer', { recipient: STRANGER }, {}],
  ])('refuses %s', async (_label, request, state) => {
    await expect(venueWith(state).prepare(takeOut(request), ACCOUNT)).rejects.toThrow(
      ChainActionRefused
    )
  })

  it('accepts the signer named as the recipient', async () => {
    const prepared = await venueWith().prepare(takeOut({ recipient: ACCOUNT }), ACCOUNT)
    expect(prepared.kind).toBe('withdraw')
  })
})

describe('quote', () => {
  it('gives the two rates together for the race, and reads no wallet', async () => {
    const reader = fakeReader({ readFails: 'balanceOf' })
    const venue = createBeefyMonadVenue(() => reader, undefined, fakeFetch())
    await expect(venue.quote?.(supply(), ACCOUNT)).resolves.toEqual({ apyPercent: 5 })
    expect(reader.calls).toHaveLength(0)
  })

  it('gives no rate when none can be read', async () => {
    const venue = venueWith({}, fakeFetch({}))
    await expect(venue.quote?.(supply(), ACCOUNT)).resolves.toEqual({})
  })

  it.each<[string, Partial<ChainState>]>([
    ['a strategy nobody reviewed', { strategy: STRANGER }],
    ['a paused strategy', { paused: true }],
  ])('refuses to race with %s', async (_label, state) => {
    await expect(venueWith(state).quote?.(supply(), ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })

  it('refuses another token and another kind', async () => {
    await expect(venueWith().quote?.(supply({ tokenIn: 'MON' }), ACCOUNT)).rejects.toThrow(
      ChainActionRefused
    )
    await expect(venueWith().quote?.(takeOut(), ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })
})

describe('following a swap', () => {
  it('takes USDC and nothing else', async () => {
    const { assertCanFollow } = venueWith()
    await expect(assertCanFollow?.({ kind: 'supply', tokenIn: 'USDC' }, ACCOUNT)).resolves.toBe(
      undefined
    )
    await expect(assertCanFollow?.({ kind: 'supply', tokenIn: 'MON' }, ACCOUNT)).rejects.toThrow(
      ChainActionRefused
    )
  })
})

describe('exits', () => {
  const WHOLE_DATA = encodeFunctionData({ abi: CALLS, functionName: 'withdrawAll' })
  const whole = takeOut({ wholePosition: true })

  it('shows what the shares are worth now, in USDC', async () => {
    await expect(venueWith().positions?.(ACCOUNT)).resolves.toEqual([
      { slot: 'supplied', symbol: 'USDC', amount: '51' },
    ])
  })

  it('shows nothing with no shares', async () => {
    await expect(venueWith({ shares: BigInt(0) }).positions?.(ACCOUNT)).resolves.toEqual([])
  })

  it.each(['balanceOf', 'balance', 'totalSupply'])(
    'throws when %s can not be read, rather than saying nothing is there',
    async (readFails) => {
      await expect(venueWith({ readFails }).positions?.(ACCOUNT)).rejects.toThrow()
    }
  )

  it('uses withdrawAll for all of it, with no approval', async () => {
    const venue = venueWith()
    const prepared = await venue.prepare(whole, ACCOUNT)
    const signing = evm(prepared.signing)
    expect(signing.data).toBe(WHOLE_DATA)
    expect(signing.approval).toBeUndefined()
    expect(prepared.pay).toEqual({ amount: '51', symbol: 'USDC' })
    expect(prepared.receive).toEqual({ amount: '51', symbol: 'USDC', approximate: true })
    expect(() => venue.assertSafe(signing, ACCOUNT)).not.toThrow()
  })

  it('leaves a part as a part', async () => {
    const prepared = await venueWith().prepare(takeOut(), ACCOUNT)
    expect(evm(prepared.signing).data).not.toBe(WHOLE_DATA)
  })

  it.each<[string, Partial<ChainState>, RegExp]>([
    ['no shares', { shares: BigInt(0) }, /You have no USDC/],
    ['Aave having paused USDC', { aavePaused: true }, /has paused USDC/],
    ['Aave having closed the reserve', { aaveActive: false }, /has paused USDC/],
    [
      'too little free on Aave',
      { aaveSupplied: BigInt(20_000_000), aaveLent: BigInt(10_000_000) },
      /only about 10 USDC free/,
    ],
    ['a call that would fail', { callFails: true }, /shares are still yours/],
  ])('refuses all of it with %s', async (_label, state, words) => {
    const asked = venueWith(state).prepare(whole, ACCOUNT)
    await expect(asked).rejects.toThrow(ChainActionRefused)
    await expect(asked).rejects.toThrow(words)
    await expect(asked).rejects.toThrow(/Nothing was signed or sent\.$/)
  })

  it('still lets the chain decide when Aave can not be read', async () => {
    const prepared = await venueWith({ readFails: 'getReserveData' }).prepare(whole, ACCOUNT)
    expect(evm(prepared.signing).data).toBe(WHOLE_DATA)
  })

  it('does not stop for a paused strategy, which only blocks deposits', async () => {
    await expect(venueWith({ paused: true }).prepare(whole, ACCOUNT)).resolves.toMatchObject({
      kind: 'withdraw',
    })
  })
})

function fakeClient(
  receipt: Partial<EvmReceipt>,
  sent: { input: string; value: bigint } = { input: deposit(), value: BigInt(0) }
): EvmClient {
  return {
    tokenBalance: async () => BigInt(0),
    nativeBalance: async () => BigInt(0),
    waitForReceipt: async () =>
      ({
        status: 'success',
        from: ACCOUNT,
        to: BEEFY_MONAD_VAULT,
        logs: [],
        ...receipt,
      }) as EvmReceipt,
    transaction: async () => sent,
  }
}

describe('submit', () => {
  const signed = {
    account: ACCOUNT,
    venueId: 'beefy-monad',
    signed: { family: 'evm' as const, hash: HASH },
  }

  function submitWith(client: EvmClient) {
    return createBeefyMonadVenue(() => fakeReader(), client, fakeFetch()).submit?.(signed)
  }

  it('settles a landed deposit from this person', async () => {
    await expect(submitWith(fakeClient({}))).resolves.toMatchObject({ ok: true, hash: HASH })
  })

  it('says funds did not move for a proven revert of this very call', async () => {
    const result = await submitWith(fakeClient({ status: 'reverted' }))
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
  })

  it.each<[string, EvmClient]>([
    ['the wrong signer', fakeClient({ from: STRANGER })],
    ['another contract', fakeClient({ to: OTHER_VAULT })],
    [
      'a call to something else on the vault',
      fakeClient(
        {},
        { input: encodeFunctionData({ abi: CALLS, functionName: 'earn' }), value: BigInt(0) }
      ),
    ],
  ])('stays pending for %s, since the money may have moved', async (_label, client) => {
    await expect(submitWith(client)).resolves.toMatchObject({ ok: false, pending: true })
  })
})
