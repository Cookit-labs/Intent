import type { AnchorToml } from './toml'

/**
 * A non-2xx answer from the anchor, with the status carried as data.
 *
 * Callers branch on this: a 401 means the SEP-10 token is dead and the user
 * must sign in again, which is a different action from retrying. Matching the
 * message text for "401" would be brittle; the status is a field instead.
 */
export class AnchorHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'AnchorHttpError'
    this.status = status
  }
}

/**
 * SEP-24 over plain fetch.
 *
 * Three calls: what the anchor withdraws and within what limits, starting a
 * withdrawal, and reading one back. The response shapes are the anchor's own,
 * transcribed from the specification and checked against testanchor's live
 * answers; the field names are the wire names, mapped once here.
 *
 * Nothing in this file moves funds. The only consequential thing it does is
 * report `withdraw_anchor_account`, `withdraw_memo` and `amount_in`, and the
 * payment builder reads those from a call made server-side, never from a
 * value the browser passed along.
 */

export type Sep24Status =
  | 'incomplete'
  | 'pending_user_transfer_start'
  | 'pending_user_transfer_complete'
  | 'pending_external'
  | 'pending_anchor'
  | 'on_hold'
  | 'pending_stellar'
  | 'pending_trust'
  | 'pending_user'
  | 'completed'
  | 'refunded'
  | 'expired'
  | 'no_market'
  | 'too_small'
  | 'too_large'
  | 'error'

const STATUSES = new Set<string>([
  'incomplete',
  'pending_user_transfer_start',
  'pending_user_transfer_complete',
  'pending_external',
  'pending_anchor',
  'on_hold',
  'pending_stellar',
  'pending_trust',
  'pending_user',
  'completed',
  'refunded',
  'expired',
  'no_market',
  'too_small',
  'too_large',
  'error',
])

/** The one status at which the user's payment is expected. */
export function isReadyToPay(status: Sep24Status): boolean {
  return status === 'pending_user_transfer_start'
}

/** The anchor has given up or refused. Nothing must ever be sent in these. */
export function isDeclined(status: Sep24Status): boolean {
  return (
    status === 'expired' ||
    status === 'refunded' ||
    status === 'error' ||
    status === 'no_market' ||
    status === 'too_small' ||
    status === 'too_large'
  )
}

export function isSettledByAnchor(status: Sep24Status): boolean {
  return status === 'completed'
}

/**
 * Anything still in the anchor's hands. `on_hold` is compliance review and
 * can last days; it is waiting, not failure, and must not be shown as one.
 */
export function isWaitingOnAnchor(status: Sep24Status): boolean {
  return !isReadyToPay(status) && !isDeclined(status) && !isSettledByAnchor(status)
}

export type Sep24MemoType = 'text' | 'id' | 'hash'

export interface WithdrawLimits {
  enabled: boolean
  minAmount?: number
  maxAmount?: number
  feeEnabled: boolean
}

export interface AnchorTransaction {
  id: string
  kind: string
  status: Sep24Status
  /** The account to pay. Per transaction — never cached. */
  withdrawAnchorAccount?: string
  /** The memo that attributes the payment. Base64 when the type is `hash`. */
  withdrawMemo?: string
  withdrawMemoType?: Sep24MemoType
  /** What the anchor expects to receive, in the asset's display units. */
  amountIn?: string
  amountOut?: string
  amountInAsset?: string
  moreInfoUrl?: string
  message?: string
  stellarTransactionId?: string
  kycVerified?: boolean
}

interface InfoWire {
  withdraw?: Record<string, { enabled?: boolean; min_amount?: number; max_amount?: number }>
  fee?: { enabled?: boolean }
}

interface TransactionWire {
  transaction?: {
    id?: string
    kind?: string
    status?: string
    withdraw_anchor_account?: string
    withdraw_memo?: string
    withdraw_memo_type?: string
    amount_in?: string | number
    amount_out?: string | number
    amount_in_asset?: string
    more_info_url?: string
    message?: string
    stellar_transaction_id?: string
    kyc_verified?: boolean
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export async function readWithdrawInfo(
  toml: AnchorToml,
  assetCode: string,
  fetchImpl: typeof fetch = fetch
): Promise<WithdrawLimits | undefined> {
  const res = await fetchImpl(`${toml.transferServerSep24}/info`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok)
    throw new AnchorHttpError(
      res.status,
      `anchor /info returned ${res.status}: ${await errorText(res)}`
    )
  const info = (await res.json()) as InfoWire

  const entry = info.withdraw?.[assetCode]
  if (entry === undefined) return undefined

  return {
    enabled: entry.enabled === true,
    ...(entry.min_amount !== undefined ? { minAmount: entry.min_amount } : {}),
    ...(entry.max_amount !== undefined ? { maxAmount: entry.max_amount } : {}),
    feeEnabled: info.fee?.enabled === true,
  }
}

export interface StartWithdrawRequest {
  authToken: string
  assetCode: string
  /** Display units. Optional: the anchor asks in its own page when absent. */
  amount?: string
}

export async function startWithdraw(
  toml: AnchorToml,
  req: StartWithdrawRequest,
  fetchImpl: typeof fetch = fetch
): Promise<{ id: string; url: string }> {
  const res = await fetchImpl(`${toml.transferServerSep24}/transactions/withdraw/interactive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${req.authToken}`,
    },
    body: JSON.stringify({
      asset_code: req.assetCode,
      ...(req.amount !== undefined ? { amount: req.amount } : {}),
    }),
  })
  if (!res.ok)
    throw new AnchorHttpError(res.status, `anchor refused the withdrawal: ${await errorText(res)}`)

  const body = (await res.json()) as { type?: string; url?: string; id?: string }
  if (body.type !== 'interactive_customer_info_needed') {
    throw new Error(`anchor answered ${body.type ?? 'nothing'}, not an interactive flow`)
  }
  if (typeof body.url !== 'string' || typeof body.id !== 'string') {
    throw new Error('anchor returned no interactive url or transaction id')
  }
  return { id: body.id, url: body.url }
}

export async function readTransaction(
  toml: AnchorToml,
  req: { authToken: string; id: string },
  fetchImpl: typeof fetch = fetch
): Promise<AnchorTransaction> {
  const res = await fetchImpl(
    `${toml.transferServerSep24}/transaction?id=${encodeURIComponent(req.id)}`,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${req.authToken}` } }
  )
  if (!res.ok)
    throw new AnchorHttpError(
      res.status,
      `anchor transaction read returned ${res.status}: ${await errorText(res)}`
    )

  const wire = ((await res.json()) as TransactionWire).transaction
  if (wire === undefined || typeof wire.id !== 'string') {
    throw new Error('anchor returned no transaction')
  }
  if (typeof wire.status !== 'string' || !STATUSES.has(wire.status)) {
    throw new Error(`anchor reported an unknown status: ${wire.status ?? '(none)'}`)
  }

  let memoType: Sep24MemoType | undefined
  if (wire.withdraw_memo_type !== undefined) {
    if (
      wire.withdraw_memo_type !== 'text' &&
      wire.withdraw_memo_type !== 'id' &&
      wire.withdraw_memo_type !== 'hash'
    ) {
      throw new Error(`anchor named a memo type this app cannot build: ${wire.withdraw_memo_type}`)
    }
    memoType = wire.withdraw_memo_type
  }

  return {
    id: wire.id,
    kind: wire.kind ?? 'withdrawal',
    status: wire.status as Sep24Status,
    ...(wire.withdraw_anchor_account !== undefined
      ? { withdrawAnchorAccount: wire.withdraw_anchor_account }
      : {}),
    ...(wire.withdraw_memo !== undefined ? { withdrawMemo: wire.withdraw_memo } : {}),
    ...(memoType !== undefined ? { withdrawMemoType: memoType } : {}),
    ...(wire.amount_in !== undefined ? { amountIn: String(wire.amount_in) } : {}),
    ...(wire.amount_out !== undefined ? { amountOut: String(wire.amount_out) } : {}),
    ...(wire.amount_in_asset !== undefined ? { amountInAsset: wire.amount_in_asset } : {}),
    ...(wire.more_info_url !== undefined ? { moreInfoUrl: wire.more_info_url } : {}),
    ...(wire.message !== undefined ? { message: wire.message } : {}),
    ...(wire.stellar_transaction_id !== undefined
      ? { stellarTransactionId: wire.stellar_transaction_id }
      : {}),
    ...(wire.kyc_verified !== undefined ? { kycVerified: wire.kyc_verified } : {}),
  }
}
