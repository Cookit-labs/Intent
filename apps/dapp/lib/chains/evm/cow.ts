import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import { z } from 'zod'

import { limitOutput, limitPair, type LimitBook, type RestingOrder } from '../limit'
import { fromBase } from '../sequence'
import {
  ChainActionRefused,
  toBaseUnits,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SubmitInput,
  type SubmitResult,
} from '../types'
import { evmClient, type EvmReceipt } from './client'
import {
  COW_APP_DATA,
  COW_APP_DATA_HASH,
  COW_BUY_NATIVE,
  COW_CHAIN_ID,
  COW_ORDER_LIFETIME_S,
  COW_SETTLEMENT,
  COW_VAULT_RELAYER,
  cowAssertSafe,
  cowOrder,
  cowOrderUid,
  cowTypedData,
  isCowOrderUid,
  SETTLEMENT_ABI,
  uidOwner,
  viemTypedData,
  WAVAX,
  type CowOrder,
} from './cow-rules'
import { EVM_HASH, sameAddress } from './submit'
import { AVALANCHE_TOKENS, EVM_NATIVE_ID, evmExplorerUrl } from './tokens'

/**
 * Read off mainnet on 5 November 2026, quoting only (`evm-cow.live.test.ts`):
 *
 * 1. An owner's orders are at `GET /account/{owner}/orders`, as the research guessed. `/orders?owner=`
 *    answers 405.
 * 2. Buying native AVAX through `0xEeee…` quotes, and real orders bought it that way and filled, so a
 *    purchase pays out in AVAX, not WAVAX.
 */

export const COW_VENUE_ID = 'cow-limit'
const VENUE_NAME = 'CoW Protocol'
const API = 'https://api.cow.fi/avalanche/api/v1'
const EXPLORER = 'https://explorer.cow.fi/avax/orders/'
const API_TIMEOUT_MS = 8_000
/** Orders closed longer ago than this are left out of the book. */
const SHOWN_AFTER_CLOSE_S = 7 * 86_400

const NOTES = [
  'Your funds stay in your wallet until a solver fills this at your price or better.',
  'Expires in 7 days.',
  'Avalanche has few CoW solvers trading right now, so it may not fill.',
  'Cancelling costs a small network fee.',
]
const APPROVAL_NOTE =
  'This lets CoW move exactly this amount and no more. Cancelling doesn’t remove it.'
const WRAP_NOTE = 'CoW trades WAVAX, not AVAX, so what doesn’t sell stays in your wallet as WAVAX.'
const TOO_SMALL = "That is too small for CoW's solvers to fill. Try a few dollars more."

const Amount = z.string().regex(/^\d+$/)
const ApiError = z.object({ errorType: z.string() })
const Uid = z.string().regex(/^0x[0-9a-fA-F]{112}$/)

const ApiOrder = z.object({
  uid: Uid,
  owner: z.string(),
  sellToken: z.string(),
  buyToken: z.string(),
  sellAmount: Amount,
  buyAmount: Amount,
  validTo: z.number().int(),
  executedSellAmount: Amount,
  executedBuyAmount: Amount,
  status: z.string(),
})

type ApiOrder = z.infer<typeof ApiOrder>

function refused(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

function assertAccount(account: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) refused('That is not an Avalanche wallet address.')
  return getAddress(account.toLowerCase())
}

async function cowApi(path: string, init?: { method: string; body: unknown }): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(init !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
}

async function errorType(response: Response): Promise<string | undefined> {
  const parsed = ApiError.safeParse(await response.json().catch(() => undefined))
  return parsed.success ? parsed.data.errorType : undefined
}

function tableToken(symbol: string): ChainToken {
  const token = tokenBySymbol(AVALANCHE_TOKENS, symbol)
  if (token === undefined) refused(`I can't trade ${symbol} on CoW.`)
  return token
}

/** What CoW names each side: wrapped AVAX to sell, the chain's own coin to buy. */
function cowAddress(token: ChainToken, side: 'sell' | 'buy'): string {
  if (token.id !== EVM_NATIVE_ID) return token.id
  return side === 'sell' ? WAVAX : COW_BUY_NATIVE
}

/** A quote creates no order. It is asked so an order CoW can't fill is never set up or signed. */
async function assertQuotable(
  order: Pick<CowOrder, 'sellToken' | 'buyToken' | 'sellAmount'>,
  account: Address
): Promise<void> {
  let response: Response
  try {
    response = await cowApi('/quote', {
      method: 'POST',
      body: {
        sellToken: order.sellToken,
        buyToken: order.buyToken,
        from: account,
        receiver: account,
        kind: 'sell',
        sellAmountBeforeFee: order.sellAmount,
        appData: COW_APP_DATA,
        appDataHash: COW_APP_DATA_HASH,
        partiallyFillable: true,
        sellTokenBalance: 'erc20',
        buyTokenBalance: 'erc20',
        signingScheme: 'eip712',
      },
    })
  } catch {
    return refused('I couldn’t reach CoW just now, so try again in a moment.')
  }
  if (response.ok) return
  if ((await errorType(response)) === 'SellAmountDoesNotCoverFee') refused(TOO_SMALL)
  refused('CoW couldn’t price this order just now, so try again in a moment.')
}

async function mustRead<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch {
    return refused('I couldn’t read your wallet on Avalanche just now, so try again in a moment.')
  }
}

async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  const owner = assertAccount(account)
  if (request.kind !== 'limit')
    refused(`${VENUE_NAME} only rests orders. It can’t ${request.kind}.`)
  const pair = limitPair(request.tokenIn, request.tokenOut ?? '')
  if (pair === undefined) refused('CoW orders here need USDC or USDT on one side.')
  const input = tableToken(request.tokenIn)
  const output = tableToken(request.tokenOut ?? '')
  const sellToken = cowAddress(input, 'sell')
  const buyToken = cowAddress(output, 'buy')
  let sellAmount: string
  try {
    sellAmount = toBaseUnits(request.amount, input.decimals)
  } catch (e) {
    if (e instanceof ChainActionRefused) refused(e.message)
    throw e
  }
  const limitPrice = request.limitPrice ?? ''
  const bought = limitOutput(
    request.amount,
    limitPrice,
    pair.selling,
    input.decimals,
    output.decimals
  )
  if (bought === BigInt(0)) refused('That order is too small to place.')
  const buyAmount = bought.toString()

  await assertQuotable({ sellToken, buyToken, sellAmount }, owner)

  const client = evmClient('avalanche')
  const sold = BigInt(sellAmount)
  const wraps = sellToken === WAVAX
  const notes = wraps ? [...NOTES, WRAP_NOTE] : NOTES
  const shared = { venueId: COW_VENUE_ID, venueName: VENUE_NAME, kind: 'limit' as const }

  if (wraps) {
    const held = await mustRead(() => client.tokenBalance(WAVAX, owner))
    if (held < sold) {
      const short = sold - held
      const amount = fromBase(short, input.decimals)
      return {
        ...shared,
        summary: `Wrap ${amount} AVAX into WAVAX, which CoW trades. You approve and sign the order next, and nothing is offered until then.`,
        pay: { amount, symbol: 'AVAX' },
        receive: { amount, symbol: 'WAVAX', approximate: false },
        notes,
        signing: {
          family: 'evm',
          chainId: COW_CHAIN_ID,
          to: WAVAX,
          data: '0xd0e30db0',
          value: short.toString(),
        },
        context: { step: 'wrap', sellToken: WAVAX, amount: sellAmount },
        thenPrepareAgain: true,
      }
    }
  }

  const allowed = await mustRead(() =>
    client.allowance(sellToken as Address, owner, COW_VAULT_RELAYER)
  )
  if (allowed < sold) {
    const symbol = wraps ? 'WAVAX' : input.symbol
    return {
      ...shared,
      summary: `Let CoW move exactly ${request.amount} ${symbol} from your wallet. You sign the order itself next, and nothing is offered until then.`,
      pay: { amount: '0', symbol },
      notes: [APPROVAL_NOTE, ...notes],
      signing: {
        family: 'evm',
        chainId: COW_CHAIN_ID,
        to: sellToken,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [COW_VAULT_RELAYER, sold],
        }),
        value: '0',
      },
      context: { step: 'approve', sellToken, amount: sellAmount },
      thenPrepareAgain: true,
    }
  }

  const validTo = Math.floor(Date.now() / 1000) + COW_ORDER_LIFETIME_S
  const order = cowOrder({ sellToken, buyToken, receiver: owner, sellAmount, buyAmount, validTo })
  const receive = fromBase(bought, output.decimals)
  return {
    ...shared,
    summary: `Offer ${request.amount} ${input.symbol} on CoW for at least ${receive} ${output.symbol}, at ${limitPrice} ${pair.quote} per ${pair.base}.`,
    pay: { amount: request.amount, symbol: input.symbol },
    receive: { amount: receive, symbol: output.symbol, approximate: true },
    notes,
    signing: {
      family: 'evm-typed',
      chainId: COW_CHAIN_ID,
      account: owner,
      typedData: cowTypedData(order),
    },
    context: {
      step: 'order',
      sellToken,
      buyToken,
      sellAmount,
      buyAmount,
      validTo: String(validTo),
    },
  }
}

/** The token an order address names, as the book shows it. WAVAX is not in the table. */
function bookToken(address: string): { symbol: string; decimals: number } | undefined {
  if (sameAddress(address, WAVAX)) return { symbol: 'WAVAX', decimals: 18 }
  if (sameAddress(address, COW_BUY_NATIVE)) return { symbol: 'AVAX', decimals: 18 }
  const token = AVALANCHE_TOKENS.find((t) => t.id !== EVM_NATIVE_ID && sameAddress(t.id, address))
  return token === undefined ? undefined : { symbol: token.symbol, decimals: token.decimals }
}

function bookPrice(
  order: ApiOrder,
  sell: { symbol: string; decimals: number },
  buy: { symbol: string; decimals: number }
): string | undefined {
  const pair = limitPair(sell.symbol === 'WAVAX' ? 'AVAX' : sell.symbol, buy.symbol)
  if (pair === undefined) return undefined
  const given = Number(fromBase(BigInt(order.sellAmount), sell.decimals))
  const got = Number(fromBase(BigInt(order.buyAmount), buy.decimals))
  if (!(given > 0) || !(got > 0)) return undefined
  return String(Number((pair.selling ? got / given : given / got).toPrecision(6)))
}

function restingOrder(order: ApiOrder): RestingOrder | undefined {
  const sell = bookToken(order.sellToken)
  const buy = bookToken(order.buyToken)
  if (sell === undefined || buy === undefined || sell.symbol === 'AVAX') return undefined
  const total = BigInt(order.sellAmount)
  const spent = BigInt(order.executedSellAmount)
  const left = spent >= total ? BigInt(0) : total - spent
  const status: RestingOrder['status'] =
    order.status === 'fulfilled'
      ? 'filled'
      : order.status === 'open' || order.status === 'presignaturePending'
        ? spent > BigInt(0)
          ? 'partly'
          : 'open'
        : 'done'
  const limitPrice = bookPrice(order, sell, buy)
  return {
    id: order.uid.toLowerCase(),
    venueId: COW_VENUE_ID,
    tokenIn: sell.symbol,
    tokenOut: buy.symbol,
    amountIn: fromBase(total, sell.decimals),
    remainingIn: fromBase(status === 'filled' ? BigInt(0) : left, sell.decimals),
    receivedOut: fromBase(BigInt(order.executedBuyAmount), buy.decimals),
    status,
    expiresAt: order.validTo * 1000,
    ...(limitPrice !== undefined ? { limitPrice } : {}),
  }
}

async function openOrders(account: string, signal?: AbortSignal): Promise<RestingOrder[]> {
  const owner = assertAccount(account)
  const response = await fetch(`${API}/account/${owner}/orders?limit=100`, {
    ...(signal !== undefined ? { signal } : {}),
  })
  if (!response.ok) throw new Error(`CoW answered ${response.status} for the account's orders`)
  const rows = z.array(z.unknown()).parse(await response.json())
  const since = Math.floor(Date.now() / 1000) - SHOWN_AFTER_CLOSE_S
  return rows.flatMap((row) => {
    const parsed = ApiOrder.safeParse(row)
    if (!parsed.success || !sameAddress(parsed.data.owner, owner)) return []
    if (parsed.data.validTo < since) return []
    const mapped = restingOrder(parsed.data)
    return mapped === undefined ? [] : [mapped]
  })
}

async function prepareExit(
  account: string,
  orderId: string,
  action: 'cancel' | 'collect'
): Promise<PreparedAction> {
  const owner = assertAccount(account)
  if (action === 'collect') {
    refused('CoW pays what fills straight to your wallet, so there is nothing to collect.')
  }
  if (!isCowOrderUid(orderId)) refused('That is not a CoW order I can change.')
  const uid = orderId.toLowerCase()
  if (!sameAddress(uidOwner(uid), owner)) refused('That order belongs to another wallet.')
  let order: ApiOrder
  try {
    const response = await cowApi(`/orders/${uid}`)
    if (response.status === 404) refused('CoW has no such order.')
    if (!response.ok) throw new Error(`CoW answered ${response.status}`)
    order = ApiOrder.parse(await response.json())
  } catch (e) {
    if (e instanceof ChainActionRefused) throw e
    return refused('I couldn’t read that order on CoW just now, so try again in a moment.')
  }
  if (!sameAddress(order.owner, owner)) refused('That order belongs to another wallet.')
  if (order.uid.toLowerCase() !== uid) refused('That is not a CoW order I can change.')
  if (order.status !== 'open' && order.status !== 'presignaturePending') {
    refused('That order is no longer open, so there is nothing to cancel.')
  }
  return {
    venueId: COW_VENUE_ID,
    venueName: VENUE_NAME,
    kind: 'limit',
    summary: 'Cancel your CoW order on Avalanche for good, on chain.',
    pay: { amount: '0', symbol: 'AVAX' },
    notes: [
      'Cancelling costs a small network fee.',
      'It could fill before this lands. Whatever filled is already in your wallet.',
      'CoW also has a free cancel, but a solver may still fill the order after it. This one is final.',
    ],
    signing: {
      family: 'evm',
      chainId: COW_CHAIN_ID,
      to: COW_SETTLEMENT,
      data: encodeFunctionData({
        abi: SETTLEMENT_ABI,
        functionName: 'invalidateOrder',
        args: [uid as Hex],
      }),
      value: '0',
    },
    context: { orderId: uid },
  }
}

export function cowBook(): LimitBook {
  return { openOrders, prepareExit }
}

const SETUP_SELECTORS = [
  '0xd0e30db0',
  encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [COW_VAULT_RELAYER, BigInt(0)],
  }).slice(0, 10),
  encodeFunctionData({ abi: SETTLEMENT_ABI, functionName: 'invalidateOrder', args: ['0x'] }).slice(
    0,
    10
  ),
]
const CONTRACTS = [
  WAVAX,
  COW_SETTLEMENT,
  ...AVALANCHE_TOKENS.filter((t) => t.id !== EVM_NATIVE_ID).map((t) => t.id),
]

function pending(error: string): SubmitResult {
  return { ok: false, pending: true, error }
}

/**
 * A wrap, an approval or a cancel the wallet already sent. Only a revert of one of this venue's own
 * calls, from this account, proves nothing moved but the gas.
 */
async function confirmTransaction(account: string, hash: string): Promise<SubmitResult> {
  if (!EVM_HASH.test(hash)) {
    return pending(
      "The wallet didn't return a transaction this app can follow. Check your wallet's activity before trying again."
    )
  }
  const client = evmClient('avalanche')
  let receipt: EvmReceipt
  try {
    receipt = await client.waitForReceipt(hash as Hash)
  } catch {
    return pending(
      `This isn't confirmed on Avalanche yet, and it may still land, so don't send it again. Its transaction is ${hash}.`
    )
  }
  const ours =
    sameAddress(receipt.from, account) &&
    receipt.to !== null &&
    CONTRACTS.some((c) => sameAddress(c, receipt.to as string))
  if (!ours) {
    return pending(
      `Transaction ${hash} is not this order's. Check your wallet's activity before trying again.`
    )
  }
  if (receipt.status === 'reverted') {
    let input: string
    try {
      ;({ input } = await client.transaction(hash as Hash))
    } catch {
      return pending(
        `Transaction ${hash} failed, but it couldn't be read. Check your wallet's activity before trying again.`
      )
    }
    if (!SETUP_SELECTORS.includes(input.slice(0, 10).toLowerCase())) {
      return pending(
        `Transaction ${hash} is not this order's. Check your wallet's activity before trying again.`
      )
    }
    return {
      ok: false,
      error: `That failed on Avalanche (${hash}), so nothing moved apart from the gas. You can try again.`,
    }
  }
  return { ok: true, hash, explorerUrl: evmExplorerUrl('avalanche', hash) }
}

/**
 * Posts a signed order. The order is rebuilt from the context and checked again, and the signature
 * must recover to the account, so whatever the browser changed, only what this wallet signed is
 * posted, and only an order this app would have built.
 */
async function postOrder(input: SubmitInput, signature: string): Promise<SubmitResult> {
  const { account, context } = input
  let owner: Address
  let order: CowOrder
  try {
    owner = assertAccount(account)
    if (context?.['step'] !== 'order') refused('That is not an order this app prepared.')
    const validTo = Number(context['validTo'])
    order = cowOrder({
      sellToken: context['sellToken'] ?? '',
      buyToken: context['buyToken'] ?? '',
      receiver: owner,
      sellAmount: context['sellAmount'] ?? '',
      buyAmount: context['buyAmount'] ?? '',
      validTo,
    })
    cowAssertSafe(
      {
        family: 'evm-typed',
        chainId: COW_CHAIN_ID,
        account: owner,
        typedData: cowTypedData(order),
      },
      owner,
      context
    )
  } catch (e) {
    if (e instanceof ChainActionRefused)
      return {
        ok: false,
        error: e.message.replace('Nothing was signed or sent.', 'Nothing was sent.'),
      }
    throw e
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return {
      ok: false,
      error: 'The wallet gave back a signature this app can’t read. Nothing was sent.',
    }
  }
  let signer: string
  try {
    signer = await recoverTypedDataAddress({ ...viemTypedData(order), signature: signature as Hex })
  } catch {
    signer = ''
  }
  if (!sameAddress(signer, owner)) {
    return {
      ok: false,
      error:
        'That signature isn’t from this wallet, so the order was not placed. A smart-contract wallet, such as a Safe, can’t sign a CoW order here yet. Nothing was sent.',
    }
  }

  const uid = cowOrderUid(order, owner)
  let response: Response
  try {
    response = await cowApi('/orders', {
      method: 'POST',
      body: {
        ...order,
        appData: COW_APP_DATA,
        appDataHash: COW_APP_DATA_HASH,
        signingScheme: 'eip712',
        signature,
        from: owner,
      },
    })
  } catch {
    return pending(
      `CoW didn't answer, so the order may or may not be resting. Check your open orders before trying again.`
    )
  }
  if (response.status >= 400 && response.status < 500) {
    const type = await errorType(response)
    if (type === 'SellAmountDoesNotCoverFee')
      return { ok: false, error: `${TOO_SMALL} The order was not placed.` }
    return {
      ok: false,
      error: `CoW didn't take the order${type === undefined ? '' : ` (${type})`}, so nothing is resting.`,
    }
  }
  if (!response.ok) {
    return pending(
      `CoW didn't answer clearly, so the order may or may not be resting. Check your open orders before trying again.`
    )
  }
  const answered = await response.json().catch(() => undefined)
  if (typeof answered !== 'string' || answered.toLowerCase() !== uid) {
    return pending(
      `CoW took an order, but not with the id this app worked out, so it may not be the one you signed. Check your open orders and cancel anything you don't recognise.`
    )
  }
  return { ok: true, hash: uid, explorerUrl: `${EXPLORER}${uid}` }
}

async function submitCow(input: SubmitInput): Promise<SubmitResult> {
  const { signed } = input
  if (signed.family === 'evm-typed') return postOrder(input, signed.signature)
  if (signed.family === 'evm') return confirmTransaction(input.account, signed.hash)
  return { ok: false, error: 'That is not an Avalanche signature.' }
}

export const cowVenue: ChainVenue = {
  id: COW_VENUE_ID,
  name: VENUE_NAME,
  kinds: ['limit'],
  prepare,
  assertSafe: (payload, account, context) => cowAssertSafe(payload, account, context),
  submit: submitCow,
}
