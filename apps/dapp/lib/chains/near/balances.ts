import { fromBaseUnits } from '../solana/tokens'
import {
  BALANCE_DEADLINE_MS,
  ChainActionRefused,
  type TokenBalance,
  type WalletBalances,
} from '../types'
import { NEAR_ACCOUNT } from './account'
import { spendableBalance, viewCall } from './rpc'
import { NATIVE_NEAR, nearTokens, WRAP_NEAR } from './tokens'

const FASTNEAR = 'https://api.fastnear.com/v1/account'
const MAX_METADATA_READS = 20
const NEAR_DECIMALS = 24

interface FtHolding {
  contract_id?: string
  balance?: string
}

async function fastNearList(
  account: string,
  signal: AbortSignal
): Promise<{ id: string; base: string }[]> {
  const response = await fetch(`${FASTNEAR}/${encodeURIComponent(account)}/ft`, { signal })
  if (!response.ok) throw new Error(`FastNEAR answered ${response.status}`)
  const body = (await response.json()) as { tokens?: FtHolding[] }
  if (!Array.isArray(body.tokens)) throw new Error('FastNEAR list unreadable')
  return body.tokens.map((t) => {
    if (typeof t.contract_id !== 'string' || typeof t.balance !== 'string') {
      throw new Error('FastNEAR holding unreadable')
    }
    return { id: t.contract_id, base: t.balance }
  })
}

/** What the chain says the account holds of a table token, at finality final. A failed read throws. */
async function tableEntry(
  token: (typeof nearTokens)[number],
  account: string,
  signal: AbortSignal
): Promise<TokenBalance> {
  const base = await viewCall<string>(token.id, 'ft_balance_of', { account_id: account }, signal)
  if (typeof base !== 'string' || !/^\d+$/.test(base)) throw new Error('ft balance unreadable')
  return {
    symbol: token.id === WRAP_NEAR ? 'wNEAR' : token.symbol,
    id: token.id,
    amount: fromBaseUnits(base, token.decimals),
    decimals: token.decimals,
    native: false,
    listed: true,
  }
}

async function unlistedEntry(
  id: string,
  base: string,
  signal: AbortSignal
): Promise<TokenBalance | undefined> {
  try {
    const meta = await viewCall<{ symbol?: unknown; decimals?: unknown }>(
      id,
      'ft_metadata',
      {},
      signal
    )
    if (typeof meta.symbol !== 'string' || typeof meta.decimals !== 'number') return undefined
    return {
      symbol: meta.symbol,
      id,
      amount: fromBaseUnits(base, meta.decimals),
      decimals: meta.decimals,
      native: false,
      listed: false,
    }
  } catch (e) {
    if (signal.aborted) throw e
    return undefined
  }
}

/**
 * Table tokens are read from the chain, because the indexer behind FastNEAR lags and a token just
 * delivered by a swap could be missing from its list. The list only discovers unlisted tokens, so
 * one received in the last few seconds may be missing from those.
 */
export async function readNearBalances(
  account: string,
  signal: AbortSignal = AbortSignal.timeout(BALANCE_DEADLINE_MS)
): Promise<WalletBalances> {
  if (!NEAR_ACCOUNT.test(account)) {
    throw new ChainActionRefused('That is not a NEAR account. Connect a NEAR wallet and try again.')
  }
  const [nativeBase, table, discovered] = await Promise.all([
    spendableBalance(account, signal),
    Promise.all(nearTokens.map((token) => tableEntry(token, account, signal))),
    fastNearList(account, signal).catch((e: unknown) => {
      if (signal.aborted) throw e
      return undefined
    }),
  ])
  const native: TokenBalance = {
    symbol: 'NEAR',
    id: NATIVE_NEAR.id,
    amount: fromBaseUnits(nativeBase, NEAR_DECIMALS),
    decimals: NEAR_DECIMALS,
    native: true,
    listed: true,
  }
  if (discovered === undefined) return { tokens: [native, ...table], complete: false }

  const unlisted = discovered.filter(
    (h) => !nearTokens.some((t) => t.id === h.id) && !/^0+$/.test(h.base)
  )
  const read = unlisted.slice(0, MAX_METADATA_READS)
  const entries = await Promise.all(read.map((h) => unlistedEntry(h.id, h.base, signal)))
  const found = entries.flatMap((e) => (e === undefined ? [] : [e]))
  return {
    tokens: [native, ...table, ...found],
    complete: unlisted.length === found.length,
  }
}
