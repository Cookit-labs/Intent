/** Client-safe: what the token routes answer with, and how the figures read. */

export interface TokenPool {
  dex: string
  pair: string
  liquidityUsd?: number
  volume24hUsd?: number
  url?: string
}

/**
 * One token on a chain. A figure no source reported is left out rather than shown as zero: a token
 * with no holder count has unknown holders, not none.
 */
export interface TokenRow {
  id: string
  symbol: string
  name?: string
  icon?: string
  priceUsd?: number
  change24h?: number
  marketCapUsd?: number
  fdvUsd?: number
  liquidityUsd?: number
  volume24hUsd?: number
  holders?: number
  /** Who says this is the real token, in words. Empty means nobody here does. */
  verified: string[]
  /** It can be traded here, so this app has checked its address itself. */
  listed: boolean
  /** The symbol of a token this app lists, where this one uses it with another address. */
  sameNameAs?: string
  explorerUrl: string
  /** Only on a single token's answer. */
  pools?: TokenPool[]
}

export interface TokenDirectory {
  tokens: TokenRow[]
  /** A source did not answer, so some rows or figures may be missing. */
  partial: boolean
  /** Who the figures came from, to say on the page. */
  sources: string[]
}

function compact(value: number): string {
  const abs = Math.abs(value)
  const scale = (n: number, unit: string): string =>
    `${(value / n).toLocaleString('en-US', { maximumFractionDigits: 2 })}${unit}`
  if (abs >= 1e12) return scale(1e12, 'T')
  if (abs >= 1e9) return scale(1e9, 'B')
  if (abs >= 1e6) return scale(1e6, 'M')
  if (abs >= 1e3) return scale(1e3, 'K')
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

const NOT_REPORTED = '—'

export function usdFigure(value: number | undefined): string {
  return value === undefined ? NOT_REPORTED : `$${compact(value)}`
}

export function countFigure(value: number | undefined): string {
  return value === undefined ? NOT_REPORTED : compact(value)
}

/** A price keeps the digits that say something: $0.00001234, not $0.00. */
export function priceFigure(value: number | undefined): string {
  if (value === undefined) return NOT_REPORTED
  if (value >= 1) {
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: value >= 1000 ? 0 : 2, minimumFractionDigits: value >= 1000 ? 0 : 2 })}`
  }
  if (value === 0) return '$0'
  if (value >= 0.01) {
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
  }
  return `$${value.toLocaleString('en-US', { maximumSignificantDigits: 4 })}`
}

export function changeFigure(value: number | undefined): string {
  if (value === undefined) return NOT_REPORTED
  // A move too small to show is no move, and never "-0.00%".
  if (Math.abs(value) < 0.005) return '0.00%'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export async function fetchTokens(
  chain: string,
  query = '',
  fetchImpl: typeof fetch = fetch
): Promise<TokenDirectory> {
  const search = query.trim() === '' ? '' : `?q=${encodeURIComponent(query.trim())}`
  const res = await fetchImpl(`/api/chain/${chain}/tokens${search}`)
  if (!res.ok) throw new Error('could not read tokens')
  return (await res.json()) as TokenDirectory
}

export async function fetchToken(
  chain: string,
  id: string,
  fetchImpl: typeof fetch = fetch
): Promise<TokenRow> {
  const res = await fetchImpl(`/api/chain/${chain}/tokens?id=${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error('could not read this token')
  return ((await res.json()) as { token: TokenRow }).token
}
