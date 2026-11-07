import { createHmac } from 'node:crypto'

import type { ExecutionFlow } from '../server/execution-flow'
import type { ExecutionKind } from '../server/analytics'
import { sameProof, secret } from './oneclick-origin'
import {
  tokenBySymbol,
  type ChainActionKind,
  type ChainModule,
  type ChainWithActions,
  type PreparedAction,
} from './types'

/**
 * What a prepared action sells, so the usage log can count it once it is sent.
 *
 * The submit route only sees signed bytes, or a hash the wallet already sent, and nothing in either
 * says in a shared shape what was sold. So the server that built the action writes down its kind,
 * what it pays and that payment's dollar value at the time, and signs it. The browser hands it
 * back unchanged at submit; one it changed, or one issued for another wallet, venue or chain, is
 * not believed, and the transaction is still counted, as an unknown one with no value.
 *
 * It is read for the numbers only and never decides what is sent.
 */

interface Receipt {
  kind: ExecutionKind
  assetIn: string
  amountIn: string
  assetOut: string | null
  volumeUsd: number | null
}

/** How each action is counted, so the admin's types mean the same on every chain. */
const LOGGED_KIND: Record<ChainActionKind, ExecutionKind> = {
  swap: 'swap',
  send: 'send',
  pay_invoice: 'send',
  stream: 'send',
  limit: 'offer',
  supply: 'lend',
  stake: 'lend',
  repay: 'lend',
  withdraw: 'withdraw',
  unstake: 'withdraw',
  borrow: 'borrow',
  claim: 'claim',
  cancel: 'cancel',
  invoice: 'invoice',
}

/** Every kind a receipt can name. A wrap, approval or storage step before an order is only `setup`. */
const RECEIPT_KINDS: ReadonlySet<string> = new Set([...Object.values(LOGGED_KIND), 'setup'])

const PRICE_MS = 1_500

function sign(key: string, chain: string, account: string, venueId: string, body: string): string {
  return createHmac('sha256', key)
    .update(`execution-receipt:${JSON.stringify([chain, account, venueId, body])}`)
    .digest('base64url')
}

async function valueOf(
  chainApi: ChainModule,
  symbol: string,
  amount: string
): Promise<number | null> {
  const token = tokenBySymbol(chainApi.tokens, symbol)
  const units = Number(amount)
  if (token === undefined || !Number.isFinite(units)) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const price = await Promise.race([
      chainApi.priceUsd(token),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), PRICE_MS)
      }),
    ])
    return price === undefined ? null : Math.round(units * price * 100) / 100
  } catch {
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The action with its receipt attached, or unchanged where this deployment has no key to sign with. */
export async function withReceipt(
  chainApi: ChainModule,
  account: string,
  prepared: PreparedAction,
  env: Record<string, string | undefined> = process.env
): Promise<PreparedAction> {
  const key = secret(env)
  if (key === undefined) return prepared
  const receipt: Receipt = {
    kind: prepared.thenPrepareAgain === true ? 'setup' : LOGGED_KIND[prepared.kind],
    assetIn: prepared.pay.symbol,
    amountIn: prepared.pay.amount,
    assetOut: prepared.receive?.symbol ?? null,
    volumeUsd: await valueOf(chainApi, prepared.pay.symbol, prepared.pay.amount),
  }
  const body = Buffer.from(JSON.stringify(receipt)).toString('base64url')
  const proof = sign(key, chainApi.chain, account, prepared.venueId, body)
  return { ...prepared, receipt: `${body}.${proof}` }
}

function isReceipt(value: unknown): value is Receipt {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r['kind'] === 'string' &&
    RECEIPT_KINDS.has(r['kind']) &&
    typeof r['assetIn'] === 'string' &&
    typeof r['amountIn'] === 'string' &&
    /^\d+(\.\d+)?$/.test(r['amountIn']) &&
    (r['assetOut'] === null || typeof r['assetOut'] === 'string') &&
    (r['volumeUsd'] === null ||
      (typeof r['volumeUsd'] === 'number' && Number.isFinite(r['volumeUsd'])))
  )
}

/** How the log records a submitted action: its kind, and what it sold when its receipt is this server's. */
export function loggedAction(
  chain: ChainWithActions,
  account: string,
  venueId: string,
  receipt: string | undefined,
  env: Record<string, string | undefined> = process.env
): { kind: ExecutionKind; flow?: ExecutionFlow } {
  const key = secret(env)
  const [body, proof, extra] = (receipt ?? '').split('.')
  if (key === undefined || body === undefined || proof === undefined || extra !== undefined) {
    return { kind: 'unknown' }
  }
  if (!sameProof(proof, sign(key, chain, account, venueId, body))) return { kind: 'unknown' }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { kind: 'unknown' }
  }
  if (!isReceipt(parsed)) return { kind: 'unknown' }
  return {
    kind: parsed.kind,
    flow: {
      assetIn: parsed.assetIn,
      amountIn: parsed.amountIn,
      assetOut: parsed.assetOut,
      volumeUsd: parsed.volumeUsd,
    },
  }
}
