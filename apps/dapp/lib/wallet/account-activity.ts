import { stellarNetwork } from '@intent/config'

/**
 * What a Stellar account holds and what it has done, read from Horizon.
 *
 * The parsers are pure so they can be tested against recorded shapes; the
 * fetchers below them are plain REST, for the same reason `stellar-account`
 * is: a read does not need the SDK.
 */

export interface HorizonBalanceRecord {
  balance: string
  asset_type: string
  asset_code?: string
  asset_issuer?: string
}

export interface Holding {
  code: string
  native: boolean
  issuer?: string
  /** Trimmed of trailing zeros: "12.5", not "12.5000000". */
  balance: string
}

export interface HorizonPaymentRecord {
  id: string
  type: string
  transaction_hash: string
  created_at: string
  from?: string
  to?: string
  amount?: string
  asset_type?: string
  asset_code?: string
  source_amount?: string
  source_asset_type?: string
  source_asset_code?: string
  funder?: string
  account?: string
  starting_balance?: string
}

export type ActivityKind = 'received' | 'sent' | 'swap'

export interface Activity {
  id: string
  kind: ActivityKind
  amount: string
  code: string
  /** For a swap, what was given up. */
  sourceAmount?: string
  sourceCode?: string
  counterparty?: string
  at: string
  hash: string
}

/** "12.5000000" to "12.5", "0.0000000" to "0". */
function trim(amount: string): string {
  if (!amount.includes('.')) return amount
  return amount.replace(/0+$/, '').replace(/\.$/, '')
}

function assetCode(type: string | undefined, code: string | undefined): string {
  return type === 'native' || code === undefined ? 'XLM' : code
}

export function parseHoldings(balances: HorizonBalanceRecord[]): Holding[] {
  const holdings: Holding[] = []
  for (const b of balances) {
    if (b.asset_type === 'liquidity_pool_shares') continue
    const native = b.asset_type === 'native'
    const balance = trim(b.balance)
    if (!native && Number(b.balance) === 0) continue
    holdings.push({
      code: native ? 'XLM' : (b.asset_code ?? '?'),
      native,
      ...(!native && b.asset_issuer !== undefined ? { issuer: b.asset_issuer } : {}),
      balance,
    })
  }
  return holdings.sort(
    (a, b) => Number(b.native) - Number(a.native) || a.code.localeCompare(b.code)
  )
}

export function parseActivity(records: HorizonPaymentRecord[], address: string): Activity[] {
  const out: Activity[] = []
  for (const r of records) {
    const common = { id: r.id, at: r.created_at, hash: r.transaction_hash }

    if (r.type === 'create_account' && r.account === address && r.starting_balance !== undefined) {
      out.push({
        ...common,
        kind: 'received',
        amount: trim(r.starting_balance),
        code: 'XLM',
        ...(r.funder !== undefined ? { counterparty: r.funder } : {}),
      })
      continue
    }

    if (r.amount === undefined || r.from === undefined || r.to === undefined) continue
    const code = assetCode(r.asset_type, r.asset_code)

    const isPathPayment = r.type.startsWith('path_payment')
    if (isPathPayment && r.from === address && r.to === address) {
      out.push({
        ...common,
        kind: 'swap',
        amount: trim(r.amount),
        code,
        ...(r.source_amount !== undefined
          ? {
              sourceAmount: trim(r.source_amount),
              sourceCode: assetCode(r.source_asset_type, r.source_asset_code),
            }
          : {}),
      })
    } else if (r.type === 'payment' || isPathPayment) {
      const sent = r.from === address
      out.push({
        ...common,
        kind: sent ? 'sent' : 'received',
        amount: trim(r.amount),
        code,
        counterparty: sent ? r.to : r.from,
      })
    }
  }
  return out
}

export async function fetchHoldings(address: string): Promise<Holding[]> {
  const res = await fetch(`${stellarNetwork.horizonUrl}/accounts/${address}`, {
    headers: { Accept: 'application/json' },
  })
  // An account that was never funded has no holdings, which is a state and not a failure.
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Horizon ${res.status}`)
  const data = (await res.json()) as { balances?: HorizonBalanceRecord[] }
  return parseHoldings(data.balances ?? [])
}

export async function fetchActivity(address: string, limit = 25): Promise<Activity[]> {
  const res = await fetch(
    `${stellarNetwork.horizonUrl}/accounts/${address}/payments?order=desc&limit=${limit}`,
    { headers: { Accept: 'application/json' } }
  )
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Horizon ${res.status}`)
  const data = (await res.json()) as { _embedded?: { records?: HorizonPaymentRecord[] } }
  return parseActivity(data._embedded?.records ?? [], address)
}
