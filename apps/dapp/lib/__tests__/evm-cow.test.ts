import {
  encodeFunctionData,
  erc20Abi,
  hashTypedData,
  keccak256,
  parseAbi,
  toHex,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { avalancheCapabilities, monadCapabilities } from '../chains/evm/capabilities'
import { COW_VENUE_ID, cowBook, cowVenue } from '../chains/evm/cow'

import {
  COW_APP_DATA,
  COW_APP_DATA_HASH,
  COW_BUY_NATIVE,
  COW_DOMAIN,
  COW_ORDER_TYPES,
  COW_SETTLEMENT,
  COW_VAULT_RELAYER,
  cowAssertSafe,
  cowOrder,
  cowOrderUid,
  cowTypedData,
  WAVAX,
  type CowOrder,
  viemTypedData,
} from '../chains/evm/cow-rules'
import { evmDeposit } from '../chains/evm/deposit'
import { avalancheModule, buildEvmVenues, monadModule } from '../chains/evm/module'
import { signTypedOn, type TypedWallet } from '../chains/evm/sign-typed'
import { evmVenues } from '../chains/evm/venues'
import { limitOutput } from '../chains/limit'
import { LIMIT_NOT_HERE } from '../chains/prepare'
import {
  ChainActionRefused,
  type ChainActionRequest,
  type PreparedAction,
  type SigningPayload,
  type SubmitResult,
} from '../chains/types'
import { afterWallet, walletSends } from '../weave/cashout-view'
import { avalancheDeposit } from '../weave/deposit/avalanche'

vi.mock('../server/analytics', () => ({ logExecution: async () => undefined }))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({ reportError: () => undefined }))

const chain = vi.hoisted(() => ({
  tokenBalance: (async () => BigInt(0)) as (token: string, account: string) => Promise<bigint>,
  allowance: (async () => BigInt(0)) as (
    token: string,
    owner: string,
    spender: string
  ) => Promise<bigint>,
  waitForReceipt: (async () => {
    throw new Error('no receipt')
  }) as (hash: string) => Promise<unknown>,
  transaction: (async () => ({ value: BigInt(0), input: '0x' })) as (
    hash: string
  ) => Promise<{ value: bigint; input: string }>,
  code: (async () => '0x') as (account: string) => Promise<string | undefined>,
  reads: [] as string[],
}))

vi.mock('../chains/evm/client', async (original) => {
  const actual = await original<typeof import('../chains/evm/client')>()
  return {
    ...actual,
    evmClient: () => ({
      tokenBalance: (token: string, account: string) => {
        chain.reads.push(`balance ${token}`)
        return chain.tokenBalance(token, account)
      },
      allowance: (token: string, owner: string, spender: string) => {
        chain.reads.push(`allowance ${token} ${spender}`)
        return chain.allowance(token, owner, spender)
      },
      nativeBalance: async () => BigInt(0),
      code: async (account: string) => chain.code(account),
      waitForReceipt: (hash: string) => chain.waitForReceipt(hash),
      transaction: (hash: string) => chain.transaction(hash),
    }),
  }
})

const KEY = `0x${'59'.repeat(32)}` as const
const SIGNER = privateKeyToAccount(KEY)
const ME = SIGNER.address
const THIEF = '0x3333333333333333333333333333333333333333'
const ZERO = '0x0000000000000000000000000000000000000000'
const USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'
const USDT = '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7'
const NOW = Date.parse('2026-11-05T12:00:00Z')
const NOW_S = Math.floor(NOW / 1000)
const DAY = 86_400
const ONE_AVAX = '1000000000000000000'

const SALE: CowOrder = cowOrder({
  sellToken: WAVAX,
  buyToken: USDC,
  receiver: ME,
  sellAmount: ONE_AVAX,
  buyAmount: '9500000',
  validTo: NOW_S + 7 * DAY,
})

function typed(message: CowOrder, account: string = ME): SigningPayload {
  return { family: 'evm-typed', chainId: 43114, account, typedData: cowTypedData(message) }
}

function orderContext(order: CowOrder): Record<string, string> {
  return {
    step: 'order',
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    sellAmount: order.sellAmount,
    buyAmount: order.buyAmount,
    validTo: String(order.validTo),
  }
}

function refusal(work: () => void): string {
  try {
    work()
  } catch (e) {
    expect(e).toBeInstanceOf(ChainActionRefused)
    return (e as Error).message
  }
  throw new Error('expected a refusal')
}

const check = (payload: SigningPayload, context: Record<string, string>, account = ME): void =>
  cowAssertSafe(payload, account, context, NOW)

const evm = (to: string, data: string, value = '0', chainId = 43114): SigningPayload => ({
  family: 'evm',
  chainId,
  to,
  data,
  value,
})

const approve = (spender: string, amount: bigint): string =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as Address, amount] })

const INVALIDATE = parseAbi(['function invalidateOrder(bytes orderUid)'])

describe('the pinned CoW values', () => {
  it('uses the settlement, relayer and wrapped AVAX from the research', () => {
    expect(COW_SETTLEMENT).toBe('0x9008D19f58AAbD9eD0D60971565AA8510560ab41')
    expect(COW_VAULT_RELAYER).toBe('0xC92E8bdf79f0507f65a392b0ab4667716BFE0110')
    expect(WAVAX).toBe('0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7')
    expect(COW_BUY_NATIVE).toBe('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')
    expect(COW_DOMAIN).toEqual({
      name: 'Gnosis Protocol',
      version: 'v2',
      chainId: 43114,
      verifyingContract: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    })
  })

  it('has the Order type whose hash the research pins', () => {
    const fields = COW_ORDER_TYPES.Order.map((f) => `${f.type} ${f.name}`).join(',')
    expect(keccak256(toHex(`Order(${fields})`))).toBe(
      '0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489'
    )
  })

  it('signs the empty app data, with no hooks and no partner fee', () => {
    expect(COW_APP_DATA).toBe('{}')
    expect(COW_APP_DATA_HASH).toBe(keccak256(toHex('{}')))
    expect(SALE.appData).toBe(COW_APP_DATA_HASH)
  })

  it('fills the fixed fields of an order', () => {
    expect(SALE).toEqual({
      sellToken: WAVAX,
      buyToken: USDC,
      receiver: ME,
      sellAmount: ONE_AVAX,
      buyAmount: '9500000',
      validTo: NOW_S + 7 * DAY,
      appData: COW_APP_DATA_HASH,
      feeAmount: '0',
      kind: 'sell',
      partiallyFillable: true,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    })
  })

  it('computes the order id from the digest, the owner and validTo', () => {
    const digest = hashTypedData({
      domain: { ...COW_DOMAIN, verifyingContract: COW_SETTLEMENT as Address },
      types: COW_ORDER_TYPES,
      primaryType: 'Order',
      message: {
        ...SALE,
        sellToken: SALE.sellToken as Address,
        buyToken: SALE.buyToken as Address,
        receiver: SALE.receiver as Address,
        appData: SALE.appData as Address,
        sellAmount: BigInt(SALE.sellAmount),
        buyAmount: BigInt(SALE.buyAmount),
        feeAmount: BigInt(0),
      },
    })
    const uid = cowOrderUid(SALE, ME)
    expect(uid).toBe(
      `${digest}${ME.slice(2).toLowerCase()}${(NOW_S + 7 * DAY).toString(16).padStart(8, '0')}`
    )
    expect(uid).toHaveLength(2 + 112)
  })
})

describe('cowAssertSafe on an order', () => {
  it('passes the order prepare builds', () => {
    expect(() => check(typed(SALE), orderContext(SALE))).not.toThrow()
  })

  it('passes a purchase paid out in native AVAX', () => {
    const buy = cowOrder({
      sellToken: USDC,
      buyToken: COW_BUY_NATIVE,
      receiver: ME,
      sellAmount: '9000000',
      buyAmount: ONE_AVAX,
      validTo: NOW_S + 7 * DAY,
    })
    expect(() => check(typed(buy), orderContext(buy))).not.toThrow()
  })

  it('ends every refusal with nothing signed or sent', () => {
    const message = refusal(() => check(typed({ ...SALE, receiver: THIEF }), orderContext(SALE)))
    expect(message).toMatch(/Nothing was signed or sent\.$/)
  })

  const domainCases: [string, Record<string, unknown>][] = [
    ['another verifying contract', { ...COW_DOMAIN, verifyingContract: THIEF }],
    ['another chain id', { ...COW_DOMAIN, chainId: 1 }],
    ['another domain name', { ...COW_DOMAIN, name: 'Gnosis Protocol v3' }],
    ['another version', { ...COW_DOMAIN, version: 'v1' }],
    ['an extra domain field', { ...COW_DOMAIN, salt: `0x${'0'.repeat(64)}` }],
  ]
  for (const [what, domain] of domainCases) {
    it(`refuses ${what}`, () => {
      const payload = typed(SALE) as Extract<SigningPayload, { family: 'evm-typed' }>
      refusal(() =>
        check({ ...payload, typedData: { ...payload.typedData, domain } }, orderContext(SALE))
      )
    })
  }

  it('refuses a payload for another chain', () => {
    refusal(() => check({ ...typed(SALE), chainId: 1 } as SigningPayload, orderContext(SALE)))
  })

  it('refuses a payload for another account', () => {
    refusal(() => check(typed(SALE, THIEF), orderContext(SALE)))
  })

  it('refuses another primary type or changed types', () => {
    const payload = typed(SALE) as Extract<SigningPayload, { family: 'evm-typed' }>
    refusal(() =>
      check(
        {
          ...payload,
          typedData: { ...payload.typedData, primaryType: 'Permit' as 'Order' },
        },
        orderContext(SALE)
      )
    )
    refusal(() =>
      check(
        {
          ...payload,
          typedData: {
            ...payload.typedData,
            types: { Order: COW_ORDER_TYPES.Order.slice(0, 11) },
          },
        },
        orderContext(SALE)
      )
    )
  })

  it('refuses another receiver, or the zero address', () => {
    refusal(() => check(typed({ ...SALE, receiver: THIEF }), orderContext(SALE)))
    refusal(() => check(typed({ ...SALE, receiver: ZERO }), orderContext(SALE)))
  })

  it('refuses a changed token or amount', () => {
    refusal(() => check(typed({ ...SALE, sellToken: USDT }), orderContext(SALE)))
    refusal(() => check(typed({ ...SALE, buyToken: USDT }), orderContext(SALE)))
    refusal(() => check(typed({ ...SALE, sellAmount: '2000000000000000000' }), orderContext(SALE)))
    refusal(() => check(typed({ ...SALE, buyAmount: '9499999' }), orderContext(SALE)))
  })

  it('refuses a token this app does not trade there, even when the context agrees', () => {
    const odd = { ...SALE, sellToken: THIEF }
    refusal(() => check(typed(odd), orderContext(odd)))
  })

  it('refuses validTo past 8 days or in the past', () => {
    const late = { ...SALE, validTo: NOW_S + 8 * DAY + 1 }
    refusal(() => check(typed(late), orderContext(late)))
    const gone = { ...SALE, validTo: NOW_S - 1 }
    refusal(() => check(typed(gone), orderContext(gone)))
  })

  it('refuses a fee other than "0"', () => {
    refusal(() => check(typed({ ...SALE, feeAmount: '1' }), orderContext(SALE)))
  })

  it('refuses a balance other than erc20', () => {
    refusal(() =>
      check(typed({ ...SALE, sellTokenBalance: 'external' as 'erc20' }), orderContext(SALE))
    )
    refusal(() =>
      check(typed({ ...SALE, buyTokenBalance: 'internal' as 'erc20' }), orderContext(SALE))
    )
  })

  it('refuses non-empty app data', () => {
    refusal(() =>
      check(typed({ ...SALE, appData: keccak256(toHex('{"hooks":{}}')) }), orderContext(SALE))
    )
  })

  it('refuses a buy order, or one that cannot fill in parts', () => {
    refusal(() => check(typed({ ...SALE, kind: 'buy' as 'sell' }), orderContext(SALE)))
    refusal(() => check(typed({ ...SALE, partiallyFillable: false }), orderContext(SALE)))
  })

  it('refuses an extra field in the message', () => {
    refusal(() => check(typed({ ...SALE, hooks: 'x' } as unknown as CowOrder), orderContext(SALE)))
  })

  it('refuses a transaction where an order was prepared', () => {
    refusal(() => check(evm(WAVAX, '0xd0e30db0', '1'), orderContext(SALE)))
  })
})

describe('cowAssertSafe on setup and cancel', () => {
  const wrapContext = { step: 'wrap', sellToken: WAVAX, amount: ONE_AVAX }
  const approveContext = { step: 'approve', sellToken: WAVAX, amount: ONE_AVAX }

  it('passes a deposit into WAVAX of no more than the sale', () => {
    expect(() => check(evm(WAVAX, '0xd0e30db0', ONE_AVAX), wrapContext)).not.toThrow()
    expect(() => check(evm(WAVAX, '0xd0e30db0', '400000000000000000'), wrapContext)).not.toThrow()
  })

  it('refuses a deposit anywhere else, of more, or with other data', () => {
    refusal(() => check(evm(THIEF, '0xd0e30db0', ONE_AVAX), wrapContext))
    refusal(() => check(evm(WAVAX, '0xd0e30db0', '1000000000000000001'), wrapContext))
    refusal(() => check(evm(WAVAX, '0xd0e30db0', '0'), wrapContext))
    refusal(() => check(evm(WAVAX, approve(THIEF, BigInt(1)), ONE_AVAX), wrapContext))
    refusal(() => check(evm(WAVAX, '0xd0e30db0', ONE_AVAX, 143), wrapContext))
  })

  it('passes an exact approval to the vault relayer', () => {
    expect(() =>
      check(evm(WAVAX, approve(COW_VAULT_RELAYER, BigInt(ONE_AVAX))), approveContext)
    ).not.toThrow()
  })

  it('refuses an approval to another spender or of a higher amount', () => {
    refusal(() => check(evm(WAVAX, approve(THIEF, BigInt(ONE_AVAX))), approveContext))
    refusal(() =>
      check(evm(WAVAX, approve(COW_VAULT_RELAYER, BigInt(ONE_AVAX) + BigInt(1))), approveContext)
    )
    refusal(() =>
      check(
        evm(WAVAX, approve(COW_VAULT_RELAYER, BigInt(2) ** BigInt(256) - BigInt(1))),
        approveContext
      )
    )
  })

  it('refuses an approval on another token, carrying value, or on another chain', () => {
    refusal(() => check(evm(USDC, approve(COW_VAULT_RELAYER, BigInt(ONE_AVAX))), approveContext))
    refusal(() =>
      check(evm(WAVAX, approve(COW_VAULT_RELAYER, BigInt(ONE_AVAX)), '1'), approveContext)
    )
    refusal(() =>
      check(evm(WAVAX, approve(COW_VAULT_RELAYER, BigInt(ONE_AVAX)), '0', 143), approveContext)
    )
  })

  it('refuses a step it does not know, and a typed message where a transaction was prepared', () => {
    refusal(() => check(evm(WAVAX, '0xd0e30db0', ONE_AVAX), { step: 'other' }))
    refusal(() => check(typed(SALE), wrapContext))
  })

  const uid = cowOrderUid(SALE, ME)
  const cancel = encodeFunctionData({
    abi: INVALIDATE,
    functionName: 'invalidateOrder',
    args: [uid as `0x${string}`],
  })

  it('passes invalidateOrder on the settlement contract for this account’s order', () => {
    expect(() => check(evm(COW_SETTLEMENT, cancel), { orderId: uid })).not.toThrow()
  })

  it('refuses a cancel of another order, elsewhere, or with value', () => {
    const theirs = cowOrderUid(SALE, THIEF)
    refusal(() => check(evm(COW_SETTLEMENT, cancel), { orderId: theirs }))
    refusal(() => check(evm(THIEF, cancel), { orderId: uid }))
    refusal(() => check(evm(COW_SETTLEMENT, cancel, '1'), { orderId: uid }))
    const other = encodeFunctionData({
      abi: INVALIDATE,
      functionName: 'invalidateOrder',
      args: [theirs as `0x${string}`],
    })
    refusal(() => check(evm(COW_SETTLEMENT, other), { orderId: uid }))
  })
})

const API = 'https://api.cow.fi/avalanche/api/v1'
const NOTES = [
  'Your funds stay in your wallet until a solver fills this at your price or better.',
  'Expires in 7 days.',
  'Avalanche has few CoW solvers trading right now, so it may not fill.',
  'Cancelling costs a small network fee.',
]
const APPROVAL_NOTE =
  'This lets CoW move exactly this amount and no more. Cancelling doesn’t remove it.'
const TOO_SMALL =
  "That is too small for CoW's solvers to fill. Try a few dollars more. Nothing was signed or sent."
const TX = `0x${'a'.repeat(64)}`

interface Call {
  method: string
  url: string
  body: unknown
}

let calls: Call[] = []
let answer: (call: Call) => { status: number; body: unknown } = () => ({ status: 404, body: {} })

const QUOTE_OK = {
  status: 200,
  body: { quote: { sellAmount: ONE_AVAX, buyAmount: '8700000', feeAmount: '1000' } },
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  calls = []
  chain.reads = []
  chain.tokenBalance = async () => BigInt(0)
  chain.allowance = async () => BigInt(0)
  chain.code = async () => '0x'
  chain.waitForReceipt = async () => {
    throw new Error('no receipt')
  }
  answer = (call) =>
    call.url === `${API}/quote`
      ? QUOTE_OK
      : call.url.startsWith(`${API}/account/`)
        ? { status: 200, body: [] }
        : { status: 404, body: {} }
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const { status, body } = answer(call)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const sale = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
  kind: 'limit',
  amount: '1',
  tokenIn: 'AVAX',
  tokenOut: 'USDC',
  limitPrice: '9.5',
  ...over,
})

const purchase = (): ChainActionRequest =>
  sale({ amount: '9', tokenIn: 'USDC', tokenOut: 'AVAX', limitPrice: '8.5' })

async function prepareRefusal(request: ChainActionRequest): Promise<string> {
  try {
    await cowVenue.prepare(request, ME)
  } catch (e) {
    expect(e).toBeInstanceOf(ChainActionRefused)
    return (e as Error).message
  }
  throw new Error('expected a refusal')
}

const safe = (prepared: PreparedAction): void =>
  cowVenue.assertSafe(prepared.signing, ME, prepared.context)

describe('prepare', () => {
  it('is the CoW Protocol venue, for limit orders only', async () => {
    expect(cowVenue.id).toBe('cow-limit')
    expect(COW_VENUE_ID).toBe('cow-limit')
    expect(cowVenue.name).toBe('CoW Protocol')
    expect(cowVenue.kinds).toEqual(['limit'])
    expect(await prepareRefusal(sale({ kind: 'swap' }))).toMatch(/Nothing was signed or sent\.$/)
  })

  it('wraps AVAX first when the wallet has no WAVAX, and asks to prepare again', async () => {
    const prepared = await cowVenue.prepare(sale(), ME)
    expect(prepared.signing).toEqual({
      family: 'evm',
      chainId: 43114,
      to: WAVAX,
      data: '0xd0e30db0',
      value: ONE_AVAX,
    })
    expect(prepared.thenPrepareAgain).toBe(true)
    expect(prepared.pay).toEqual({ amount: '1', symbol: 'AVAX' })
    expect(prepared.context).toEqual({ step: 'wrap', sellToken: WAVAX, amount: ONE_AVAX })
    safe(prepared)
  })

  it('refuses a smart-contract wallet before anything is wrapped or approved', async () => {
    chain.code = async () => '0x6080604052'
    const refusal = await prepareRefusal(sale())
    expect(refusal).toBe(
      'This wallet is a smart contract, and CoW orders here need an ordinary wallet’s signature. Nothing was signed or sent.'
    )
    expect(chain.reads).toEqual([])
  })

  it('does not take a delegated ordinary wallet for a smart contract', async () => {
    chain.code = async () => '0xef0100' + '11'.repeat(20)
    const prepared = await cowVenue.prepare(sale(), ME)
    expect(prepared.kind).toBe('limit')
  })

  it('wraps only what the WAVAX already held falls short by', async () => {
    chain.tokenBalance = async (token) =>
      token.toLowerCase() === WAVAX.toLowerCase() ? BigInt('400000000000000000') : BigInt(0)
    const prepared = await cowVenue.prepare(sale(), ME)
    expect(prepared.signing).toMatchObject({ value: '600000000000000000' })
    expect(prepared.pay).toEqual({ amount: '0.6', symbol: 'AVAX' })
    safe(prepared)
  })

  it('quotes before any setup, so an order too small to fill builds nothing', async () => {
    answer = (call) =>
      call.url === `${API}/quote`
        ? { status: 400, body: { errorType: 'SellAmountDoesNotCoverFee', description: 'x' } }
        : { status: 404, body: {} }
    expect(await prepareRefusal(sale({ amount: '0.0001' }))).toBe(TOO_SMALL)
    expect(chain.reads).toEqual([])
  })

  it('sends the quote what the order will sign', async () => {
    await cowVenue.prepare(sale(), ME)
    expect(calls[0]).toEqual({
      method: 'POST',
      url: `${API}/quote`,
      body: {
        sellToken: WAVAX,
        buyToken: USDC,
        from: ME,
        receiver: ME,
        kind: 'sell',
        sellAmountBeforeFee: ONE_AVAX,
        appData: '{}',
        appDataHash: COW_APP_DATA_HASH,
        partiallyFillable: true,
        sellTokenBalance: 'erc20',
        buyTokenBalance: 'erc20',
        signingScheme: 'eip712',
      },
    })
  })

  const withBook = (rows: Record<string, unknown>[]) => (call: Call) =>
    call.url === `${API}/quote`
      ? QUOTE_OK
      : call.url.startsWith(`${API}/account/${ME}/orders`)
        ? { status: 200, body: rows }
        : { status: 404, body: {} }

  it('refuses a new order while one selling the same token is open', async () => {
    chain.tokenBalance = async () => BigInt(ONE_AVAX)
    chain.allowance = async () => BigInt(ONE_AVAX)
    const blocked =
      'You already have an open CoW order selling AVAX. Cancel it or wait for it to fill before placing another. Nothing was signed or sent.'
    answer = withBook([apiOrder()])
    expect(await prepareRefusal(sale())).toBe(blocked)
    answer = withBook([apiOrder({ executedSellAmount: '1', executedBuyAmount: '1' })])
    expect(await prepareRefusal(sale())).toBe(blocked)
    answer = withBook([apiOrder({ status: 'presignaturePending' })])
    expect(await prepareRefusal(sale())).toBe(blocked)
    expect(chain.reads).toEqual([])
  })

  it('refuses at every step, not only at the order, so no setup leans on a shared allowance', async () => {
    answer = withBook([apiOrder()])
    expect(await prepareRefusal(sale())).toMatch(/^You already have an open CoW order/)
    chain.tokenBalance = async () => BigInt(ONE_AVAX)
    expect(await prepareRefusal(sale())).toMatch(/^You already have an open CoW order/)
  })

  it('places an order beside closed ones, or beside one selling another token', async () => {
    chain.tokenBalance = async () => BigInt(ONE_AVAX)
    chain.allowance = async () => BigInt(ONE_AVAX)
    answer = withBook([
      apiOrder({ status: 'fulfilled' }),
      apiOrder({ status: 'cancelled' }),
      apiOrder({ status: 'expired' }),
      apiOrder({ sellToken: USDC.toLowerCase(), buyToken: COW_BUY_NATIVE.toLowerCase() }),
    ])
    expect((await cowVenue.prepare(sale(), ME)).signing.family).toBe('evm-typed')
  })

  it('refuses when the open orders can’t be read, since it can’t tell', async () => {
    answer = (call) =>
      call.url === `${API}/quote`
        ? QUOTE_OK
        : call.url.startsWith(`${API}/account/`)
          ? { status: 503, body: {} }
          : { status: 404, body: {} }
    expect(await prepareRefusal(sale())).toMatch(
      /couldn’t check your open CoW orders.*Nothing was signed or sent\.$/
    )
    expect(chain.reads).toEqual([])
  })

  it('refuses in words when CoW cannot be reached', async () => {
    answer = () => ({ status: 503, body: {} })
    expect(await prepareRefusal(sale())).toMatch(/CoW.*Nothing was signed or sent\.$/)
  })

  it('asks for an exact approval to the vault relayer when the allowance is short', async () => {
    chain.tokenBalance = async () => BigInt(ONE_AVAX)
    chain.allowance = async () => BigInt(5)
    const prepared = await cowVenue.prepare(sale(), ME)
    expect(prepared.signing).toEqual({
      family: 'evm',
      chainId: 43114,
      to: WAVAX,
      data: approve(COW_VAULT_RELAYER, BigInt(ONE_AVAX)),
      value: '0',
    })
    expect(prepared.thenPrepareAgain).toBe(true)
    expect(prepared.notes.slice(0, 5)).toEqual([APPROVAL_NOTE, ...NOTES])
    expect(prepared.context).toEqual({ step: 'approve', sellToken: WAVAX, amount: ONE_AVAX })
    expect(chain.reads).toContain(`allowance ${WAVAX} ${COW_VAULT_RELAYER}`)
    safe(prepared)
  })

  it('returns the order to sign once the chain shows it is funded and approved', async () => {
    chain.tokenBalance = async () => BigInt(ONE_AVAX)
    chain.allowance = async () => BigInt(ONE_AVAX)
    const prepared = await cowVenue.prepare(sale(), ME)
    const buyAmount = limitOutput('1', '9.5', true, 18, 6).toString()
    expect(prepared.signing).toEqual({
      family: 'evm-typed',
      chainId: 43114,
      account: ME,
      typedData: cowTypedData(
        cowOrder({
          sellToken: WAVAX,
          buyToken: USDC,
          receiver: ME,
          sellAmount: ONE_AVAX,
          buyAmount,
          validTo: NOW_S + 7 * DAY,
        })
      ),
    })
    expect(prepared.thenPrepareAgain).toBeUndefined()
    expect(prepared.notes.slice(0, 4)).toEqual(NOTES)
    expect(prepared.receive).toEqual({ amount: '9.5', symbol: 'USDC', approximate: true })
    expect(prepared.venueId).toBe('cow-limit')
    safe(prepared)
  })

  it('buys native AVAX with USDC, with no wrap', async () => {
    chain.allowance = async () => BigInt('9000000')
    const prepared = await cowVenue.prepare(purchase(), ME)
    const message = (prepared.signing as Extract<SigningPayload, { family: 'evm-typed' }>).typedData
      .message
    expect(message).toMatchObject({
      sellToken: USDC,
      buyToken: COW_BUY_NATIVE,
      sellAmount: '9000000',
      buyAmount: limitOutput('9', '8.5', false, 6, 18).toString(),
    })
    expect(prepared.notes).toEqual(NOTES)
    expect(chain.reads).not.toContain(`balance ${WAVAX}`)
    safe(prepared)
  })

  it('never asks for more than the order sells', async () => {
    chain.tokenBalance = async () => BigInt(ONE_AVAX)
    const prepared = await cowVenue.prepare(sale(), ME)
    const data = (prepared.signing as Extract<SigningPayload, { family: 'evm' }>).data
    expect(data).toBe(approve(COW_VAULT_RELAYER, BigInt(ONE_AVAX)))
  })
})

async function signed(order: CowOrder, key: `0x${string}` = KEY): Promise<string> {
  return privateKeyToAccount(key).signTypedData(viemTypedData(order))
}

const READY = cowOrder({
  sellToken: WAVAX,
  buyToken: USDC,
  receiver: ME,
  sellAmount: ONE_AVAX,
  buyAmount: '9500000',
  validTo: NOW_S + 7 * DAY,
})

async function submit(
  signature: string,
  context: Record<string, string> = orderContext(READY)
): Promise<SubmitResult> {
  const run = cowVenue.submit
  if (run === undefined) throw new Error('CoW must submit for itself')
  return run({
    account: ME,
    venueId: 'cow-limit',
    signed: { family: 'evm-typed', signature },
    context,
  })
}

describe('submit', () => {
  const uid = cowOrderUid(READY, ME)

  it('posts the signed order and returns its id with the CoW explorer link', async () => {
    answer = (call) =>
      call.url === `${API}/orders` ? { status: 201, body: uid } : { status: 404, body: {} }
    const signature = await signed(READY)
    expect(await submit(signature)).toEqual({
      ok: true,
      hash: uid,
      explorerUrl: `https://explorer.cow.fi/avax/orders/${uid}`,
    })
    expect(calls).toEqual([
      {
        method: 'POST',
        url: `${API}/orders`,
        body: {
          ...READY,
          appData: '{}',
          appDataHash: COW_APP_DATA_HASH,
          signingScheme: 'eip712',
          signature,
          from: ME,
        },
      },
    ])
  })

  it('refuses a signature from another key, and says why a contract wallet fails', async () => {
    const other = `0x${'42'.repeat(32)}` as const
    const out = await submit(await signed(READY, other))
    expect(out).toMatchObject({ ok: false })
    expect((out as { error: string }).error).toMatch(/smart-contract wallet/)
    expect((out as { pending?: boolean }).pending).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('refuses a context changed after signing, since the signature no longer matches', async () => {
    const out = await submit(await signed(READY), {
      ...orderContext(READY),
      buyAmount: '1',
    })
    expect(out).toMatchObject({ ok: false })
    expect(calls).toEqual([])
  })

  it('refuses a signature that is not 65 bytes of hex', async () => {
    expect(await submit('0x1234')).toMatchObject({ ok: false })
    expect(calls).toEqual([])
  })

  it('refuses when CoW answers with another order id', async () => {
    answer = () => ({ status: 201, body: cowOrderUid({ ...READY, buyAmount: '1' }, ME) })
    const out = await submit(await signed(READY))
    expect(out).toMatchObject({ ok: false, pending: true })
  })

  it('reads CoW’s too-small answer in words', async () => {
    answer = () => ({
      status: 400,
      body: { errorType: 'SellAmountDoesNotCoverFee', description: 'x' },
    })
    const out = await submit(await signed(READY))
    expect(out).toMatchObject({ ok: false })
    expect((out as { error: string }).error).toMatch(/^That is too small for CoW's solvers to fill/)
    expect((out as { pending?: boolean }).pending).toBeUndefined()
  })

  it('reads CoW’s DuplicatedOrder as the order already resting, under this app’s id', async () => {
    answer = () => ({ status: 400, body: { errorType: 'DuplicatedOrder', description: 'x' } })
    expect(await submit(await signed(READY))).toEqual({
      ok: true,
      hash: uid,
      explorerUrl: `https://explorer.cow.fi/avax/orders/${uid}`,
    })
  })

  it('says it may have gone through when CoW does not answer', async () => {
    answer = () => ({ status: 502, body: {} })
    expect(await submit(await signed(READY))).toMatchObject({ ok: false, pending: true })
  })

  it('follows a setup transaction the wallet sent, from this account to CoW’s contracts', async () => {
    chain.waitForReceipt = async () => ({ status: 'success', from: ME, to: WAVAX, logs: [] })
    const run = cowVenue.submit as NonNullable<typeof cowVenue.submit>
    const out = await run({
      account: ME,
      venueId: 'cow-limit',
      signed: { family: 'evm', hash: TX },
      context: { step: 'wrap', sellToken: WAVAX, amount: ONE_AVAX },
    })
    expect(out).toEqual({ ok: true, hash: TX, explorerUrl: `https://snowtrace.io/tx/${TX}` })
  })

  it('reads a receipt from someone else, or to another contract, as pending', async () => {
    const run = cowVenue.submit as NonNullable<typeof cowVenue.submit>
    const input = {
      account: ME,
      venueId: 'cow-limit',
      signed: { family: 'evm' as const, hash: TX },
      context: { step: 'wrap', sellToken: WAVAX, amount: ONE_AVAX },
    }
    chain.waitForReceipt = async () => ({ status: 'success', from: THIEF, to: WAVAX, logs: [] })
    expect(await run(input)).toMatchObject({ ok: false, pending: true })
    chain.waitForReceipt = async () => ({ status: 'success', from: ME, to: THIEF, logs: [] })
    expect(await run(input)).toMatchObject({ ok: false, pending: true })
  })

  it('reads a reverted setup transaction as failed, with only gas spent', async () => {
    chain.waitForReceipt = async () => ({ status: 'reverted', from: ME, to: WAVAX, logs: [] })
    chain.transaction = async () => ({ value: BigInt(ONE_AVAX), input: '0xd0e30db0' })
    const run = cowVenue.submit as NonNullable<typeof cowVenue.submit>
    const out = await run({
      account: ME,
      venueId: 'cow-limit',
      signed: { family: 'evm', hash: TX },
      context: { step: 'wrap', sellToken: WAVAX, amount: ONE_AVAX },
    })
    expect(out).toMatchObject({ ok: false })
    expect((out as { pending?: boolean }).pending).toBeUndefined()
  })
})

function apiOrder(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: cowOrderUid(READY, ME),
    owner: ME.toLowerCase(),
    sellToken: WAVAX.toLowerCase(),
    buyToken: USDC.toLowerCase(),
    receiver: ME.toLowerCase(),
    sellAmount: ONE_AVAX,
    buyAmount: '9500000',
    validTo: NOW_S + 7 * DAY,
    executedSellAmount: '0',
    executedBuyAmount: '0',
    status: 'open',
    invalidated: false,
    kind: 'sell',
    ...over,
  }
}

describe('the book', () => {
  const uid = cowOrderUid(READY, ME)

  it('cancels on chain with invalidateOrder on the settlement contract', async () => {
    answer = (call) =>
      call.url === `${API}/orders/${uid}`
        ? { status: 200, body: apiOrder() }
        : { status: 404, body: {} }
    const prepared = await cowBook().prepareExit(ME, uid, 'cancel')
    expect(prepared.signing).toEqual({
      family: 'evm',
      chainId: 43114,
      to: COW_SETTLEMENT,
      data: encodeFunctionData({
        abi: INVALIDATE,
        functionName: 'invalidateOrder',
        args: [uid as `0x${string}`],
      }),
      value: '0',
    })
    expect(prepared.context).toEqual({ orderId: uid })
    expect(prepared.venueId).toBe('cow-limit')
    expect(prepared.notes.join(' ')).toMatch(/network fee/)
    expect(prepared.thenPrepareAgain).toBeUndefined()
    safe(prepared)
  })

  it('refuses an order owned by someone else, before asking CoW', async () => {
    const theirs = cowOrderUid(READY, THIEF)
    await expect(cowBook().prepareExit(ME, theirs, 'cancel')).rejects.toThrow(/another wallet/)
    expect(calls).toEqual([])
  })

  it('refuses when CoW names another owner', async () => {
    answer = () => ({ status: 200, body: apiOrder({ owner: THIEF }) })
    await expect(cowBook().prepareExit(ME, uid, 'cancel')).rejects.toThrow(/another wallet/)
  })

  it('refuses an order that is no longer open', async () => {
    answer = () => ({ status: 200, body: apiOrder({ status: 'fulfilled' }) })
    await expect(cowBook().prepareExit(ME, uid, 'cancel')).rejects.toThrow(ChainActionRefused)
  })

  it('has nothing to collect, as fills arrive in the wallet', async () => {
    await expect(cowBook().prepareExit(ME, uid, 'collect')).rejects.toThrow(
      /straight to your wallet.*Nothing was signed or sent\.$/
    )
  })

  it('reads the account’s orders and maps CoW’s statuses', async () => {
    const uids = [1, 2, 3, 4, 5].map((n) =>
      cowOrderUid({ ...READY, buyAmount: String(9_500_000 + n) }, ME)
    )
    answer = (call) =>
      call.url.startsWith(`${API}/account/${ME}/orders`)
        ? {
            status: 200,
            body: [
              apiOrder({ uid: uids[0] }),
              apiOrder({
                uid: uids[1],
                executedSellAmount: '250000000000000000',
                executedBuyAmount: '2400000',
              }),
              apiOrder({
                uid: uids[2],
                status: 'fulfilled',
                executedSellAmount: ONE_AVAX,
                executedBuyAmount: '9600000',
              }),
              apiOrder({ uid: uids[3], status: 'cancelled' }),
              apiOrder({
                uid: uids[4],
                sellToken: USDC.toLowerCase(),
                buyToken: COW_BUY_NATIVE.toLowerCase(),
                sellAmount: '9000000',
                buyAmount: '1058823529411764706',
                status: 'expired',
              }),
              apiOrder({ uid: `0x${'1'.repeat(112)}`, sellToken: THIEF }),
            ],
          }
        : { status: 404, body: {} }
    const orders = await cowBook().openOrders(ME)
    expect(orders.map((o) => [o.status, o.tokenIn, o.tokenOut])).toEqual([
      ['open', 'WAVAX', 'USDC'],
      ['partly', 'WAVAX', 'USDC'],
      ['filled', 'WAVAX', 'USDC'],
      ['done', 'WAVAX', 'USDC'],
      ['done', 'USDC', 'AVAX'],
    ])
    expect(orders[1]).toMatchObject({
      id: uids[1],
      venueId: 'cow-limit',
      amountIn: '1',
      remainingIn: '0.75',
      receivedOut: '2.4',
      limitPrice: '9.5',
      expiresAt: (NOW_S + 7 * DAY) * 1000,
    })
    expect(orders[2]).toMatchObject({ remainingIn: '0', receivedOut: '9.6' })
    expect(orders[4]).toMatchObject({ limitPrice: '8.5' })
    expect(orders.every((o) => o.collectable === undefined)).toBe(true)
  })

  it('refuses an account that is not an address', async () => {
    await expect(cowBook().openOrders('alice.near')).rejects.toThrow(ChainActionRefused)
  })
})

describe('where CoW runs', () => {
  it('is on Avalanche, with or without 1Click, and never on Monad', () => {
    expect(buildEvmVenues('avalanche', {}).map((v) => v.id)).toEqual(['cow-limit'])
    expect(buildEvmVenues('monad', {}).map((v) => v.id)).toEqual([])
    expect(avalancheModule.venues.some((v) => v.id === 'cow-limit')).toBe(true)
    expect(monadModule.venues.some((v) => v.id === 'cow-limit')).toBe(false)
    expect(avalancheModule.defaultVenue.limit).toBe('cow-limit')
    expect(avalancheModule.limitBook).toBeDefined()
    expect(monadModule.limitBook).toBeUndefined()
    expect(LIMIT_NOT_HERE.avalanche).toBeUndefined()
    expect(LIMIT_NOT_HERE.monad).toBeDefined()
  })

  it('is listed on Avalanche and says what it can do', () => {
    const row = evmVenues.find((v) => v.id === 'cow-limit')
    expect(row).toMatchObject({
      family: 'evm',
      name: 'CoW Protocol',
      category: 'orderbook',
      chains: ['Avalanche'],
      integration: 'executes',
    })
    expect(avalancheCapabilities).toContainEqual({
      kind: 'limit',
      venue: 'CoW Protocol',
      symbol: 'AVAX',
    })
    expect(monadCapabilities.some((c) => c.kind === 'limit')).toBe(false)
  })
})

describe('a typed message meets the rest of the app', () => {
  const payload = typed(READY)

  it('is never something a wallet sends for itself', () => {
    expect(walletSends('evm-typed')).toBe(false)
    expect(afterWallet({ ok: false, reason: 'rejected' }, 'evm-typed')).toEqual({ next: 'review' })
  })

  it('is refused by every other EVM venue’s check', () => {
    const expectation = {
      account: ME,
      depositAddress: THIEF,
      memo: undefined,
      amount: '1',
    }
    expect(() => evmDeposit('avalanche').assertSafe(payload, expectation)).toThrow(
      ChainActionRefused
    )
    expect(() => evmDeposit('monad').assertSafe(payload, expectation)).toThrow(ChainActionRefused)
    expect(() => avalancheDeposit.assertSafe(payload, expectation)).toThrow(ChainActionRefused)
    const env = { AUTH_SECRET: 'x'.repeat(48) }
    for (const venue of [...buildEvmVenues('avalanche', env), ...buildEvmVenues('monad', env)]) {
      if (venue.id === 'cow-limit') continue
      expect(() => venue.assertSafe(payload, ME, {})).toThrow()
    }
  })

  it('is refused, not left pending, by every other EVM venue’s submit', async () => {
    const env = { AUTH_SECRET: 'x'.repeat(48) }
    const others = [...buildEvmVenues('avalanche', env), ...buildEvmVenues('monad', env)].filter(
      (v) => v.id !== 'cow-limit'
    )
    expect(others.length).toBe(4)
    for (const venue of others) {
      const out = await (venue.submit as NonNullable<typeof venue.submit>)({
        account: ME,
        venueId: venue.id,
        signed: { family: 'evm-typed', signature: `0x${'ab'.repeat(65)}` },
      })
      expect(out).toEqual({
        ok: false,
        error: 'That is a signed message, not a transaction, so nothing was sent.',
      })
    }
  })

  async function postSubmit(chainSlug: string, body: unknown): Promise<Response> {
    const { POST } = await import('../../app/api/chain/[chain]/submit/route')
    return POST(
      new Request(`http://localhost/api/chain/${chainSlug}/submit`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ chain: chainSlug }) }
    )
  }

  it('reaches CoW through the submit route on Avalanche', async () => {
    const uid = cowOrderUid(READY, ME)
    answer = (call) =>
      call.url === `${API}/orders` ? { status: 201, body: uid } : { status: 404, body: {} }
    const res = await postSubmit('avalanche', {
      account: ME,
      venueId: 'cow-limit',
      signed: { family: 'evm-typed', signature: await signed(READY) },
      context: orderContext(READY),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, hash: uid })
  }, 30_000)

  it('is refused on a chain that is not EVM', async () => {
    const res = await postSubmit('solana', {
      account: ME,
      venueId: 'jupiter',
      signed: { family: 'evm-typed', signature: '0x00' },
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(calls).toEqual([])
  })
})

describe('signing a typed order in the wallet', () => {
  let asked: unknown[][] = []
  const wallet = (over: Partial<TypedWallet> = {}): TypedWallet => ({
    account: () => ({ status: 'connected', address: ME, chainId: 43114 }),
    switchChain: async (id) => {
      asked.push(['switch', id])
    },
    signTypedData: async (args) => {
      asked.push(['sign', args])
      return `0x${'ab'.repeat(65)}`
    },
    ...over,
  })

  beforeEach(() => {
    asked = []
  })

  const payload = typed(READY)
  const sign = (p: SigningPayload, w: TypedWallet, chainId = 43114) =>
    signTypedOn('Avalanche', chainId, p, w)

  it('passes the checked order to signTypedData, from the account it names', async () => {
    expect(await sign(payload, wallet())).toEqual({
      ok: true,
      signed: { family: 'evm-typed', signature: `0x${'ab'.repeat(65)}` },
    })
    expect(asked).toEqual([['sign', { account: ME, ...viemTypedData(READY) }]])
  })

  it('switches to Avalanche first when the wallet is elsewhere', async () => {
    const out = await sign(
      payload,
      wallet({ account: () => ({ status: 'connected', address: ME, chainId: 143 }) })
    )
    expect(out.ok).toBe(true)
    expect(asked.map((a) => a[0])).toEqual(['switch', 'sign'])
  })

  it('refuses a typed payload for another chain without touching the wallet', async () => {
    expect(await sign({ ...payload, chainId: 143 } as SigningPayload, wallet())).toMatchObject({
      ok: false,
      reason: 'wallet_error',
    })
    expect(await sign(payload, wallet(), 143)).toMatchObject({ ok: false, reason: 'wallet_error' })
    expect(asked).toEqual([])
  })

  it('refuses a typed payload for another account without touching the wallet', async () => {
    const out = await sign(
      payload,
      wallet({ account: () => ({ status: 'connected', address: THIEF, chainId: 43114 }) })
    )
    expect(out).toMatchObject({ ok: false, reason: 'wallet_error' })
    expect(asked).toEqual([])
  })

  it('refuses a message that is not a plain CoW order for this account', async () => {
    const evil = typed({ ...READY, receiver: THIEF })
    expect(await sign(evil, wallet())).toMatchObject({ ok: false, reason: 'wallet_error' })
    expect(asked).toEqual([])
  })

  it('reads a declined signature as rejected', async () => {
    const out = await sign(
      payload,
      wallet({
        signTypedData: async () => {
          throw new Error('User rejected the request.')
        },
      })
    )
    expect(out).toEqual({ ok: false, reason: 'rejected' })
  })
})
