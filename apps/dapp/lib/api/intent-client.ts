import type { ChainSlug, CreateIntentInput, Intent, IntentType } from '@intent/types'

import { keepOnlyReal, type DappClient, type IntentApi } from '../sdk'
import { apiRequest } from './http-client'
import { currentToken } from './auth'

/**
 * The intent store, backed by the Go backend instead of localStorage.
 *
 * Implements the same `IntentApi` the mock does, so nothing downstream changes
 * — the hooks, the components and the three lifecycle test suites all keep
 * working against whichever client is configured. That interface is the proven
 * contract: it drives working on-chain execution and its rules are already
 * encoded in tests.
 *
 * The two `Intent` shapes were designed apart and disagree in several places.
 * Mapping happens here and only here, so a change to the API is one file to
 * fix rather than a hunt through call sites.
 */

/** What the backend returns. Snake case, and missing several dapp fields. */
interface ApiIntent {
  id: string
  chain: string
  user_wallet: string
  token_in: string
  token_out: string
  amount_in: string
  max_slippage: number
  deadline: string
  status: string
  selected_agent_id?: string
  limit_price_usd?: number
  stellar_offer_id?: string
  placement_tx_hash?: string
  created_at: string
  updated_at: string
}

/**
 * The backend's `max_slippage` is a fraction of the trade; the dapp's
 * `minAmountOut` is an absolute floor. Neither derives from the other without
 * a price, so the dapp's figure is carried through and this default is only
 * ever used for the field the backend insists on.
 */
const DEFAULT_MAX_SLIPPAGE = 0.005

/**
 * The backend writes only three of its six documented statuses, and none of
 * them describe a resting order. Anything unrecognised becomes `pending`
 * rather than being passed through as an invalid value: `agedStatus` on the
 * client is the authority on what a pending intent actually is.
 */
function toIntentStatus(status: string): Intent['status'] {
  switch (status) {
    case 'settled':
    case 'failed':
    case 'cancelled':
    case 'executing':
    case 'competition':
      return status
    default:
      return 'pending'
  }
}

function fromApi(row: ApiIntent, fallbackType: IntentType = 'market_buy'): Intent {
  return {
    id: row.id,
    // The backend has no per-user identity beyond the wallet, which is the
    // more useful thing to carry anyway.
    userId: row.user_wallet,
    ...(row.chain !== '' ? { chain: row.chain as ChainSlug } : {}),
    // Intent type is a dapp concept — the backend stores no equivalent, so a
    // row read back cannot say whether it was a limit or a market order except
    // by whether it carries a limit price.
    type: row.limit_price_usd !== undefined ? 'limit_buy' : fallbackType,
    tokenIn: row.token_in,
    tokenOut: row.token_out,
    amountIn: row.amount_in,
    // Not stored server-side; the floor lives in the signed transaction, which
    // is where it is actually enforced.
    minAmountOut: '0',
    deadline: row.deadline,
    ...(row.limit_price_usd !== undefined ? { limitPriceUsd: row.limit_price_usd } : {}),
    status: toIntentStatus(row.status),
    ...(row.stellar_offer_id !== undefined && row.stellar_offer_id !== ''
      ? { stellarOfferId: row.stellar_offer_id }
      : {}),
    ...(row.placement_tx_hash !== undefined && row.placement_tx_hash !== ''
      ? { placementTxHash: row.placement_tx_hash }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Every call needs a session, and a missing one is a real condition rather
 * than an exception: the user has not connected a wallet yet.
 */
function requireToken(): string {
  const token = currentToken()
  if (token === undefined) {
    throw new Error('Connect a wallet to use saved intents.')
  }
  return token
}

export function createBackendClient(): DappClient {
  const intents: IntentApi = {
    async create(input: CreateIntentInput): Promise<Intent> {
      const token = requireToken()
      const row = await apiRequest<ApiIntent>('/intents', {
        method: 'POST',
        token,
        body: {
          chain: input.chain ?? 'stellar',
          // The server takes the wallet from the token; this field is required
          // by the existing request shape and must agree with it.
          user_wallet: tokenWallet(token),
          token_in: input.tokenIn,
          token_out: input.tokenOut,
          amount_in: input.amountIn,
          max_slippage: DEFAULT_MAX_SLIPPAGE,
          deadline: input.deadline,
          ...(input.limitPriceUsd !== undefined ? { limit_price_usd: input.limitPriceUsd } : {}),
        },
      })
      return fromApi(row, input.type)
    },

    async cancel(id: string): Promise<Intent> {
      const row = await apiRequest<ApiIntent>(`/intents/${id}/cancel`, {
        method: 'POST',
        token: requireToken(),
      })
      return fromApi(row)
    },

    async settle(id: string, txHash: string): Promise<Intent> {
      // The backend's settle records an execution against a winning proposal,
      // which the dapp does not have: its agents run client-side and their
      // proposals are never persisted. Recording the hash on the intent is the
      // honest subset until proposals are stored server-side.
      const row = await apiRequest<ApiIntent>(`/intents/${id}/place`, {
        method: 'POST',
        token: requireToken(),
        body: { offer_id: 'settled', tx_hash: txHash },
      })
      return { ...fromApi(row), status: 'settled', settlementTxHash: txHash }
    },

    async place(id: string, offerId: string, txHash: string): Promise<Intent> {
      const row = await apiRequest<ApiIntent>(`/intents/${id}/place`, {
        method: 'POST',
        token: requireToken(),
        body: { offer_id: offerId, tx_hash: txHash },
      })
      return fromApi(row)
    },

    async list(chain?: string): Promise<Intent[]> {
      const query = chain !== undefined ? `?chain=${encodeURIComponent(chain)}` : ''
      const body = await apiRequest<{ intents: ApiIntent[] }>(`/intents${query}`, {
        token: requireToken(),
      })
      // Filtered on the way in, not only on the way out of storage. The
      // backend accepts any non-empty string as a transaction hash and writes
      // `confirmed` without checking it against a network, so a row claiming a
      // settled trade with nothing behind it is more likely here than it ever
      // was in localStorage.
      return keepOnlyReal((body.intents ?? []).map((row) => fromApi(row)))
    },

    async get(id: string): Promise<Intent> {
      const row = await apiRequest<ApiIntent>(`/intents/${id}`, { token: requireToken() })
      return fromApi(row)
    },
  }

  return { intents }
}

/** The wallet a token was issued for. The token body is `wallet.expiry.signature`. */
function tokenWallet(token: string): string {
  return token.split('.')[0] ?? ''
}
