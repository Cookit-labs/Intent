import type { TokenPool, TokenRow } from './types'

/**
 * The public services token figures come from, and how to read each. Nothing here decides what can
 * be traded: these answers are only ever shown. So every string that comes back is cut to size and
 * every link is held to its own service.
 *
 * No single free source covers all six chains. Jupiter knows Solana best and says what it has
 * verified. GeckoTerminal has the rest, with holder counts, but allows about 30 calls a minute, so
 * it is asked for as little as possible. DexScreener has a higher limit and fewer fields, so it
 * stands in when GeckoTerminal is busy, and lists pools. StellarExpert lists Stellar's assets.
 */

export type ReadJson = (url: string) => Promise<unknown>

export type TokenFigures = Partial<Omit<TokenRow, 'id' | 'verified' | 'listed' | 'explorerUrl'>> & {
  id: string
  /** Who vouches for it, only from a source that actually checks. */
  vouchedBy?: string
}

const TEXT_LIMIT = 48

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim()
  return clean === '' ? undefined : clean.slice(0, TEXT_LIMIT)
}

function figure(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function signed(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** An image is drawn on the page, so only a plain https address gets that far. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 500) return undefined
  try {
    return new URL(value).protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>
}

/** Leaves out what was not reported, so merging never overwrites a figure with nothing. */
function defined<T extends object>(row: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== undefined)
  ) as unknown as Defined<T>
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

const JUPITER = 'https://lite-api.jup.ag/tokens/v2'

function fromJupiter(raw: Record<string, unknown>): TokenFigures | undefined {
  const id = text(raw['id'])
  const symbol = text(raw['symbol'])
  if (id === undefined || symbol === undefined) return undefined
  const day = record(raw['stats24h'])
  const buy = figure(day['buyVolume'])
  const sell = figure(day['sellVolume'])
  return defined({
    id,
    symbol,
    name: text(raw['name']),
    icon: httpsUrl(raw['icon']),
    priceUsd: figure(raw['usdPrice']),
    change24h: signed(day['priceChange']),
    marketCapUsd: figure(raw['mcap']),
    fdvUsd: figure(raw['fdv']),
    liquidityUsd: figure(raw['liquidity']),
    volume24hUsd: buy === undefined && sell === undefined ? undefined : (buy ?? 0) + (sell ?? 0),
    holders: figure(raw['holderCount']),
    vouchedBy: raw['isVerified'] === true ? 'Verified by Jupiter' : undefined,
  })
}

export async function jupiterTop(read: ReadJson, limit = 100): Promise<TokenFigures[]> {
  const rows = list(await read(`${JUPITER}/toporganicscore/24h?limit=${limit}`))
  return rows.map(fromJupiter).filter((row): row is TokenFigures => row !== undefined)
}

/** Jupiter takes a name, a symbol, or up to 100 mints separated by commas. */
export async function jupiterSearch(read: ReadJson, query: string): Promise<TokenFigures[]> {
  const rows = list(await read(`${JUPITER}/search?query=${encodeURIComponent(query)}`))
  return rows.map(fromJupiter).filter((row): row is TokenFigures => row !== undefined)
}

const GECKO = 'https://api.geckoterminal.com/api/v2'

export const GECKO_NETWORK: Readonly<Record<string, string>> = {
  solana: 'solana',
  sui: 'sui-network',
  near: 'near',
  avalanche: 'avax',
  monad: 'monad',
  stellar: 'stellar',
}

export const GECKO_BATCH = 30

function fromGecko(raw: Record<string, unknown>): TokenFigures | undefined {
  const a = record(raw['attributes'])
  const address = typeof a['address'] === 'string' ? a['address'] : undefined
  const symbol = text(a['symbol'])
  if (address === undefined || symbol === undefined) return undefined
  return defined({
    id: address,
    symbol,
    name: text(a['name']),
    icon: httpsUrl(a['image_url']),
    priceUsd: figure(a['price_usd']),
    marketCapUsd: figure(a['market_cap_usd']),
    fdvUsd: figure(a['fdv_usd']),
    liquidityUsd: figure(a['total_reserve_in_usd']),
    volume24hUsd: figure(record(a['volume_usd'])['h24']),
    vouchedBy: text(a['coingecko_coin_id']) === undefined ? undefined : 'Listed on CoinGecko',
  })
}

/** The addresses of the tokens in a chain's busiest pools, which is what "tokens on it" means here. */
export async function geckoPoolTokens(
  read: ReadJson,
  network: string,
  pages = 2
): Promise<string[]> {
  const ids = new Set<string>()
  for (let page = 1; page <= pages; page += 1) {
    const body = record(
      await read(
        `${GECKO}/networks/${network}/pools?page=${page}&sort=h24_volume_usd_desc&include=base_token,quote_token`
      )
    )
    for (const item of list(body['included'])) {
      if (item['type'] !== 'token') continue
      const address = record(item['attributes'])['address']
      if (typeof address === 'string' && address !== '') ids.add(address)
    }
  }
  return [...ids]
}

export async function geckoTokens(
  read: ReadJson,
  network: string,
  ids: readonly string[]
): Promise<TokenFigures[]> {
  const out: TokenFigures[] = []
  for (let at = 0; at < ids.length; at += GECKO_BATCH) {
    const batch = ids.slice(at, at + GECKO_BATCH).map(encodeURIComponent)
    const body = record(await read(`${GECKO}/networks/${network}/tokens/multi/${batch.join(',')}`))
    for (const raw of list(body['data'])) {
      const row = fromGecko(raw)
      if (row !== undefined) out.push(row)
    }
  }
  return out
}

export async function geckoHolders(
  read: ReadJson,
  network: string,
  id: string
): Promise<number | undefined> {
  const body = record(
    await read(`${GECKO}/networks/${network}/tokens/${encodeURIComponent(id)}/info`)
  )
  return figure(record(record(record(body['data'])['attributes'])['holders'])['count'])
}

const DEXSCREENER = 'https://api.dexscreener.com'

export const DEXSCREENER_CHAIN: Readonly<Record<string, string>> = {
  solana: 'solana',
  sui: 'sui',
  near: 'near',
  avalanche: 'avalanche',
  monad: 'monad',
}

export const DEXSCREENER_BATCH = 30

function fromPair(pair: Record<string, unknown>): TokenFigures | undefined {
  const base = record(pair['baseToken'])
  const id = typeof base['address'] === 'string' ? base['address'] : undefined
  const symbol = text(base['symbol'])
  if (id === undefined || symbol === undefined) return undefined
  return defined({
    id,
    symbol,
    name: text(base['name']),
    icon: httpsUrl(record(pair['info'])['imageUrl']),
    priceUsd: figure(pair['priceUsd']),
    change24h: signed(record(pair['priceChange'])['h24']),
    marketCapUsd: figure(pair['marketCap']),
    fdvUsd: figure(pair['fdv']),
    liquidityUsd: figure(record(pair['liquidity'])['usd']),
    volume24hUsd: figure(record(pair['volume'])['h24']),
  })
}

export async function dexscreenerTokens(
  read: ReadJson,
  chain: string,
  ids: readonly string[]
): Promise<TokenFigures[]> {
  const out: TokenFigures[] = []
  for (let at = 0; at < ids.length; at += DEXSCREENER_BATCH) {
    const batch = ids.slice(at, at + DEXSCREENER_BATCH).map(encodeURIComponent)
    for (const pair of list(await read(`${DEXSCREENER}/tokens/v1/${chain}/${batch.join(',')}`))) {
      const row = fromPair(pair)
      if (row !== undefined) out.push(row)
    }
  }
  return out
}

export async function dexscreenerSearch(
  read: ReadJson,
  chain: string,
  query: string
): Promise<TokenFigures[]> {
  const body = record(await read(`${DEXSCREENER}/latest/dex/search?q=${encodeURIComponent(query)}`))
  const best = new Map<string, TokenFigures>()
  for (const pair of list(body['pairs'])) {
    if (pair['chainId'] !== chain) continue
    const row = fromPair(pair)
    if (row === undefined) continue
    const held = best.get(row.id)
    if (held === undefined || (row.liquidityUsd ?? 0) > (held.liquidityUsd ?? 0)) {
      best.set(row.id, row)
    }
  }
  return [...best.values()]
}

const DEXSCREENER_SITE = 'https://dexscreener.com/'

/** The pools a token trades in, deepest first. */
export async function dexscreenerPools(
  read: ReadJson,
  chain: string,
  id: string,
  limit = 5
): Promise<TokenPool[]> {
  const pairs = list(await read(`${DEXSCREENER}/token-pairs/v1/${chain}/${encodeURIComponent(id)}`))
  return pairs
    .map((pair): TokenPool | undefined => {
      const dex = text(pair['dexId'])
      const base = text(record(pair['baseToken'])['symbol'])
      const quote = text(record(pair['quoteToken'])['symbol'])
      if (dex === undefined || base === undefined || quote === undefined) return undefined
      const url = httpsUrl(pair['url'])
      return defined({
        // Some chains report a router's address as the dex. It says nothing to a person.
        dex: /^0x[0-9a-f]{20,}$/i.test(dex) ? 'Unnamed pool' : dex,
        pair: `${base}/${quote}`,
        liquidityUsd: figure(record(pair['liquidity'])['usd']),
        volume24hUsd: figure(record(pair['volume'])['h24']),
        url: url?.startsWith(DEXSCREENER_SITE) === true ? url : undefined,
      })
    })
    .filter((pool): pool is TokenPool => pool !== undefined)
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    .slice(0, limit)
}

/**
 * What a chain's native coin is worth as a whole. Its pools trade the wrapped form, whose market cap
 * is only what happens to be wrapped: AVAX read as $156M that way, when it is billions.
 */
export async function nativeMarketCaps(
  read: ReadJson,
  coinIds: readonly string[]
): Promise<Map<string, number>> {
  const body = record(
    await read(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinIds.join(',')}&vs_currencies=usd&include_market_cap=true`
    )
  )
  const caps = new Map<string, number>()
  for (const id of coinIds) {
    const cap = figure(record(body[id])['usd_market_cap'])
    if (cap !== undefined && cap > 0) caps.set(id, cap)
  }
  return caps
}

const STELLAR_EXPERT = 'https://api.stellar.expert/explorer'
const STROOPS = 1e7
/** StellarExpert rates an asset out of ten. Below this it says little in the asset's favour. */
const RATING_THAT_VOUCHES = 7

export interface StellarAsset extends TokenFigures {
  /** Its contract address, which is how GeckoTerminal knows it. */
  contract?: string
}

function fromStellarExpert(raw: Record<string, unknown>): StellarAsset | undefined {
  const full = typeof raw['asset'] === 'string' ? raw['asset'] : undefined
  if (full === undefined) return undefined
  const [code, issuer] = full.split('-')
  if (code === undefined || code === '') return undefined
  const rating = figure(record(raw['rating'])['average'])
  const toml = record(raw['tomlInfo'])
  const price = figure(raw['price'])
  const supply = figure(raw['supply'])
  return defined({
    id: issuer === undefined ? code : `${code}:${issuer}`,
    symbol: code,
    name: text(toml['name']) ?? text(raw['domain']),
    icon: httpsUrl(toml['image']),
    priceUsd: price,
    // All that was ever issued, and not what is circulating, so this is never a market cap.
    fdvUsd: price !== undefined && supply !== undefined ? (supply / STROOPS) * price : undefined,
    holders: figure(record(raw['trustlines'])['total']),
    contract: typeof raw['contract'] === 'string' ? raw['contract'] : undefined,
    vouchedBy:
      rating !== undefined && rating >= RATING_THAT_VOUCHES
        ? `Rated ${rating} of 10 by StellarExpert`
        : undefined,
  })
}

function stellarRecords(body: unknown): StellarAsset[] {
  return list(record(record(body)['_embedded'])['records'])
    .map(fromStellarExpert)
    .filter((row): row is StellarAsset => row !== undefined)
}

export async function stellarAssets(
  read: ReadJson,
  network: 'public' | 'testnet',
  limit = 100
): Promise<StellarAsset[]> {
  return stellarRecords(
    await read(`${STELLAR_EXPERT}/${network}/asset?sort=rating&order=desc&limit=${limit}`)
  )
}

export async function stellarSearch(
  read: ReadJson,
  network: 'public' | 'testnet',
  query: string
): Promise<StellarAsset[]> {
  return stellarRecords(
    await read(
      `${STELLAR_EXPERT}/${network}/asset?search=${encodeURIComponent(query)}&sort=rating&order=desc&limit=20`
    )
  )
}
