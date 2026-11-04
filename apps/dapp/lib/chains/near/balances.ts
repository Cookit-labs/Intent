import { fromBaseUnits } from '../solana/tokens'
import { ChainActionRefused, type TokenBalance, type WalletBalances } from '../types'
import { NEAR_ACCOUNT } from './account'
import { accountBalance, viewCall } from './rpc'
import { nearTokens, WRAP_NEAR } from './tokens'

const FASTNEAR = 'https://api.fastnear.com/v1/account'
const TIMEOUT_MS = 10_000
const MAX_METADATA_READS = 20
const NEAR_DECIMALS = 24
const NATIVE_ID = 'near'

interface FtHolding {
  contract_id?: string
  balance?: string
}

async function fastNearList(account: string): Promise<{ id: string; base: string }[]> {
  const response = await fetch(`${FASTNEAR}/${encodeURIComponent(account)}/ft`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
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

function symbolFor(id: string, symbol: string): string {
  return id === WRAP_NEAR ? 'wNEAR' : symbol
}

function listedEntry(id: string, base: string): TokenBalance | undefined {
  const token = nearTokens.find((t) => t.id === id)
  if (token === undefined) return undefined
  return {
    symbol: symbolFor(id, token.symbol),
    id,
    amount: fromBaseUnits(base, token.decimals),
    decimals: token.decimals,
    native: false,
    listed: true,
  }
}

async function unlistedEntry(id: string, base: string): Promise<TokenBalance | undefined> {
  try {
    const meta = await viewCall<{ symbol?: unknown; decimals?: unknown }>(id, 'ft_metadata')
    if (typeof meta.symbol !== 'string' || typeof meta.decimals !== 'number') return undefined
    return {
      symbol: meta.symbol,
      id,
      amount: fromBaseUnits(base, meta.decimals),
      decimals: meta.decimals,
      native: false,
      listed: false,
    }
  } catch {
    return undefined
  }
}

async function fromRegistry(account: string): Promise<TokenBalance[]> {
  const out: TokenBalance[] = []
  for (const token of nearTokens) {
    const base = await viewCall<string>(token.id, 'ft_balance_of', { account_id: account })
    if (typeof base !== 'string') throw new Error('ft balance unreadable')
    const entry = listedEntry(token.id, base)
    if (entry !== undefined) out.push(entry)
  }
  return out
}

export async function readNearBalances(account: string): Promise<WalletBalances> {
  if (!NEAR_ACCOUNT.test(account)) {
    throw new ChainActionRefused('That is not a NEAR account. Connect a NEAR wallet and try again.')
  }
  const native: TokenBalance = {
    symbol: 'NEAR',
    id: NATIVE_ID,
    amount: fromBaseUnits(await accountBalance(account), NEAR_DECIMALS),
    decimals: NEAR_DECIMALS,
    native: true,
    listed: true,
  }
  let held: { id: string; base: string }[]
  try {
    held = await fastNearList(account)
  } catch {
    return { tokens: [native, ...(await fromRegistry(account))], complete: false }
  }
  let complete = true
  let metadataReads = 0
  const tokens: TokenBalance[] = [native]
  for (const { id, base } of held) {
    const listed = listedEntry(id, base)
    if (listed !== undefined) {
      tokens.push(listed)
      continue
    }
    if (/^0+$/.test(base)) continue
    if (metadataReads >= MAX_METADATA_READS) {
      complete = false
      continue
    }
    metadataReads += 1
    const entry = await unlistedEntry(id, base)
    if (entry === undefined) complete = false
    else tokens.push(entry)
  }
  return { tokens, complete }
}
