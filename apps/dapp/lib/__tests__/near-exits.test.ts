import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { earnVenue } from '../chains/near/earn'
import { clearTokenCache } from '../chains/near/oneclick'
import { assertMetapoolSafe, assertRnearSafe, INTENTS_CONTRACT } from '../chains/near/safety'
import { confirmStake, metapoolVenue, rnearVenue } from '../chains/near/stake'
import { METAPOOL_CONTRACT, RNEAR_CONTRACT, USDC_NEAR } from '../chains/near/tokens'
import { prepareChainAction } from '../chains/prepare'
import {
  ChainActionRefused,
  type ChainActionRequest,
  type ChainModule,
  type NearTransaction,
  type SigningPayload,
} from '../chains/types'
import type { NearFunctionCall } from '../chains/types'

/** Every path here ends in a NEAR wallet that sends what it signs. Nothing signs or sends in tests. */

const ME = 'alice.near'
const HASH = 'G6RQqbkHNF1JVMwmq9BiLnZ3vvUeYoNm7z4dYVEKgScA'
const DEPOSIT = 'dc2c3034e3ebefa1af9a2c419f896d7b761a056244099eefcd09aeb7efc1b86d'
const VAULT = 'nep141:base-0x0bb69b79bc829e1cfcc34a740110886d98d2bd14.omft.near'
const USDC_ASSET = `nep141:${USDC_NEAR}`
const ONE = '1000000000000000000000000'
const TWO = '2000000000000000000000000'

interface Fake {
  views: Record<string, unknown>
  balances: Record<string, string>
  contractBalance: string
  down: boolean
  quotesDown: boolean
  quotes: Record<string, unknown>[]
  tx: Record<string, unknown> | undefined
}
let fake: Fake

function quoteFor(request: Record<string, unknown>): unknown {
  const amount = String(request['amount'])
  // A share is worth 1e-12 USDC in base units here: 2e18 shares come to 2 USDC.
  const out = ((BigInt(amount) * BigInt(1000000)) / BigInt('1000000000000000000')).toString()
  return {
    quote: {
      amountIn: amount,
      amountInFormatted: amount,
      amountInUsd: '2.00',
      minAmountIn: amount,
      amountOut: out,
      amountOutFormatted: out,
      amountOutUsd: '1.99',
      minAmountOut: ((BigInt(out) * BigInt(99)) / BigInt(100)).toString(),
      ...(request['dry'] === false ? { depositAddress: DEPOSIT } : {}),
    },
    quoteRequest: request,
    signature: 'ed25519:test',
    timestamp: '2026-11-05T00:00:00.000Z',
  }
}

vi.mock('../chains/near/quote-signature', () => ({ verifyQuoteSignature: () => true }))

function install(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const json = (data: unknown, status = 200): Response =>
        new Response(JSON.stringify(data), { status })
      if (url.endsWith('/v0/tokens')) {
        const priced = (assetId: string, decimals: number, price: number) => ({
          assetId,
          decimals,
          symbol: assetId,
          price,
          priceUpdatedAt: new Date().toISOString(),
        })
        return json([priced(VAULT, 18, 1), priced(USDC_ASSET, 6, 1)])
      }
      if (url.endsWith('/v0/quote')) {
        if (fake.quotesDown) return json({ message: 'Quoting for this pair is not available' }, 400)
        const request = JSON.parse(init?.body as string) as Record<string, unknown>
        fake.quotes.push(request)
        return json(quoteFor(request))
      }
      if (url.includes('/v0/status') || url.includes('/v0/deposit/submit')) return json({})
      if (fake.down) throw new Error('down')
      const body = JSON.parse(init?.body as string) as {
        method: string
        params: {
          request_type?: string
          account_id?: string
          method_name?: string
          args_base64?: string
        }
      }
      if (body.method === 'tx') {
        return json(
          fake.tx === undefined
            ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }
            : { result: fake.tx }
        )
      }
      if (body.params.request_type === 'view_account') {
        return json({ result: { amount: fake.contractBalance } })
      }
      const encode = (value: unknown) => ({
        result: { result: [...Buffer.from(JSON.stringify(value))] },
      })
      if (body.params.method_name === 'mt_balance_of') {
        const args = JSON.parse(
          Buffer.from(body.params.args_base64 ?? '', 'base64').toString()
        ) as {
          token_id: string
        }
        return json(encode(fake.balances[args.token_id] ?? '0'))
      }
      const key = `${body.params.account_id}.${body.params.method_name}`
      if (!(key in fake.views)) return json({ result: { error: `no ${key}` } })
      return json(encode(fake.views[key]))
    })
  )
}

const metaAccount = (over: Record<string, unknown> = {}) => ({
  st_near: TWO,
  unstaked: '0',
  can_withdraw: true,
  unstake_full_epochs_wait_left: 0,
  ...over,
})
const rnearAccount = (over: Record<string, unknown> = {}) => ({
  unstaked_balance: '0',
  unstaked_available_epoch_height: 0,
  can_withdraw: true,
  ...over,
})

beforeEach(() => {
  clearTokenCache()
  fake = {
    views: {
      [`${METAPOOL_CONTRACT}.get_account_info`]: metaAccount(),
      [`${METAPOOL_CONTRACT}.get_st_near_price`]: '1500000000000000000000000',
      [`${METAPOOL_CONTRACT}.compute_current_unstaking_delay`]: 4,
      [`${METAPOOL_CONTRACT}.get_contract_state`]: {
        env_epoch_height: '100',
        retrieved_for_unstake_claims: TWO,
      },
      [`${RNEAR_CONTRACT}.get_account_details`]: rnearAccount(),
      [`${RNEAR_CONTRACT}.ft_balance_of`]: TWO,
      [`${RNEAR_CONTRACT}.ft_price`]: '1100000000000000000000000',
      [`${RNEAR_CONTRACT}.is_paused`]: false,
      [`${USDC_NEAR}.storage_balance_of`]: { total: '1', available: '0' },
    },
    balances: {},
    contractBalance: `5${ONE}`,
    down: false,
    quotesDown: false,
    quotes: [],
    tx: undefined,
  }
  install()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const ask = (over: Partial<ChainActionRequest>): ChainActionRequest => ({
  kind: 'unstake',
  amount: '1',
  tokenIn: 'stNEAR',
  ...over,
})

function txs(prepared: { signing: SigningPayload }): NearTransaction[] {
  return (prepared.signing as { transactions: NearTransaction[] }).transactions
}

function call(prepared: { signing: SigningPayload }) {
  const [tx] = txs(prepared)
  return {
    receiverId: tx?.receiverId,
    params: (tx?.actions[0] as NearFunctionCall | undefined)?.params,
  }
}

describe('unstaking from Meta Pool', () => {
  it('turns a part of your stNEAR into its NEAR value, and passes its own check', async () => {
    const prepared = await metapoolVenue.prepare(ask({ amount: '1' }), ME)
    expect(call(prepared)).toEqual({
      receiverId: METAPOOL_CONTRACT,
      params: {
        methodName: 'unstake',
        args: { amount: '1500000000000000000000000' },
        gas: '100000000000000',
        deposit: '0',
      },
    })
    expect(prepared.pay).toEqual({ amount: '1', symbol: 'stNEAR' })
    expect(prepared.receive).toEqual({ amount: '1.5', symbol: 'NEAR', approximate: true })
    expect(prepared.notes.join(' ')).toMatch(/4 epochs.*about 29 hours.*claim my NEAR/)
    expect(() => metapoolVenue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('empties the position exactly when it is the whole position', async () => {
    const prepared = await metapoolVenue.prepare(ask({ amount: '2', wholePosition: true }), ME)
    expect(call(prepared).params).toMatchObject({ methodName: 'unstake_all', args: {} })
    expect(() => metapoolVenue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('refuses more than you hold, none at all, and a token it did not issue', async () => {
    await expect(metapoolVenue.prepare(ask({ amount: '3' }), ME)).rejects.toThrow(
      /You hold 2 stNEAR/
    )
    await expect(metapoolVenue.prepare(ask({ tokenIn: 'rNEAR' }), ME)).rejects.toThrow(
      /say it in stNEAR/
    )
    fake.views[`${METAPOOL_CONTRACT}.get_account_info`] = metaAccount({ st_near: '0' })
    await expect(metapoolVenue.prepare(ask({}), ME)).rejects.toThrow(/hold no stNEAR/)
  })

  it('refuses when NEAR cannot be read', async () => {
    fake.down = true
    await expect(metapoolVenue.prepare(ask({}), ME)).rejects.toThrow(/could not be read/)
  })
})

describe('unstaking rNEAR', () => {
  it('builds the same two forms at its own price and gas', async () => {
    const part = await rnearVenue.prepare(ask({ tokenIn: 'rNEAR' }), ME)
    expect(call(part)).toEqual({
      receiverId: RNEAR_CONTRACT,
      params: {
        methodName: 'unstake',
        args: { amount: '1100000000000000000000000' },
        gas: '200000000000000',
        deposit: '0',
      },
    })
    expect(() => rnearVenue.assertSafe(part.signing, ME)).not.toThrow()
    const whole = await rnearVenue.prepare(ask({ tokenIn: 'rNEAR', wholePosition: true }), ME)
    expect(call(whole).params).toMatchObject({ methodName: 'unstake_all', args: {} })
    expect(() => rnearVenue.assertSafe(whole.signing, ME)).not.toThrow()
    expect(part.notes.join(' ')).toMatch(/source link/)
  })

  it('refuses while the contract is paused', async () => {
    fake.views[`${RNEAR_CONTRACT}.is_paused`] = true
    await expect(rnearVenue.prepare(ask({ tokenIn: 'rNEAR' }), ME)).rejects.toThrow(/paused/)
  })
})

describe('what each stake venue holds', () => {
  it('shows the token in the wallet as staked', async () => {
    await expect(metapoolVenue.positions?.(ME)).resolves.toEqual([
      { slot: 'staked', symbol: 'stNEAR', amount: '2' },
    ])
    await expect(rnearVenue.positions?.(ME)).resolves.toEqual([
      { slot: 'staked', symbol: 'rNEAR', amount: '2' },
    ])
  })

  it('shows a pending unstake as cooling, with the hours the chain implies', async () => {
    fake.views[`${METAPOOL_CONTRACT}.get_account_info`] = metaAccount({
      st_near: '0',
      unstaked: ONE,
      can_withdraw: false,
      unstake_full_epochs_wait_left: 2,
    })
    await expect(metapoolVenue.positions?.(ME)).resolves.toEqual([
      { slot: 'cooling', symbol: 'NEAR', amount: '1', readyInHours: 15 },
    ])
    fake.views[`${RNEAR_CONTRACT}.ft_balance_of`] = '0'
    fake.views[`${RNEAR_CONTRACT}.get_account_details`] = rnearAccount({
      unstaked_balance: ONE,
      unstaked_available_epoch_height: 103,
      can_withdraw: false,
    })
    await expect(rnearVenue.positions?.(ME)).resolves.toEqual([
      { slot: 'cooling', symbol: 'NEAR', amount: '1', readyInHours: 22 },
    ])
  })

  it('shows a finished wait as claimable, unless the contract has not got the money yet', async () => {
    fake.views[`${METAPOOL_CONTRACT}.get_account_info`] = metaAccount({
      st_near: '0',
      unstaked: ONE,
    })
    await expect(metapoolVenue.positions?.(ME)).resolves.toEqual([
      { slot: 'claimable', symbol: 'NEAR', amount: '1' },
    ])
    fake.views[`${METAPOOL_CONTRACT}.get_contract_state`] = { retrieved_for_unstake_claims: '0' }
    await expect(metapoolVenue.positions?.(ME)).resolves.toEqual([
      { slot: 'cooling', symbol: 'NEAR', amount: '1', readyInHours: undefined },
    ])

    fake.views[`${RNEAR_CONTRACT}.ft_balance_of`] = '0'
    fake.views[`${RNEAR_CONTRACT}.get_account_details`] = rnearAccount({ unstaked_balance: ONE })
    await expect(rnearVenue.positions?.(ME)).resolves.toEqual([
      { slot: 'claimable', symbol: 'NEAR', amount: '1' },
    ])
    fake.contractBalance = ONE
    await expect(rnearVenue.positions?.(ME)).resolves.toEqual([
      { slot: 'cooling', symbol: 'NEAR', amount: '1', readyInHours: undefined },
    ])
  })

  it('ignores the dust a stake leaves in the unstaked balance', async () => {
    fake.views[`${RNEAR_CONTRACT}.get_account_details`] = rnearAccount({
      unstaked_balance: '9999999999999999999',
    })
    await expect(rnearVenue.positions?.(ME)).resolves.toEqual([
      { slot: 'staked', symbol: 'rNEAR', amount: '2' },
    ])
  })

  it('throws when it cannot read, and never reads as empty', async () => {
    fake.down = true
    await expect(metapoolVenue.positions?.(ME)).rejects.toThrow()
    await expect(rnearVenue.positions?.(ME)).rejects.toThrow()
    fake.down = false
    delete fake.views[`${METAPOOL_CONTRACT}.get_account_info`]
    await expect(metapoolVenue.positions?.(ME)).rejects.toThrow()
  })
})

describe('claiming what an unstake left waiting', () => {
  const claim = (tokenIn = 'NEAR'): ChainActionRequest => ({
    kind: 'claim',
    amount: 'all',
    tokenIn,
  })

  it('collects it with the one method that pays the caller', async () => {
    fake.views[`${METAPOOL_CONTRACT}.get_account_info`] = metaAccount({ unstaked: ONE })
    const meta = await metapoolVenue.prepare(claim(), ME)
    expect(call(meta)).toEqual({
      receiverId: METAPOOL_CONTRACT,
      params: {
        methodName: 'withdraw_unstaked',
        args: {},
        gas: '100000000000000',
        deposit: '0',
      },
    })
    expect(() => metapoolVenue.assertSafe(meta.signing, ME)).not.toThrow()

    fake.views[`${RNEAR_CONTRACT}.get_account_details`] = rnearAccount({ unstaked_balance: ONE })
    const rnear = await rnearVenue.prepare(claim(), ME)
    expect(call(rnear).params).toMatchObject({ methodName: 'withdraw_all', args: {}, deposit: '0' })
    expect(() => rnearVenue.assertSafe(rnear.signing, ME)).not.toThrow()
  })

  it('says how long is left', async () => {
    fake.views[`${METAPOOL_CONTRACT}.get_account_info`] = metaAccount({
      unstaked: ONE,
      can_withdraw: false,
      unstake_full_epochs_wait_left: 3,
    })
    await expect(metapoolVenue.prepare(claim(), ME)).rejects.toThrow(
      /isn't ready yet.*about 22 hours.*Nothing was signed or sent/
    )
  })

  it('says so when the wait is over but the money is not back', async () => {
    fake.views[`${METAPOOL_CONTRACT}.get_account_info`] = metaAccount({ unstaked: ONE })
    fake.views[`${METAPOOL_CONTRACT}.get_contract_state`] = { retrieved_for_unstake_claims: '0' }
    await expect(metapoolVenue.prepare(claim(), ME)).rejects.toThrow(/validators/)
  })

  it('refuses when nothing is waiting, or for a token it does not pay', async () => {
    await expect(metapoolVenue.prepare(claim(), ME)).rejects.toThrow(/nothing unstaked waiting/)
    await expect(metapoolVenue.prepare(claim('USDC'), ME)).rejects.toThrow(/pays out NEAR/)
  })
})

describe('the allowlist for a stake exit', () => {
  const exit = (
    method: string,
    args: Record<string, unknown> = {},
    deposit = '0',
    gas = '100000000000000'
  ): NearTransaction['actions'][number] => ({
    type: 'FunctionCall',
    params: { methodName: method, args, gas, deposit },
  })
  const payload = (
    actions: NearTransaction['actions'],
    receiverId = METAPOOL_CONTRACT
  ): SigningPayload => ({ family: 'near', transactions: [{ receiverId, actions }] })
  const refused = (value: SigningPayload, check = assertMetapoolSafe) =>
    expect(() => check(value, ME)).toThrow(ChainActionRefused)

  it('takes each exit and nothing wider', () => {
    expect(() => assertMetapoolSafe(payload([exit('unstake_all')]), ME)).not.toThrow()
    expect(() => assertMetapoolSafe(payload([exit('withdraw_unstaked')]), ME)).not.toThrow()
    expect(() => assertMetapoolSafe(payload([exit('unstake', { amount: '5' })]), ME)).not.toThrow()
    for (const method of ['withdraw_all', 'withdraw', 'liquid_unstake', 'nslp_remove_liquidity']) {
      refused(payload([exit(method, method === 'withdraw' ? { amount: '5' } : {})]))
    }
    refused(payload([exit('withdraw_unstaked', {}, '0')], RNEAR_CONTRACT), assertRnearSafe)
    expect(() =>
      assertRnearSafe(
        payload([exit('withdraw_all', {}, '0', '200000000000000')], RNEAR_CONTRACT),
        ME
      )
    ).not.toThrow()
  })

  it('refuses a tampered exit', () => {
    refused(payload([exit('unstake_all')], 'evil.near'))
    refused(payload([exit('unstake_all', {}, '1')]))
    refused(payload([exit('unstake_all', { account_id: 'evil.near' })]))
    refused(payload([exit('unstake_all', {}, '0', '100000000000001')]))
    refused(payload([exit('unstake', { amount: '0' })]))
    refused(payload([exit('unstake', { amount: '-1' })]))
    refused(payload([exit('unstake', { amount: '5', beneficiary: 'evil.near' })]))
    refused(payload([exit('unstake', {})]))
    refused(payload([exit('unstake_all'), exit('unstake_all')]))
    refused(payload([exit('deposit_and_stake', {}, ONE), exit('unstake_all')]))
  })
})

describe('taking money out of 1Click Earn', () => {
  const SHARES = '2000000000000000000'
  const withdraw = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
    kind: 'withdraw',
    amount: '2',
    tokenIn: 'USDC',
    ...over,
  })

  it('reads shares and waiting USDC from the NEAR Intents contract', async () => {
    fake.balances[VAULT] = SHARES
    fake.balances[USDC_ASSET] = '500000'
    await expect(earnVenue.positions?.(ME)).resolves.toEqual([
      { slot: 'supplied', symbol: 'USDC', amount: '2' },
      { slot: 'claimable', symbol: 'USDC', amount: '0.5' },
    ])
  })

  it('reads as empty only when both balances are read as zero', async () => {
    await expect(earnVenue.positions?.(ME)).resolves.toEqual([])
    expect(fake.quotes).toEqual([])
  })

  it('throws when the chain or the price cannot be read', async () => {
    fake.down = true
    await expect(earnVenue.positions?.(ME)).rejects.toThrow()
    fake.down = false
    fake.balances[VAULT] = SHARES
    fake.quotesDown = true
    await expect(earnVenue.positions?.(ME)).rejects.toThrow(/isn't offering this route/)
  })

  it('sells every share when it is the whole position, from and back to the balance', async () => {
    fake.balances[VAULT] = SHARES
    const prepared = await earnVenue.prepare(withdraw({ wholePosition: true }), ME)
    expect(call(prepared)).toEqual({
      receiverId: INTENTS_CONTRACT,
      params: {
        methodName: 'mt_transfer',
        args: { receiver_id: DEPOSIT, token_id: VAULT, amount: SHARES },
        gas: '100000000000000',
        deposit: '1',
      },
    })
    expect(() => earnVenue.assertSafe(prepared.signing, ME)).not.toThrow()
    expect(prepared.kind).toBe('withdraw')
    expect(prepared.context).toMatchObject({ depositAddress: DEPOSIT })
    expect(prepared.notes.join(' ')).toMatch(/first of two steps.*claim my USDC/)
    for (const request of fake.quotes) {
      expect(request).toMatchObject({
        depositType: 'INTENTS',
        refundType: 'INTENTS',
        recipientType: 'INTENTS',
        refundTo: ME,
        recipient: ME,
        originAsset: VAULT,
        destinationAsset: USDC_ASSET,
        amount: SHARES,
      })
    }
    expect(fake.quotes.at(-1)).toMatchObject({ dry: false })
  })

  it('sells only the share of the position that was asked for', async () => {
    fake.balances[VAULT] = SHARES
    const prepared = await earnVenue.prepare(withdraw({ amount: '0.5' }), ME)
    expect(call(prepared).params?.args).toMatchObject({ amount: '500000000000000000' })
  })

  it('refuses more than the position is worth, nothing held, and other tokens', async () => {
    fake.balances[VAULT] = SHARES
    await expect(earnVenue.prepare(withdraw({ amount: '3' }), ME)).rejects.toThrow(
      /worth about 2 USDC/
    )
    await expect(earnVenue.prepare(withdraw({ tokenIn: 'USDT' }), ME)).rejects.toThrow(
      /pays out in USDC/
    )
    delete fake.balances[VAULT]
    await expect(earnVenue.prepare(withdraw(), ME)).rejects.toThrow(/nothing in 1Click Earn/)
    await expect(earnVenue.prepare(withdraw(), 'not a near account!')).rejects.toThrow(
      /not a NEAR account/
    )
  })

  it('does not build a sale 1Click will not quote', async () => {
    fake.balances[VAULT] = SHARES
    fake.quotesDown = true
    await expect(earnVenue.prepare(withdraw({ wholePosition: true }), ME)).rejects.toThrow(
      /isn't offering this route.*Nothing was signed or sent/
    )
  })
})

describe('bringing USDC out of the NEAR Intents balance', () => {
  const claim: ChainActionRequest = { kind: 'claim', amount: 'all', tokenIn: 'USDC' }

  it('needs only the contract, and pays only the signer', async () => {
    fake.balances[USDC_ASSET] = '2500000'
    fake.quotesDown = true
    const prepared = await earnVenue.prepare(claim, ME)
    expect(call(prepared)).toEqual({
      receiverId: INTENTS_CONTRACT,
      params: {
        methodName: 'ft_withdraw',
        args: { token: USDC_NEAR, receiver_id: ME, amount: '2500000' },
        gas: '100000000000000',
        deposit: '1',
      },
    })
    expect(fake.quotes).toEqual([])
    expect(() => earnVenue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('registers someone who entered with USDT and has never held USDC', async () => {
    fake.balances[USDC_ASSET] = '2500000'
    fake.views[`${USDC_NEAR}.storage_balance_of`] = null
    const prepared = await earnVenue.prepare(claim, ME)
    const [first, second] = txs(prepared)
    expect(first?.receiverId).toBe(USDC_NEAR)
    expect((first?.actions[0] as NearFunctionCall | undefined)?.params.methodName).toBe(
      'storage_deposit'
    )
    expect(second?.receiverId).toBe(INTENTS_CONTRACT)
    expect(() => earnVenue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('refuses when nothing is waiting', async () => {
    await expect(earnVenue.prepare(claim, ME)).rejects.toThrow(/no USDC waiting/)
  })

  it('reaches here through the shared route, sized by the venue', async () => {
    fake.balances[USDC_ASSET] = '2500000'
    const nearOnly = {
      chain: 'near',
      tokens: [{ symbol: 'USDC', id: USDC_NEAR, decimals: 6 }],
      venues: [earnVenue],
      defaultVenue: {},
      priceUsd: async () => 1,
      balances: async () => ({ tokens: [], complete: true }),
    } as unknown as ChainModule
    const prepared = await prepareChainAction(nearOnly, claim, ME)
    expect(prepared.kind).toBe('claim')
  })
})

describe('the allowlist for an Earn exit', () => {
  const sale = (over: Record<string, unknown> = {}, deposit = '1', gas = '100000000000000') => ({
    type: 'FunctionCall' as const,
    params: {
      methodName: 'mt_transfer',
      args: { receiver_id: DEPOSIT, token_id: VAULT, amount: '5', ...over },
      gas,
      deposit,
    },
  })
  const withdrawal = (over: Record<string, unknown> = {}, deposit = '1') => ({
    type: 'FunctionCall' as const,
    params: {
      methodName: 'ft_withdraw',
      args: { token: USDC_NEAR, receiver_id: ME, amount: '5', ...over },
      gas: '100000000000000',
      deposit,
    },
  })
  const on = (actions: NearTransaction['actions'], receiverId = INTENTS_CONTRACT) => ({
    receiverId,
    actions,
  })
  const near = (...transactions: NearTransaction[]): SigningPayload => ({
    family: 'near',
    transactions,
  })
  const refused = (payload: SigningPayload) =>
    expect(() => earnVenue.assertSafe(payload, ME)).toThrow(ChainActionRefused)

  it('takes what it builds', () => {
    expect(() => earnVenue.assertSafe(near(on([sale()])), ME)).not.toThrow()
    expect(() => earnVenue.assertSafe(near(on([withdrawal()])), ME)).not.toThrow()
  })

  it('refuses a tampered sale', () => {
    refused(near(on([sale({ receiver_id: 'evil.near' })])))
    refused(near(on([sale({ receiver_id: ME })])))
    refused(near(on([sale({ token_id: USDC_ASSET })])))
    refused(near(on([sale({ amount: '0' })])))
    refused(near(on([sale({ memo: 'x' })])))
    refused(near(on([sale({}, '2')])))
    refused(near(on([sale({}, '1', '100000000000001')])))
    refused(near(on([sale(), sale()])))
    refused(near(on([sale()]), on([sale()])))
  })

  it('refuses a withdrawal that pays anyone else or calls anything else', () => {
    refused(near(on([withdrawal({ receiver_id: 'evil.near' })])))
    refused(near(on([withdrawal({ token: 'wrap.near' })])))
    refused(near(on([withdrawal({ msg: 'call me' })])))
    refused(near(on([withdrawal({ memo: 'WITHDRAW_TO:0xabc' })])))
    refused(near(on([withdrawal({}, '0')])))
    const swapped = withdrawal()
    swapped.params.methodName = 'mt_withdraw'
    refused(near(on([swapped])))
    swapped.params.methodName = 'execute_intents'
    refused(near(on([swapped])))
  })

  it('takes a registration first only if it is for the signer on USDC', () => {
    const register = (accountId: string, receiverId = USDC_NEAR) =>
      on(
        [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'storage_deposit',
              args: { account_id: accountId, registration_only: true },
              gas: '30000000000000',
              deposit: '1250000000000000000000',
            },
          },
        ],
        receiverId
      )
    expect(() => earnVenue.assertSafe(near(register(ME), on([withdrawal()])), ME)).not.toThrow()
    refused(near(register('evil.near'), on([withdrawal()])))
    refused(near(register(ME, 'wrap.near'), on([withdrawal()])))
    refused(near(on([withdrawal()]), on([withdrawal()])))
    refused(near(register(ME), register(ME), on([withdrawal()])))
  })

  it('still refuses what it refused before', () => {
    refused(near(on([sale()], 'evil.near')))
  })
})

describe('confirming an exit', () => {
  const executed = (status: unknown, receiver: string, method: string, args: object = {}) => ({
    status,
    transaction: {
      signer_id: ME,
      receiver_id: receiver,
      actions: [
        {
          FunctionCall: {
            method_name: method,
            args: Buffer.from(JSON.stringify(args)).toString('base64'),
            deposit: '0',
          },
        },
      ],
    },
  })

  async function stakeResult(venueId: string) {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    const pending = confirmStake({
      account: ME,
      venueId,
      signed: { family: 'near', hashes: [HASH] },
    })
    await vi.runAllTimersAsync()
    return pending
  }

  async function earnResult() {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    const pending = earnVenue.submit?.({
      account: ME,
      venueId: '1click-earn',
      signed: { family: 'near', hashes: [HASH] },
      context: { step: 'claim' },
    })
    await vi.runAllTimersAsync()
    return pending
  }

  it.each([
    ['metapool', METAPOOL_CONTRACT, 'unstake'],
    ['metapool', METAPOOL_CONTRACT, 'unstake_all'],
    ['metapool', METAPOOL_CONTRACT, 'withdraw_unstaked'],
    ['rnear', RNEAR_CONTRACT, 'unstake'],
    ['rnear', RNEAR_CONTRACT, 'unstake_all'],
    ['rnear', RNEAR_CONTRACT, 'withdraw_all'],
  ])('accepts %s %s %s', async (venueId, contract, method) => {
    fake.tx = executed({ SuccessValue: '' }, contract, method)
    await expect(stakeResult(venueId)).resolves.toMatchObject({ ok: true, hash: HASH })
  })

  it('refuses another venue’s method, and says what a failure left behind', async () => {
    fake.tx = executed({ SuccessValue: '' }, METAPOOL_CONTRACT, 'withdraw_all')
    expect(await stakeResult('metapool')).toMatchObject({ ok: false })
    fake.tx = executed({ Failure: {} }, METAPOOL_CONTRACT, 'unstake_all')
    const unstake = await stakeResult('metapool')
    expect(!unstake.ok && unstake.error).toMatch(/unstake failed.*still hold/)
    fake.tx = executed({ Failure: {} }, METAPOOL_CONTRACT, 'withdraw_unstaked')
    const claim = await stakeResult('metapool')
    expect(!claim.ok && claim.error).toMatch(/claim failed.*still waiting/)
  })

  const withdrawn = { token: USDC_NEAR, receiver_id: ME, amount: '5' }

  it('accepts a collection once the balance has dropped', async () => {
    fake.tx = executed({ SuccessValue: '' }, INTENTS_CONTRACT, 'ft_withdraw', withdrawn)
    await expect(earnResult()).resolves.toMatchObject({ ok: true, hash: HASH })
  })

  it('does not call it done when the USDC is still in the balance', async () => {
    fake.tx = executed({ SuccessValue: '' }, INTENTS_CONTRACT, 'ft_withdraw', withdrawn)
    fake.balances[USDC_ASSET] = '5'
    const result = await earnResult()
    expect(result).toMatchObject({ ok: false, pending: true })
    expect(result !== undefined && !result.ok && result.error).toMatch(/still shows/)
  })

  it('refuses a hash that paid someone else', async () => {
    fake.tx = executed({ SuccessValue: '' }, INTENTS_CONTRACT, 'ft_withdraw', {
      ...withdrawn,
      receiver_id: 'evil.near',
    })
    await expect(earnResult()).resolves.toMatchObject({ ok: false, pending: true })
  })
})
