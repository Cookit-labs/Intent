import { isAddress } from '@solana/kit'

import {
  BALANCE_DEADLINE_MS,
  ChainActionRefused,
  type TokenBalance,
  type WalletBalances,
} from '../types'
import { fromBaseUnits, SOLANA_TOKENS } from './tokens'

const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'
const TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]
const SOL = SOLANA_TOKENS[0]!

/** The node answered, but refused the call. Anything else, a timeout included, is not caught here. */
class RpcRefused extends Error {}

export async function rpc(
  method: string,
  params: unknown[],
  signal: AbortSignal
): Promise<unknown> {
  const url = process.env['SOLANA_RPC_URL']?.trim() || DEFAULT_RPC_URL
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  })
  if (!response.ok) throw new RpcRefused(`${method} answered ${response.status}`)
  const body = (await response.json()) as { result?: unknown; error?: unknown }
  if (body.error !== undefined || body.result === undefined) {
    throw new RpcRefused(`${method} was refused`)
  }
  return body.result
}

interface Held {
  mint: string
  amount: string
  decimals: number
}

function parsedInfo(data: unknown): Held | undefined {
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

async function accountsOf(
  account: string,
  filter: { programId: string } | { mint: string },
  signal: AbortSignal
): Promise<Held[]> {
  const result = (await rpc(
    'getTokenAccountsByOwner',
    [account, filter, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    signal
  )) as { value?: { account?: { data?: unknown } }[] }
  if (!Array.isArray(result.value)) throw new RpcRefused('token accounts unreadable')
  return result.value.map((item) => {
    const info = parsedInfo(item.account?.data)
    if (info === undefined) throw new RpcRefused('token account unreadable')
    return info
  })
}

/** Sums accounts per mint, since a wallet can hold one mint in several. */
function sumByMint(held: Held[]): TokenBalance[] {
  const totals = new Map<string, { base: bigint; decimals: number }>()
  for (const { mint, amount, decimals } of held) {
    totals.set(mint, { base: (totals.get(mint)?.base ?? BigInt(0)) + BigInt(amount), decimals })
  }
  return [...totals].map(([mint, { base, decimals }]) => entry(mint, base, decimals))
}

async function listAll(account: string, signal: AbortSignal): Promise<TokenBalance[]> {
  const perProgram = await Promise.all(
    TOKEN_PROGRAMS.map((programId) => accountsOf(account, { programId }, signal))
  )
  return sumByMint(perProgram.flat())
}

/**
 * Each token in the table by its mint, which finds an account in either program and not only the
 * associated one. A token that can't be read is left out and named, never shown as zero.
 */
async function readTable(
  account: string,
  signal: AbortSignal
): Promise<{ tokens: TokenBalance[]; unread: string[] }> {
  const reads = await Promise.all(
    SOLANA_TOKENS.filter((t) => t !== SOL).map(async (token) => {
      try {
        const held = await accountsOf(account, { mint: token.id }, signal)
        const base = held.reduce((sum, h) => sum + BigInt(h.amount), BigInt(0))
        return { token, balance: entry(token.id, base, token.decimals) }
      } catch (e) {
        if (!(e instanceof RpcRefused)) throw e
        return { token, balance: undefined }
      }
    })
  )
  return {
    tokens: reads.flatMap((r) => (r.balance === undefined ? [] : [r.balance])),
    unread: reads.filter((r) => r.balance === undefined).map((r) => r.token.symbol),
  }
}

/** Read at `confirmed`, so a figure is what the chain has agreed on, not what a node last saw. */
export async function readSolanaBalances(
  account: string,
  signal: AbortSignal = AbortSignal.timeout(BALANCE_DEADLINE_MS)
): Promise<WalletBalances> {
  if (!isAddress(account)) {
    throw new ChainActionRefused(
      'That is not a Solana address. Connect a Solana wallet and try again.'
    )
  }
  const lamports = (await rpc('getBalance', [account, { commitment: 'confirmed' }], signal)) as {
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
    return { tokens: [native, ...(await listAll(account, signal))], complete: true }
  } catch (e) {
    if (!(e instanceof RpcRefused)) throw e
    const { tokens, unread } = await readTable(account, signal)
    return { tokens: [native, ...tokens], complete: false, unread }
  }
}
