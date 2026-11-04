import { ChainActionRefused, type TokenBalance, type WalletBalances } from '../types'
import { associatedTokenAccount } from './assert-safe'
import { fromBaseUnits, SOLANA_TOKENS } from './tokens'

const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'
const TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]
const TIMEOUT_MS = 10_000
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const SOL = SOLANA_TOKENS[0]!

class RpcRefused extends Error {}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const url = process.env['SOLANA_RPC_URL']?.trim() || DEFAULT_RPC_URL
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new RpcRefused(`${method} answered ${response.status}`)
  const body = (await response.json()) as { result?: unknown; error?: unknown }
  if (body.error !== undefined || body.result === undefined) {
    throw new RpcRefused(`${method} was refused`)
  }
  return body.result
}

function parsedInfo(data: unknown): { mint: string; amount: string; decimals: number } | undefined {
  const info = (data as { parsed?: { info?: unknown } } | undefined)?.parsed?.info as
    | { mint?: unknown; tokenAmount?: { amount?: unknown; decimals?: unknown } }
    | undefined
  const { mint, tokenAmount } = info ?? {}
  if (
    typeof mint !== 'string' ||
    typeof tokenAmount?.amount !== 'string' ||
    typeof tokenAmount.decimals !== 'number'
  ) {
    return undefined
  }
  return { mint, amount: tokenAmount.amount, decimals: tokenAmount.decimals }
}

function entry(mint: string, base: bigint, decimals: number): TokenBalance {
  const listed = SOLANA_TOKENS.find((t) => t.id === mint && t !== SOL)
  return {
    symbol: listed?.symbol ?? mint,
    id: mint,
    amount: fromBaseUnits(base.toString(), decimals),
    decimals,
    native: false,
    listed: listed !== undefined,
  }
}

async function listAll(account: string): Promise<TokenBalance[]> {
  const held = new Map<string, { base: bigint; decimals: number }>()
  for (const programId of TOKEN_PROGRAMS) {
    const result = (await rpc('getTokenAccountsByOwner', [
      account,
      { programId },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ])) as { value?: { account?: { data?: unknown } }[] }
    if (!Array.isArray(result.value)) throw new RpcRefused('token accounts unreadable')
    for (const item of result.value) {
      const info = parsedInfo(item.account?.data)
      if (info === undefined) throw new RpcRefused('token account unreadable')
      held.set(info.mint, {
        base: (held.get(info.mint)?.base ?? BigInt(0)) + BigInt(info.amount),
        decimals: info.decimals,
      })
    }
  }
  return [...held].map(([mint, { base, decimals }]) => entry(mint, base, decimals))
}

async function readTable(account: string): Promise<TokenBalance[]> {
  const out: TokenBalance[] = []
  for (const token of SOLANA_TOKENS) {
    if (token === SOL) continue
    const result = (await rpc('getAccountInfo', [
      associatedTokenAccount(account, token.id),
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ])) as { value: { data?: unknown } | null }
    const info = result.value === null ? undefined : parsedInfo(result.value.data)
    if (result.value !== null && info === undefined) throw new RpcRefused('account unreadable')
    out.push(entry(token.id, BigInt(info?.amount ?? '0'), token.decimals))
  }
  return out
}

/** Read at `confirmed`, so a figure is what the chain has agreed on, not what a node last saw. */
export async function readSolanaBalances(account: string): Promise<WalletBalances> {
  if (!ADDRESS.test(account)) {
    throw new ChainActionRefused(
      'That is not a Solana address. Connect a Solana wallet and try again.'
    )
  }
  const lamports = (await rpc('getBalance', [account, { commitment: 'confirmed' }])) as {
    value?: unknown
  }
  if (typeof lamports.value !== 'number') throw new RpcRefused('balance unreadable')
  const native: TokenBalance = {
    symbol: SOL.symbol,
    id: SOL.id,
    amount: fromBaseUnits(String(lamports.value), SOL.decimals),
    decimals: SOL.decimals,
    native: true,
    listed: true,
  }
  try {
    return { tokens: [native, ...(await listAll(account))], complete: true }
  } catch (e) {
    if (!(e instanceof RpcRefused)) throw e
    return { tokens: [native, ...(await readTable(account))], complete: false }
  }
}
