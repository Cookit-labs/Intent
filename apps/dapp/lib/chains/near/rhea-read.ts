import { RHEA_LEND, RHEA_PRICE_ORACLE } from './rhea-safety'
import { viewCall, waitForTransaction, type ExecutedCall } from './rpc'

/** Rhea Lend's own `pyth_price_valid_duration_sec`: an older price would fail there too. */
export const RHEA_PRICE_AGE_SEC = 60

const DEFAULT_RPC_URL = 'https://free.rpc.fastnear.com'
const RECEIPT_TIMEOUT_MS = 8_000

export interface TokenPrice {
  multiplier: bigint
  /** The token's decimals plus the price's own. */
  decimals: number
}

interface RawPrice {
  multiplier: string
  decimals: number
}

export interface PythInfo {
  decimals: number
  fraction_digits: number
  price_identifier: string
  extra_call: string | null
  default_price: RawPrice | null
}

export function readPythInfos(): Promise<Record<string, PythInfo>> {
  return viewCall<Record<string, PythInfo>>(RHEA_LEND, 'get_all_token_pyth_infos')
}

/**
 * A token's price the way Rhea Lend reads it when it checks a position: from the same oracle and
 * feed, in the same units. Throws when there is none, and nothing is ever assumed in its place.
 */
export async function readTokenPrice(
  tokenId: string,
  infos: Record<string, PythInfo>
): Promise<TokenPrice> {
  const info = Object.prototype.hasOwnProperty.call(infos, tokenId) ? infos[tokenId] : undefined
  if (info === undefined) throw new Error(`no price feed for ${tokenId}`)
  if (info.default_price !== null) {
    return {
      multiplier: BigInt(info.default_price.multiplier),
      decimals: info.default_price.decimals,
    }
  }
  const pyth = await viewCall<{ price: string; expo: number } | null>(
    RHEA_PRICE_ORACLE,
    'get_price_no_older_than',
    { price_id: info.price_identifier, age: RHEA_PRICE_AGE_SEC }
  )
  if (pyth === null || BigInt(pyth.price) <= BigInt(0)) throw new Error(`no price for ${tokenId}`)
  const shift = info.fraction_digits + pyth.expo
  let multiplier =
    shift >= 0
      ? BigInt(pyth.price) * BigInt(10) ** BigInt(shift)
      : BigInt(pyth.price) / BigInt(10) ** BigInt(-shift)
  if (info.extra_call !== null) {
    const rate = await viewCall<string>(tokenId, info.extra_call)
    multiplier = (multiplier * BigInt(rate)) / BigInt(10) ** BigInt(24)
  }
  return { multiplier, decimals: info.decimals + info.fraction_digits }
}

/** Dollars per whole token, for comparing values only. Never used to build what gets signed. */
export function usdPerToken(price: TokenPrice, tokenDecimals: number): number {
  return Number(price.multiplier) / 10 ** (price.decimals - tokenDecimals)
}

export interface ReceiptView {
  executor: string
  failed: boolean
  logs: string[]
}

export type Followed =
  | { state: 'unknown' }
  | {
      state: 'success' | 'failed'
      signer: string
      receiver: string
      calls: ExecutedCall[]
      /** What the transaction returned, decoded. For `ft_transfer_call`, the amount the receiver kept. */
      returned: string | undefined
      receipts: ReceiptView[]
    }

interface RawReceipts {
  status?: { SuccessValue?: string }
  receipts_outcome?: {
    outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> }
  }[]
}

async function readReceipts(hash: string, account: string): Promise<RawReceipts | undefined> {
  const configured = process.env['NEAR_RPC_URL']?.trim()
  try {
    const response = await fetch(
      configured === undefined || configured === '' ? DEFAULT_RPC_URL : configured,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'intent',
          method: 'tx',
          params: {
            tx_hash: hash,
            sender_account_id: account,
            wait_until: 'EXECUTED_OPTIMISTIC',
          },
        }),
        signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
      }
    )
    if (!response.ok) return undefined
    const body = (await response.json()) as { result?: RawReceipts }
    return body.result
  } catch {
    return undefined
  }
}

/**
 * A finished transaction, with what its receipts did. A NEAR transaction can report success while
 * the part that mattered failed: a swap the pool refused comes back as a refund, and a call that
 * first fetches prices has already returned before the work runs. So the status alone proves
 * nothing here. A transaction whose receipts can't be read counts as not yet known.
 */
export async function followTransaction(
  hash: string,
  account: string,
  waitMs: number
): Promise<Followed> {
  const outcome = await waitForTransaction(hash, account, waitMs)
  if (outcome.state === 'unknown') return outcome
  const detail = await readReceipts(hash, account)
  if (detail?.receipts_outcome === undefined) return { state: 'unknown' }
  const value = detail.status?.SuccessValue
  return {
    ...outcome,
    returned: value === undefined ? undefined : Buffer.from(value, 'base64').toString('utf8'),
    receipts: detail.receipts_outcome.map(({ outcome: receipt }) => ({
      executor: receipt.executor_id,
      failed: 'Failure' in receipt.status,
      logs: receipt.logs,
    })),
  }
}

/** The amount an `ft_transfer_call` says its receiver kept, or nothing if it said no amount. */
export function amountKept(returned: string | undefined): bigint | undefined {
  if (returned === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(returned)
    return typeof parsed === 'string' && /^\d+$/.test(parsed) ? BigInt(parsed) : undefined
  } catch {
    return undefined
  }
}
