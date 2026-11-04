import { fromBaseUnits } from '../solana/tokens'
import { ChainActionRefused, type TokenBalance, type WalletBalances } from '../types'
import { SUI_TOKENS } from './tokens'

const GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql'
const TIMEOUT_MS = 10_000
const MAX_PAGES = 5
const OWNER = /^0x[0-9a-fA-F]{64}$/
const COIN_TYPE = /^0x[0-9a-fA-F]+::\w+::\w+$/

const BALANCES =
  'query($a:SuiAddress!,$c:String){address(address:$a){balances(first:50,after:$c){pageInfo{hasNextPage endCursor} nodes{coinType{repr} totalBalance}}}}'

async function graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Sui GraphQL answered ${response.status}`)
  const body = (await response.json()) as { data?: unknown; errors?: unknown }
  if (body.errors !== undefined || body.data === undefined || body.data === null) {
    throw new Error('Sui GraphQL refused the query')
  }
  return body.data
}

/** The padded `0x000...02::sui::SUI` is `0x2::sui::SUI` in the token table. */
function normalise(coinType: string): string {
  return coinType.replace(/^0x0+(?=[0-9a-fA-F])/, '0x')
}

interface Held {
  type: string
  base: string
}

interface BalancePage {
  address?: {
    balances?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      nodes?: { coinType?: { repr?: string }; totalBalance?: string }[]
    }
  } | null
}

async function readAll(account: string): Promise<{ held: Held[]; more: boolean }> {
  const held: Held[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = (await graphql(BALANCES, { a: account, c: cursor })) as BalancePage
    const balances = data.address?.balances
    if (balances?.nodes === undefined) throw new Error('Sui balances unreadable')
    for (const node of balances.nodes) {
      if (typeof node.coinType?.repr !== 'string' || typeof node.totalBalance !== 'string') {
        throw new Error('Sui balance unreadable')
      }
      held.push({ type: normalise(node.coinType.repr), base: node.totalBalance })
    }
    if (balances.pageInfo?.hasNextPage !== true) return { held, more: false }
    cursor = balances.pageInfo.endCursor ?? null
    if (cursor === null) return { held, more: true }
  }
  return { held, more: true }
}

/** Decimals from the chain's own metadata. A coin with none is left out, not guessed. */
async function decimalsOf(types: string[]): Promise<Map<string, number>> {
  const wanted = types.filter((t) => COIN_TYPE.test(t))
  if (wanted.length === 0) return new Map()
  const query = `query{${wanted
    .map((t, i) => `a${i}:coinMetadata(coinType:${JSON.stringify(t)}){decimals}`)
    .join(' ')}}`
  const data = (await graphql(query, {})) as Record<string, { decimals?: number } | null>
  const out = new Map<string, number>()
  wanted.forEach((type, i) => {
    const decimals = data[`a${i}`]?.decimals
    if (typeof decimals === 'number') out.set(type, decimals)
  })
  return out
}

export async function readSuiBalances(account: string): Promise<WalletBalances> {
  if (!OWNER.test(account)) {
    throw new ChainActionRefused('That is not a Sui address. Connect a Sui wallet and try again.')
  }
  const { held, more } = await readAll(account)
  let complete = !more
  const unlisted = held.filter((h) => !SUI_TOKENS.some((t) => t.id === h.type)).map((h) => h.type)
  const decimals = await decimalsOf(unlisted)
  const tokens: TokenBalance[] = []
  for (const { type, base } of held) {
    const listed = SUI_TOKENS.find((t) => t.id === type)
    if (listed !== undefined) {
      tokens.push({
        symbol: listed.symbol,
        id: listed.id,
        amount: fromBaseUnits(base, listed.decimals),
        decimals: listed.decimals,
        native: listed.id === SUI_TOKENS[0]!.id,
        listed: true,
      })
      continue
    }
    const places = decimals.get(type)
    if (places === undefined) {
      complete = false
      continue
    }
    tokens.push({
      symbol: type.split('::').at(-1) ?? type,
      id: type,
      amount: fromBaseUnits(base, places),
      decimals: places,
      native: false,
      listed: false,
    })
  }
  return { tokens, complete }
}
