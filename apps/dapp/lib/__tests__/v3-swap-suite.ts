import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  maxUint256,
  pad,
  parseAbi,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
  type StateOverride,
} from 'viem'
import { describe, expect, it } from 'vitest'

import type { EvmReaderClient } from '../chains/evm/call'
import type { EvmClient, EvmReceipt } from '../chains/evm/client'
import { ChainActionRefused, type ChainVenue, type SigningPayload } from '../chains/types'

/**
 * The refusals every v3-style swap venue owes, run against each router's own encoding. Each
 * venue's test supplies that encoding by hand, so nothing here is built by the code it checks.
 */

export const ACCOUNT = '0x1111111111111111111111111111111111111111'
export const STRANGER = '0x2222222222222222222222222222222222222222'
const NOT_A_TOKEN = '0x3333333333333333333333333333333333333333'
const HASH = `0x${'a'.repeat(64)}`
const ONE = BigInt(1)
const ZERO = BigInt(0)

export interface SwapFields {
  tokenIn: string
  tokenOut: string
  tier: number
  recipient: string
  amountIn: bigint
  amountOutMinimum: bigint
  sqrtPriceLimitX96: bigint
  deadline: bigint
}

export interface RouterFixture {
  label: string
  /** The venue with its reads replaced. */
  venue: (reader: EvmReaderClient, client: EvmClient) => ChainVenue
  chainId: number
  otherChainId: number
  router: string
  quoter: string
  nativeSymbol: string
  wrapped: { symbol: string; id: string }
  /** A stablecoin, 6 decimals, and a second one. */
  stable: { symbol: string; id: string }
  stable2: { symbol: string; id: string }
  /** The best and second-best tiers the fake quoter answers for, then one the router has no pool at. */
  bestTier: number
  worseTier: number
  unverifiedTier: number
  /** Reads a tier out of a quoter call's tuple. */
  tierOf: (params: Record<string, unknown>) => number
  encodeSwap: (fields: SwapFields) => Hex
  /** Wraps calls the way this venue must send them. */
  encodeOuter: (calls: readonly Hex[], deadline: bigint) => Hex
  /** Calls whose deadline is outer are wrapped with it, others hold it in the swap. */
  deadlineIn: 'outer' | 'swap'
  decodeSwap: (data: Hex) => SwapFields & { outer: Hex[] }
}

const REFUND_ABI = parseAbi(['function refundETH() payable'])
const REFUND = encodeFunctionData({ abi: REFUND_ABI, functionName: 'refundETH' })
const SWEEP_ABI = parseAbi([
  'function sweepToken(address token, uint256 amountMinimum, address recipient) payable',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
])

interface FakeOptions {
  /** Units out per unit in, by tier, as a whole-number ratio over 10^6. Absent is no pool. */
  rate: Record<number, bigint>
  /** Replaces the output for one input size, to play a thin pool. */
  outFor?: (tier: number, amountIn: bigint) => bigint | undefined
  allowance?: bigint
  callFails?: boolean
  quoteFails?: boolean
}

export function fakeReader(fixture: RouterFixture, options: FakeOptions) {
  const seen: string[] = []
  const reader = {
    simulateContract: async ({
      address,
      functionName,
      args,
    }: {
      address: string
      functionName: string
      args: readonly [Record<string, unknown>]
    }) => {
      seen.push(`simulate:${functionName}`)
      if (address.toLowerCase() !== fixture.quoter.toLowerCase()) throw new Error('not the quoter')
      if (options.quoteFails === true) throw new Error('rpc down')
      const params = args[0]
      const tier = fixture.tierOf(params)
      const amountIn = params['amountIn'] as bigint
      const rate = options.rate[tier]
      if (rate === undefined) throw new Error('no pool')
      const replaced = options.outFor?.(tier, amountIn)
      if (replaced !== undefined) return { result: [replaced, ZERO, 0, ZERO] }
      return { result: [(amountIn * rate) / BigInt(1_000_000), ZERO, 0, ZERO] }
    },
    readContract: async () => {
      seen.push('read')
      return options.allowance ?? ZERO
    },
    call: async () => {
      seen.push('call')
      if (options.callFails === true) throw new Error('reverted')
      return { data: '0x' }
    },
  }
  return { reader: reader as unknown as EvmReaderClient, seen }
}

export function fakeClient(
  overrides: {
    balance?: bigint
    native?: bigint
    receipt?: Partial<EvmReceipt>
    sent?: { input: string; value: bigint }
  } = {}
): EvmClient {
  return {
    tokenBalance: async () => overrides.balance ?? BigInt('1000000000000000000000000'),
    nativeBalance: async () => overrides.native ?? BigInt('1000000000000000000000000'),
    waitForReceipt: async () =>
      ({ status: 'success', from: ACCOUNT, to: '', logs: [], ...overrides.receipt }) as EvmReceipt,
    transaction: async () => overrides.sent ?? { input: '0x', value: ZERO },
  }
}

const FUTURE = () => BigInt(Math.floor(Date.now() / 1000) + 600)

export function describeV3SwapVenue(fixture: RouterFixture): void {
  const {
    router,
    chainId,
    otherChainId,
    wrapped,
    stable,
    stable2,
    nativeSymbol,
    bestTier,
    worseTier,
  } = fixture
  const rates = { [bestTier]: BigInt(900_000), [worseTier]: BigInt(800_000) }

  function venue(
    options: Partial<FakeOptions> = {},
    client: EvmClient = fakeClient()
  ): { venue: ChainVenue; seen: string[] } {
    const { reader, seen } = fakeReader(fixture, { rate: rates, ...options })
    return { venue: fixture.venue(reader, client), seen }
  }

  function fields(overrides: Partial<SwapFields> = {}): SwapFields {
    return {
      tokenIn: stable.id,
      tokenOut: wrapped.id,
      tier: bestTier,
      recipient: ACCOUNT,
      amountIn: BigInt(10_000_000),
      amountOutMinimum: BigInt(1_000),
      sqrtPriceLimitX96: ZERO,
      deadline: FUTURE(),
      ...overrides,
    }
  }

  function swapCall(overrides: Partial<SwapFields> = {}): Hex {
    return fixture.encodeSwap(fields(overrides))
  }

  function outer(calls: readonly Hex[], deadline = FUTURE()): Hex {
    return fixture.encodeOuter(calls, deadline)
  }

  function payload(
    overrides: Partial<Extract<SigningPayload, { family: 'evm' }>> = {},
    swap: Partial<SwapFields> = {}
  ): Extract<SigningPayload, { family: 'evm' }> {
    return {
      family: 'evm',
      chainId,
      to: router,
      data: outer([swapCall(swap)]),
      value: '0',
      ...overrides,
    }
  }

  function approve(spender: string = router, units = BigInt(10_000_000)): string {
    return encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender as Address, units],
    })
  }

  function nativePayload(
    overrides: Partial<SwapFields> = {},
    value = '1000000000000000000'
  ): Extract<SigningPayload, { family: 'evm' }> {
    const swap = swapCall({
      tokenIn: wrapped.id,
      tokenOut: stable.id,
      amountIn: BigInt('1000000000000000000'),
      ...overrides,
    })
    return payload({ data: outer([swap, REFUND]), value })
  }

  describe(`${fixture.label}: quoting`, () => {
    const request = {
      kind: 'swap' as const,
      amount: '10',
      tokenIn: stable.symbol,
      tokenOut: stable2.symbol,
    }

    it('gives the best tier’s output, and only reads', async () => {
      const { venue: v, seen } = venue()
      const quoted = await v.quote?.(request, ACCOUNT)
      expect(quoted?.receive).toEqual({ amount: '9', symbol: stable2.symbol })
      expect(seen.every((step) => step === 'simulate:quoteExactInputSingle')).toBe(true)
    })

    it('refuses when no tier can be read, rather than guessing', async () => {
      await expect(venue({ quoteFails: true }).venue.quote?.(request, ACCOUNT)).rejects.toThrow(
        ChainActionRefused
      )
      await expect(venue({ rate: {} }).venue.quote?.(request, ACCOUNT)).rejects.toThrow(
        ChainActionRefused
      )
    })

    it('refuses a pool too thin to take the size', async () => {
      const thin = (_tier: number, amountIn: bigint) =>
        amountIn === BigInt(10_000_000) ? BigInt(1_000_000) : undefined
      await expect(venue({ outFor: thin }).venue.quote?.(request, ACCOUNT)).rejects.toThrow(
        /isn't enough liquidity/
      )
    })

    it('allows the ordinary small drop a real pool shows', async () => {
      const deep = (_tier: number, amountIn: bigint) =>
        amountIn === BigInt(10_000_000) ? BigInt(8_800_000) : undefined
      await expect(venue({ outFor: deep }).venue.quote?.(request, ACCOUNT)).resolves.toBeDefined()
    })

    it('refuses an amount too small to price', async () => {
      await expect(
        venue().venue.quote?.({ ...request, amount: '0.000001' }, ACCOUNT)
      ).rejects.toThrow(ChainActionRefused)
    })

    it.each([
      ['an unknown token in', { tokenIn: 'SCAM' }],
      ['an unknown token out', { tokenOut: 'SCAM' }],
      ['no token out', { tokenOut: undefined }],
      ['the same token twice', { tokenOut: stable.symbol }],
      ['a kind this venue does not do', { kind: 'supply' as const }],
      ['the native coin out', { tokenOut: nativeSymbol }],
      [
        'the native coin into its own wrapped form',
        { tokenIn: nativeSymbol, tokenOut: wrapped.symbol },
      ],
    ])('refuses %s', async (_label, change) => {
      await expect(venue().venue.quote?.({ ...request, ...change }, ACCOUNT)).rejects.toThrow(
        ChainActionRefused
      )
    })
  })

  describe(`${fixture.label}: preparing`, () => {
    const request = {
      kind: 'swap' as const,
      amount: '10',
      tokenIn: stable.symbol,
      tokenOut: stable2.symbol,
    }
    // Between 6-decimal coins, the fake's 0.9 rate gives 9 out.
    const OUT = BigInt(9_000_000)

    it('sets the minimum no more than 1% under the quote, paying the person', async () => {
      const prepared = await venue({ allowance: BigInt(10_000_000) }).venue.prepare(
        request,
        ACCOUNT
      )
      if (prepared.signing.family !== 'evm') throw new Error('not evm')
      const swap = fixture.decodeSwap(prepared.signing.data as Hex)
      expect(swap.recipient.toLowerCase()).toBe(ACCOUNT)
      expect(swap.tier).toBe(bestTier)
      expect(swap.amountIn).toBe(BigInt(10_000_000))
      expect(swap.amountOutMinimum >= (OUT * BigInt(99)) / BigInt(100)).toBe(true)
      expect(swap.amountOutMinimum < OUT).toBe(true)
      expect(swap.sqrtPriceLimitX96).toBe(ZERO)
      expect(prepared.signing.value).toBe('0')
      expect(prepared.signing.to.toLowerCase()).toBe(router.toLowerCase())
      expect(prepared.receive).toEqual({ amount: '9', symbol: stable2.symbol, approximate: true })
      expect(prepared.pay).toEqual({ amount: '10', symbol: stable.symbol })
      expect(prepared.kind).toBe('swap')
    })

    it('never overstates what the quote will pay', async () => {
      const prepared = await venue({
        allowance: BigInt(10_000_000),
        rate: { [bestTier]: BigInt(899_999) },
      }).venue.prepare(request, ACCOUNT)
      expect(prepared.receive?.amount).toBe('8.99999')
    })

    it('asks for an exact approval when none is in place, and says so', async () => {
      const prepared = await venue({ allowance: BigInt(1) }).venue.prepare(request, ACCOUNT)
      if (prepared.signing.family !== 'evm') throw new Error('not evm')
      expect(prepared.signing.approval?.to.toLowerCase()).toBe(stable.id.toLowerCase())
      expect(prepared.signing.approval?.data).toBe(approve())
      expect(prepared.notes.join(' ')).toContain('exactly 10')
    })

    it('leaves the approval off when one is in place', async () => {
      const prepared = await venue({ allowance: BigInt(10_000_000) }).venue.prepare(
        request,
        ACCOUNT
      )
      if (prepared.signing.family !== 'evm') throw new Error('not evm')
      expect(prepared.signing.approval).toBeUndefined()
    })

    it('refuses a call the chain says would fail', async () => {
      await expect(
        venue({ allowance: BigInt(10_000_000), callFails: true }).venue.prepare(request, ACCOUNT)
      ).rejects.toThrow(ChainActionRefused)
    })

    it('refuses when the wallet holds too little', async () => {
      await expect(
        venue({}, fakeClient({ balance: BigInt(5) })).venue.prepare(request, ACCOUNT)
      ).rejects.toThrow(ChainActionRefused)
    })

    it('refuses an account that is not an address', async () => {
      await expect(venue().venue.prepare(request, 'nope')).rejects.toThrow(ChainActionRefused)
    })

    it('refuses an address whose checksum is wrong', async () => {
      const mistyped = '0x00000000000000000000000000000000000fEEd1'
      await expect(venue().venue.prepare(request, mistyped)).rejects.toThrow(ChainActionRefused)
    })

    it('swaps the native coin in as value, wrapped by the router, with the rest refunded', async () => {
      const prepared = await venue().venue.prepare(
        { kind: 'swap', amount: '1', tokenIn: nativeSymbol, tokenOut: stable.symbol },
        ACCOUNT
      )
      if (prepared.signing.family !== 'evm') throw new Error('not evm')
      expect(prepared.signing.value).toBe('1000000000000000000')
      expect(prepared.signing.approval).toBeUndefined()
      const swap = fixture.decodeSwap(prepared.signing.data as Hex)
      expect(swap.tokenIn.toLowerCase()).toBe(wrapped.id.toLowerCase())
      expect(swap.amountIn).toBe(BigInt('1000000000000000000'))
      expect(swap.outer[1]).toBe(REFUND)
      expect(prepared.pay.symbol).toBe(nativeSymbol)
    })

    it('says plainly when what comes back is the wrapped token', async () => {
      const prepared = await venue().venue.prepare(
        { kind: 'swap', amount: '10', tokenIn: stable.symbol, tokenOut: wrapped.symbol },
        ACCOUNT
      )
      expect(prepared.notes.join(' ')).toContain(`wrapped form of ${nativeSymbol}`)
    })

    it('states the slippage floor on the card', async () => {
      const prepared = await venue().venue.prepare(request, ACCOUNT)
      expect(prepared.notes.join(' ')).toContain(`at least 8.955 ${stable2.symbol}`)
    })

    it('passes its own check', async () => {
      const v = venue().venue
      const prepared = await v.prepare(request, ACCOUNT)
      expect(() => v.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
    })
  })

  describe(`${fixture.label}: assertSafe`, () => {
    const safe = (signing: SigningPayload) => venue().venue.assertSafe(signing, ACCOUNT)

    it('passes a swap of a listed pair to the person', () => {
      expect(() => safe(payload())).not.toThrow()
    })

    it('passes a native swap with its refund', () => {
      expect(() => safe(nativePayload())).not.toThrow()
    })

    it('passes an exact approval of the token in', () => {
      expect(() => safe(payload({ approval: { to: stable.id, data: approve() } }))).not.toThrow()
    })

    it.each<[string, () => SigningPayload]>([
      ['another family', () => ({ family: 'sui', transaction: 'AA==' })],
      ['another chain', () => payload({ chainId: otherChainId })],
      ['an unknown contract', () => payload({ to: NOT_A_TOKEN })],
      ['the quoter as the target', () => payload({ to: fixture.quoter })],
      ['a token contract as the target', () => payload({ to: stable.id })],
      ['a bare swap outside the multicall', () => payload({ data: swapCall() })],
      [
        'a function it may not call',
        () =>
          payload({
            data: encodeFunctionData({
              abi: SWEEP_ABI,
              functionName: 'sweepToken',
              args: [stable.id as Address, ZERO, STRANGER as Address],
            }),
          }),
      ],
      ['calldata that decodes as nothing', () => payload({ data: '0xdeadbeef' })],
      ['anything after the arguments', () => payload({ data: `${outer([swapCall()])}00` })],
      ['anything after the inner call', () => payload({ data: outer([`${swapCall()}00`]) })],
      ['an empty multicall', () => payload({ data: outer([]) })],
      ['a second swap', () => payload({ data: outer([swapCall(), swapCall()]) })],
      [
        'a sweep to a stranger after the swap',
        () =>
          payload({
            data: outer([
              swapCall(),
              encodeFunctionData({
                abi: SWEEP_ABI,
                functionName: 'sweepToken',
                args: [wrapped.id as Address, ZERO, STRANGER as Address],
              }),
            ]),
          }),
      ],
      [
        'an unwrap to a stranger instead of a refund',
        () =>
          payload({
            value: '1',
            data: outer([
              swapCall({ tokenIn: wrapped.id, tokenOut: stable.id, amountIn: ONE }),
              encodeFunctionData({
                abi: SWEEP_ABI,
                functionName: 'unwrapWETH9',
                args: [ZERO, STRANGER as Address],
              }),
            ]),
          }),
      ],
      ['a refund first', () => payload({ data: outer([REFUND, swapCall()]) })],
      ['a refund with no value', () => payload({ data: outer([swapCall(), REFUND]) })],
      ['payment to someone else', () => payload({}, { recipient: STRANGER })],
      [
        'the router’s own stand-in for the sender',
        () => payload({}, { recipient: `0x${'0'.repeat(39)}1` }),
      ],
      [
        'the router itself as the recipient',
        () => payload({}, { recipient: `0x${'0'.repeat(39)}2` }),
      ],
      ['a token in that is not listed', () => payload({}, { tokenIn: NOT_A_TOKEN })],
      ['a token out that is not listed', () => payload({}, { tokenOut: NOT_A_TOKEN })],
      ['the same token both ways', () => payload({}, { tokenOut: stable.id })],
      ['a tier that is not verified', () => payload({}, { tier: fixture.unverifiedTier })],
      ['no minimum out', () => payload({}, { amountOutMinimum: ZERO })],
      [
        'a zero amount in, which spends the router’s balance',
        () => payload({}, { amountIn: ZERO }),
      ],
      [
        'a price limit that could stop the swap short',
        () => payload({}, { sqrtPriceLimitX96: ONE }),
      ],
      [
        'a deadline far in the future',
        () =>
          fixture.deadlineIn === 'outer'
            ? payload({ data: outer([swapCall()], FUTURE() + BigInt(86_400)) })
            : payload({}, { deadline: FUTURE() + BigInt(86_400) }),
      ],
      [
        'value with a token that is not the wrapped coin',
        () => nativePayload({ tokenIn: stable2.id }),
      ],
      ['value short of the amount', () => nativePayload({}, '999')],
      ['value over the amount', () => nativePayload({}, '1000000000000000001')],
      ['value with no refund', () => payload({ value: '1' })],
      ['a value that is not digits', () => payload({ value: '0x1' })],
      [
        'value and an approval together',
        () => ({
          ...nativePayload(),
          approval: { to: wrapped.id, data: approve(router, BigInt('1000000000000000000')) },
        }),
      ],
      [
        'an unlimited approval',
        () => payload({ approval: { to: stable.id, data: approve(router, maxUint256) } }),
      ],
      [
        'an approval above the swap',
        () => payload({ approval: { to: stable.id, data: approve(router, BigInt(10_000_001)) } }),
      ],
      [
        'an approval below the swap',
        () => payload({ approval: { to: stable.id, data: approve(router, BigInt(9_999_999)) } }),
      ],
      [
        'an approval to a stranger',
        () => payload({ approval: { to: stable.id, data: approve(STRANGER) } }),
      ],
      [
        'an approval of another listed token',
        () => payload({ approval: { to: stable2.id, data: approve() } }),
      ],
      [
        'an approval of an unlisted token',
        () => payload({ approval: { to: NOT_A_TOKEN, data: approve() } }),
      ],
      [
        'an approval with trailing data',
        () => payload({ approval: { to: stable.id, data: `${approve()}00` } }),
      ],
    ])('refuses %s', (_label, build) => {
      expect(() => safe(build())).toThrow(ChainActionRefused)
    })

    it('refuses a swap built for another account', () => {
      expect(() => venue().venue.assertSafe(payload(), STRANGER)).toThrow(ChainActionRefused)
    })
  })

  describe(`${fixture.label}: after the wallet sends`, () => {
    const signed = { family: 'evm' as const, hash: HASH }
    const submitWith = (client: EvmClient) =>
      venue({}, client).venue.submit?.({
        account: ACCOUNT,
        venueId: venue().venue.id,
        signed,
      })

    it('settles a landed swap of this venue’s, from this person, once past its deadline', async () => {
      const past = BigInt(Math.floor(Date.now() / 1000) - 3_600)
      const data = outer([swapCall({ deadline: past })], past)
      const result = await submitWith(
        fakeClient({ receipt: { to: router as Address }, sent: { input: data, value: ZERO } })
      )
      expect(result).toMatchObject({ ok: true, hash: HASH })
    })

    it('stays pending for a transaction that pays someone else', async () => {
      const data = outer([swapCall({ recipient: STRANGER })])
      const result = await submitWith(
        fakeClient({ receipt: { to: router as Address }, sent: { input: data, value: ZERO } })
      )
      expect(result).toMatchObject({ ok: false, pending: true })
    })
  })
}

/**
 * The real chain, except that an account holds what `stateOverride` gives it, so a live test can try
 * a swap with no wallet. It's an `eth_call`, so nothing is sent.
 */
export function fundedReader(
  reader: EvmReaderClient,
  stateOverride: StateOverride,
  allowance: bigint
): EvmReaderClient {
  return {
    simulateContract: reader.simulateContract.bind(reader),
    readContract: async () => allowance,
    call: (args: Parameters<EvmReaderClient['call']>[0]) => reader.call({ ...args, stateOverride }),
  } as unknown as EvmReaderClient
}

/** WETH9's storage: `balanceOf` at slot 3 and `allowance` at slot 4. */
export function wethHolding(
  account: string,
  spender: string,
  units: bigint
): { slot: Hex; value: Hex }[] {
  const value = pad(toHex(units), { size: 32 })
  const balanceSlot = keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256'), [account as Address, BigInt(3)])
  )
  const outerSlot = keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256'), [account as Address, BigInt(4)])
  )
  const allowanceSlot = keccak256(
    encodeAbiParameters(parseAbiParameters('address, bytes32'), [spender as Address, outerSlot])
  )
  return [
    { slot: balanceSlot, value },
    { slot: allowanceSlot, value },
  ]
}
