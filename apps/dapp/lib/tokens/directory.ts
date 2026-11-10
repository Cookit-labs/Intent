import { activeNetwork, tokenExplorerUrl } from '@intent/config'
import type { ChainSlug } from '@intent/types'

import { AVALANCHE_TOKENS, EVM_NATIVE_ID, MONAD_TOKENS } from '../chains/evm/tokens'
import { nearTokens } from '../chains/near/tokens'
import { SOLANA_TOKENS } from '../chains/solana/tokens'
import { SUI_TOKENS } from '../chains/sui/tokens'
import type { ChainToken } from '../chains/types'
import { knownSymbols, resolveAsset } from '../swap/assets'
import {
  DEXSCREENER_CHAIN,
  GECKO_NETWORK,
  bluefinVerified,
  cetusTokens,
  dexscreenerPools,
  dexscreenerSearch,
  dexscreenerTokens,
  fullSuiType,
  geckoHolders,
  geckoTokens,
  jupiterSearch,
  jupiterTop,
  lfjTokens,
  monorailHolders,
  monorailTokens,
  nativeMarketCaps,
  nearIntentsTokens,
  nearblocksHolders,
  nearblocksTokens,
  routescanHolders,
  soroswapCurated,
  stellarAssets,
  stellarSearch,
  type ReadJson,
  type StellarAsset,
  type TokenFigures,
} from './sources'
import type { TokenDirectory, TokenRow } from './types'

export type TokenChain = Extract<
  ChainSlug,
  'stellar' | 'solana' | 'sui' | 'near' | 'avalanche' | 'monad'
>

const CHAINS: readonly string[] = ['stellar', 'solana', 'sui', 'near', 'avalanche', 'monad']

export function isTokenChain(chain: string): chain is TokenChain {
  return CHAINS.includes(chain)
}

const CHECKED_BY_APP = 'Checked by Intent, and tradable here'
const LIST_MS = 5 * 60_000
const HOLDERS_MS = 6 * 60 * 60_000
const DETAIL_MS = 5 * 60_000
/** A list a source gave up on is asked for again soon, not left short for the whole five minutes. */
const PARTIAL_LIST_MS = 60_000
/** Holder counts are one call each, so only a few at a time: fewer against GeckoTerminal's limit. */
const HOLDERS_PER_LIST = 6
const GECKO_HOLDERS_PER_LIST = 3
/** The most tokens priced in one list, two DexScreener calls' worth. */
const PRICED_PER_LIST = 60
/** Who vouches for a token on each chain, beside what this app lists. */
const VOUCH: Readonly<Partial<Record<TokenChain, string>>> = {
  sui: 'Verified by Bluefin',
  near: 'Listed on NEAR Intents',
  avalanche: 'Listed by LFJ',
  monad: 'Chosen by Monorail',
  stellar: 'Listed by Soroswap',
}
/** CoinGecko's name for each chain's native coin, where its pools trade a wrapped form. */
const NATIVE_COIN: Readonly<Partial<Record<TokenChain, { symbol: string; coinId: string }>>> = {
  near: { symbol: 'NEAR', coinId: 'near' },
  avalanche: { symbol: 'AVAX', coinId: 'avalanche-2' },
  monad: { symbol: 'MON', coinId: 'monad' },
}
const GECKO_GAP_MS = 2_100
const GECKO_COOLDOWN_MS = 60_000
const READ_TIMEOUT_MS = 8_000

interface Listed {
  /** What this app calls it. */
  id: string
  /** What the data services call it: a native coin trades as its wrapped form. */
  dataId: string
  symbol: string
  name?: string | undefined
}

function fromTable(tokens: readonly ChainToken[]): Listed[] {
  return tokens.map((token) => {
    const wrapped =
      token.id === EVM_NATIVE_ID ? tokens.find((t) => t.symbol === `W${token.symbol}`) : undefined
    return {
      id: token.id,
      dataId: wrapped?.id ?? token.id,
      symbol: token.symbol,
      name: token.name,
    }
  })
}

function listedTokens(chain: TokenChain): Listed[] {
  switch (chain) {
    case 'solana':
      return fromTable(SOLANA_TOKENS)
    case 'sui':
      return fromTable(SUI_TOKENS)
    case 'near':
      return fromTable(nearTokens)
    case 'avalanche':
      return fromTable(AVALANCHE_TOKENS)
    case 'monad':
      return fromTable(MONAD_TOKENS)
    case 'stellar':
      return knownSymbols().flatMap((symbol) => {
        const asset = resolveAsset(symbol)
        if (asset === undefined) return []
        const id = asset.issuer === undefined ? asset.code : `${asset.code}:${asset.issuer}`
        return [{ id, dataId: id, symbol: asset.code }]
      })
  }
}

/** Hex addresses are the same whatever their case, and a Sui type however its address is padded. */
function keyOf(chain: TokenChain, id: string): string {
  if (chain === 'sui') return fullSuiType(id)
  return chain === 'avalanche' || chain === 'monad' ? id.toLowerCase() : id
}

function toRow(
  chain: TokenChain,
  figures: TokenFigures,
  listed: Listed[],
  vouched: ReadonlySet<string> = new Set()
): TokenRow {
  const key = keyOf(chain, figures.id)
  const mine = listed.find((t) => keyOf(chain, t.dataId) === key || keyOf(chain, t.id) === key)
  const symbol = mine?.symbol ?? figures.symbol ?? ''
  const namesake =
    mine === undefined
      ? listed.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase())
      : undefined
  const { vouchedBy, id: _id, marketCapUsd, fdvUsd, ...rest } = figures
  const id = mine?.id ?? figures.id
  return {
    ...rest,
    id,
    symbol,
    // Several sources answer 0 for a value they don't have. No token is worth nothing on purpose.
    ...(marketCapUsd !== undefined && marketCapUsd > 0 ? { marketCapUsd } : {}),
    ...(fdvUsd !== undefined && fdvUsd > 0 ? { fdvUsd } : {}),
    // Our own name for what we list: Jupiter calls SOL "Wrapped SOL", after the mint it trades as.
    ...(mine?.name !== undefined ? { name: mine.name } : {}),
    listed: mine !== undefined,
    verified: [
      ...(mine !== undefined ? [CHECKED_BY_APP] : []),
      ...(vouchedBy !== undefined ? [vouchedBy] : []),
      ...(vouched.has(key) && VOUCH[chain] !== undefined ? [VOUCH[chain] as string] : []),
    ],
    ...(namesake !== undefined ? { sameNameAs: namesake.symbol } : {}),
    explorerUrl: tokenExplorerUrl(chain, mine?.dataId ?? id),
  }
}

/** Later sources fill in what earlier ones left out, and never replace a figure already read. */
function merged(rows: readonly TokenFigures[]): Map<string, TokenFigures> {
  const byId = new Map<string, TokenFigures>()
  return rows.reduce((out, row) => out.set(row.id, { ...row, ...out.get(row.id) }), byId)
}

function byKey(chain: TokenChain, rows: readonly TokenFigures[]): TokenFigures[] {
  const normal = rows.map((row) => ({ ...row, id: keyOf(chain, row.id) }))
  return [...merged(normal).values()]
}

interface Read {
  figures: TokenFigures[]
  partial: boolean
  sources: string[]
  /** Tokens the chain's own list vouches for, by key. */
  vouched?: ReadonlySet<string>
  /** Show only tokens some source priced, or this app lists: a long list is mostly dead tokens. */
  pricedOnly?: boolean
}

function keys(chain: TokenChain, ids: Iterable<string>): Set<string> {
  return new Set([...ids].map((id) => keyOf(chain, id)))
}

function fromListed(listed: Listed[]): TokenFigures[] {
  return listed.map((t) => ({
    id: t.dataId,
    symbol: t.symbol,
    ...(t.name !== undefined ? { name: t.name } : {}),
  }))
}

async function attempt<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

async function readSolana(read: ReadJson, listed: Listed[]): Promise<Read> {
  const [top, mine] = await Promise.all([
    attempt(() => jupiterTop(read)),
    attempt(() => jupiterSearch(read, listed.map((t) => t.dataId).join(','))),
  ])
  const jupiter = [...(mine ?? []), ...(top ?? [])]
  // Jupiter counts a staked token's whole stake pool as its depth, so it reads as deep as its market
  // cap. What its pools hold is what someone can actually trade against.
  const pooled = jupiter.filter(
    (row) =>
      row.marketCapUsd !== undefined &&
      row.liquidityUsd !== undefined &&
      Math.abs(row.liquidityUsd - row.marketCapUsd) <= row.marketCapUsd * 0.01
  )
  const market =
    pooled.length === 0
      ? undefined
      : await attempt(() =>
          dexscreenerTokens(read, DEXSCREENER_CHAIN['solana'] as string, [
            ...new Set(pooled.map((row) => row.id)),
          ])
        )
  const depth = new Map((market ?? []).map((row) => [row.id, row.liquidityUsd]))
  return {
    figures: [
      ...jupiter.map((row) => {
        const pools = depth.get(row.id)
        return pools !== undefined && pooled.includes(row) ? { ...row, liquidityUsd: pools } : row
      }),
      ...fromListed(listed),
    ],
    partial: top === undefined || mine === undefined,
    sources: depth.size > 0 ? ['Jupiter', 'DexScreener'] : ['Jupiter'],
  }
}

/** Prices and depth from DexScreener, which reads each chain's own exchanges. */
async function readMarket(
  read: ReadJson,
  chain: TokenChain,
  ids: readonly string[]
): Promise<{ figures: TokenFigures[]; partial: boolean }> {
  const screener = DEXSCREENER_CHAIN[chain]
  if (screener === undefined) return { figures: [], partial: false }
  const found = await attempt(() =>
    dexscreenerTokens(read, screener, ids.slice(0, PRICED_PER_LIST))
  )
  return { figures: found ?? [], partial: found === undefined }
}

function idsOf(listed: Listed[], rows: readonly TokenFigures[] | undefined): string[] {
  return [...new Set([...listed.map((t) => t.dataId), ...(rows ?? []).map((row) => row.id)])]
}

/** Cetus's deepest pools say which tokens matter and how deep they run; Bluefin says which are real. */
async function readSui(read: ReadJson, listed: Listed[]): Promise<Read> {
  const [cetus, verified] = await Promise.all([
    attempt(() => cetusTokens(read)),
    attempt(() => bluefinVerified(read)),
  ])
  const ranked = [...(cetus ?? [])].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
  const market = await readMarket(read, 'sui', idsOf(listed, ranked))
  return {
    figures: [...ranked, ...market.figures, ...fromListed(listed)],
    partial: cetus === undefined || verified === undefined || market.partial,
    sources: ['Cetus', 'Bluefin', 'DexScreener'],
    vouched: verified ?? new Set(),
    pricedOnly: true,
  }
}

/** NEARBlocks ranks NEAR's tokens and prices them; NEAR Intents' list says which it will route. */
async function readNear(read: ReadJson, listed: Listed[]): Promise<Read> {
  const [nearblocks, intents] = await Promise.all([
    attempt(() => nearblocksTokens(read)),
    attempt(() => nearIntentsTokens(read, 'near')),
  ])
  const market = await readMarket(read, 'near', idsOf(listed, nearblocks))
  return {
    figures: [...(nearblocks ?? []), ...market.figures, ...fromListed(listed)],
    partial: nearblocks === undefined || intents === undefined || market.partial,
    sources: ['NEARBlocks', 'NEAR Intents', 'DexScreener'],
    vouched: keys('near', intents ?? []),
    pricedOnly: true,
  }
}

/** LFJ's token list says what is on Avalanche; DexScreener prices what is trading. */
async function readAvalanche(read: ReadJson, listed: Listed[]): Promise<Read> {
  const lfj = await attempt(() => lfjTokens(read))
  const market = await readMarket(read, 'avalanche', idsOf(listed, lfj))
  return {
    figures: [...market.figures, ...(lfj ?? []), ...fromListed(listed)],
    partial: lfj === undefined || market.partial,
    sources: ['LFJ', 'DexScreener'],
    vouched: keys(
      'avalanche',
      (lfj ?? []).map((t) => t.id)
    ),
    pricedOnly: true,
  }
}

/** Monorail's chosen groups say what is on Monad; DexScreener adds depth and the day's move. */
async function readMonad(read: ReadJson, listed: Listed[]): Promise<Read> {
  const monorail = await attempt(() => monorailTokens(read))
  const market = await readMarket(read, 'monad', idsOf(listed, monorail))
  return {
    figures: [...market.figures, ...(monorail ?? []), ...fromListed(listed)],
    partial: monorail === undefined || market.partial,
    sources: ['Monorail', 'DexScreener'],
    vouched: keys(
      'monad',
      (monorail ?? []).map((t) => t.id)
    ),
  }
}

function stellarNetwork(): 'public' | 'testnet' {
  return activeNetwork() === 'mainnet' ? 'public' : 'testnet'
}

async function readStellar(read: ReadJson, listed: Listed[]): Promise<Read> {
  const [assets, curated] = await Promise.all([
    attempt(() => stellarAssets(read, stellarNetwork())),
    stellarNetwork() === 'public' ? attempt(() => soroswapCurated(read)) : undefined,
  ])
  const contracts = (assets ?? [])
    .map((a) => a.contract)
    .filter((id): id is string => id !== undefined)
  const gecko = await attempt(() =>
    geckoTokens(read, GECKO_NETWORK['stellar'] as string, contracts.slice(0, 60))
  )
  const byContract = new Map((gecko ?? []).map((row) => [row.id, row]))
  const figures = (assets ?? []).map((asset: StellarAsset): TokenFigures => {
    const { contract, ...own } = asset
    const market = contract === undefined ? undefined : byContract.get(contract)
    return {
      ...own,
      ...(market?.liquidityUsd !== undefined ? { liquidityUsd: market.liquidityUsd } : {}),
      ...(market?.volume24hUsd !== undefined ? { volume24hUsd: market.volume24hUsd } : {}),
      ...(market?.marketCapUsd !== undefined ? { marketCapUsd: market.marketCapUsd } : {}),
      ...(market?.fdvUsd !== undefined ? { fdvUsd: market.fdvUsd } : {}),
      ...(own.icon === undefined && market?.icon !== undefined ? { icon: market.icon } : {}),
    }
  })
  return {
    figures: [...figures, ...fromListed(listed)],
    partial: assets === undefined || gecko === undefined,
    sources: [
      'StellarExpert',
      ...(curated !== undefined ? ['Soroswap'] : []),
      ...(gecko !== undefined ? ['GeckoTerminal'] : []),
    ],
    vouched: curated ?? new Set(),
  }
}

interface Cached<T> {
  value: T
  at: number
}

const lists = new Map<string, Cached<TokenDirectory>>()
const holderCounts = new Map<string, Cached<number>>()
const details = new Map<string, Cached<TokenRow>>()
const inFlight = new Map<string, Promise<TokenDirectory>>()

/** What a cached answer is for. Stellar serves two networks, and each has its own tokens. */
function scopeOf(chain: TokenChain): string {
  return chain === 'stellar' ? `stellar:${activeNetwork()}` : chain
}

export function resetTokenCache(): void {
  lists.clear()
  holderCounts.clear()
  details.clear()
  inFlight.clear()
}

function fresh<T>(entry: Cached<T> | undefined, ttl: number, now: number): T | undefined {
  return entry !== undefined && now - entry.at < ttl ? entry.value : undefined
}

/**
 * A few counts per read, the tokens this app trades first and then the rest, and stopping at the
 * first refusal. So the column fills in over a few reads rather than spending the limit on one.
 */
/** Where each chain's holder counts come from. Sui has no free native source, so it asks GeckoTerminal. */
function holdersReader(
  chain: TokenChain
): ((read: ReadJson, id: string) => Promise<number | undefined>) | undefined {
  switch (chain) {
    case 'near':
      return nearblocksHolders
    case 'avalanche':
      return (read, id) => routescanHolders(read, 43114, id)
    case 'monad':
      return monorailHolders
    case 'sui':
      return (read, id) => geckoHolders(read, GECKO_NETWORK['sui'] as string, id)
    default:
      return undefined
  }
}

async function fillHolders(
  read: ReadJson,
  chain: TokenChain,
  ids: readonly string[],
  now: number
): Promise<void> {
  const reader = holdersReader(chain)
  if (reader === undefined) return
  const limit = chain === 'sui' ? GECKO_HOLDERS_PER_LIST : HOLDERS_PER_LIST
  let asked = 0
  for (const id of ids) {
    const key = `${scopeOf(chain)}|${keyOf(chain, id)}`
    if (fresh(holderCounts.get(key), HOLDERS_MS, now) !== undefined) continue
    if (asked >= limit) return
    asked += 1
    const count = await attempt(() => reader(read, id))
    if (count === undefined) return
    holderCounts.set(key, { value: count, at: now })
  }
}

let geckoNextAt = 0
let geckoBlockedUntil = 0

/** Holds GeckoTerminal's calls to its limit, and stops asking for a while once it says no. */
async function geckoTurn(): Promise<void> {
  const now = Date.now()
  if (now < geckoBlockedUntil) throw new Error('429')
  const wait = Math.max(0, geckoNextAt - now)
  geckoNextAt = Math.max(now, geckoNextAt) + GECKO_GAP_MS
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

export const liveRead: ReadJson = async (url) => {
  const gecko = url.includes('api.geckoterminal.com')
  if (gecko) await geckoTurn()
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'intent-dapp' },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    cache: 'no-store',
  })
  if (gecko && res.status === 429) geckoBlockedUntil = Date.now() + GECKO_COOLDOWN_MS
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

async function buildDirectory(
  chain: TokenChain,
  read: ReadJson,
  now: number
): Promise<TokenDirectory> {
  const listed = listedTokens(chain)
  const readers: Record<TokenChain, (read: ReadJson, listed: Listed[]) => Promise<Read>> = {
    solana: readSolana,
    stellar: readStellar,
    sui: readSui,
    near: readNear,
    avalanche: readAvalanche,
    monad: readMonad,
  }
  const source = await readers[chain](read, listed)

  const listedKeys = keys(
    chain,
    listed.flatMap((t) => [t.id, t.dataId])
  )
  const unique = byKey(chain, source.figures).filter(
    (row) => source.pricedOnly !== true || row.priceUsd !== undefined || listedKeys.has(row.id)
  )
  if (chain !== 'solana' && chain !== 'stellar') {
    const ids = [...listed.map((t) => t.dataId), ...unique.map((row) => row.id)]
    await fillHolders(read, chain, [...new Set(ids)], now)
  }

  const native = NATIVE_COIN[chain]
  const caps =
    native === undefined ? undefined : await attempt(() => nativeMarketCaps(read, [native.coinId]))

  const tokens = unique.map((figures) => {
    const counted = holderCounts.get(`${scopeOf(chain)}|${figures.id}`)?.value
    const row = toRow(
      chain,
      figures.holders === undefined && counted !== undefined
        ? { ...figures, holders: counted }
        : figures,
      listed,
      source.vouched
    )
    if (native === undefined || row.symbol !== native.symbol || !row.listed) return row
    const { marketCapUsd: _wrapped, fdvUsd: _wrappedFdv, ...whole } = row
    const cap = caps?.get(native.coinId)
    return cap === undefined ? whole : { ...whole, marketCapUsd: cap }
  })
  return {
    tokens: tokens.sort(
      (a, b) => Number(b.listed) - Number(a.listed) || (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)
    ),
    partial: source.partial,
    sources: source.sources,
  }
}

/**
 * The tokens on a chain. A read that fails keeps the last one that worked, since old figures labelled
 * as possibly incomplete beat none, and a chain's own listed tokens are always in the answer.
 */
export async function tokenDirectory(
  chain: TokenChain,
  read: ReadJson = liveRead,
  now: number = Date.now()
): Promise<TokenDirectory> {
  const scope = scopeOf(chain)
  const held = lists.get(scope)
  const cached = fresh(held, LIST_MS, now)
  if (cached !== undefined) return cached
  const running = inFlight.get(scope)
  if (running !== undefined) return running

  const work = buildDirectory(chain, read, now)
    .then((built) => {
      const empty = built.partial && built.tokens.every((t) => t.priceUsd === undefined)
      if (empty && held !== undefined) return { ...held.value, partial: true }
      lists.set(scope, { value: built, at: built.partial ? now - LIST_MS + PARTIAL_LIST_MS : now })
      return built
    })
    .finally(() => inFlight.delete(scope))
  inFlight.set(scope, work)
  return work
}

const looksLikeOneWord = /^[^\s,]{1,64}$/

/** Searches what is already known, and asks a source only for something that isn't there. */
export async function searchTokens(
  chain: TokenChain,
  query: string,
  read: ReadJson = liveRead,
  now: number = Date.now()
): Promise<TokenDirectory> {
  const wanted = query.trim().toLowerCase()
  const directory = await tokenDirectory(chain, read, now)
  const known = directory.tokens.filter(
    (t) =>
      t.symbol.toLowerCase().includes(wanted) ||
      t.name?.toLowerCase().includes(wanted) === true ||
      t.id.toLowerCase() === wanted
  )
  if (known.some((t) => t.symbol.toLowerCase() === wanted || t.id.toLowerCase() === wanted)) {
    return { ...directory, tokens: known }
  }
  const listed = listedTokens(chain)
  const screener = DEXSCREENER_CHAIN[chain]
  const found = await attempt(async () => {
    if (chain === 'solana') return jupiterSearch(read, wanted)
    if (chain === 'stellar') return stellarSearch(read, stellarNetwork(), wanted)
    return screener === undefined ? [] : dexscreenerSearch(read, screener, wanted)
  })
  const knownIds = new Set(known.map((t) => keyOf(chain, t.id)))
  const more = byKey(chain, found ?? [])
    .map((figures) => {
      const { contract: _contract, ...own } = figures as StellarAsset
      return toRow(chain, own, listed)
    })
    .filter((t) => !knownIds.has(keyOf(chain, t.id)))
  return {
    ...directory,
    tokens: [...known, ...more].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)),
    partial: directory.partial || found === undefined,
  }
}

/** One token in full: everything the list has, its holder count and its pools. */
export async function tokenDetail(
  chain: TokenChain,
  id: string,
  read: ReadJson = liveRead,
  now: number = Date.now()
): Promise<TokenRow | undefined> {
  const cacheKey = `${scopeOf(chain)}|${id}`
  const cached = fresh(details.get(cacheKey), DETAIL_MS, now)
  if (cached !== undefined) return cached
  if (!looksLikeOneWord.test(id) && !id.includes(':')) return undefined

  const listed = listedTokens(chain)
  const mine = listed.find((t) => keyOf(chain, t.id) === keyOf(chain, id))
  const dataId = mine?.dataId ?? id
  const directory = await tokenDirectory(chain, read, now)
  const found = directory.tokens.find((t) => keyOf(chain, t.id) === keyOf(chain, id))

  let row = found
  if (row === undefined) {
    const searched = await searchTokens(chain, id, read, now)
    row = searched.tokens.find((t) => keyOf(chain, t.id) === keyOf(chain, id))
  }
  if (row === undefined && chain !== 'solana' && chain !== 'stellar') {
    const market = await readMarket(read, chain, [dataId])
    const figures = market.figures[0]
    row = figures === undefined ? undefined : toRow(chain, figures, listed)
  }
  if (row === undefined) return undefined

  let holders = row.holders
  const reader = holdersReader(chain)
  if (holders === undefined && reader !== undefined) {
    const key = `${scopeOf(chain)}|${keyOf(chain, dataId)}`
    holders = fresh(holderCounts.get(key), HOLDERS_MS, now)
    if (holders === undefined) {
      holders = await attempt(() => reader(read, dataId))
      if (holders !== undefined) holderCounts.set(key, { value: holders, at: now })
    }
  }
  const screener = DEXSCREENER_CHAIN[chain]
  const pools =
    screener === undefined
      ? undefined
      : await attempt(() => dexscreenerPools(read, screener, dataId))

  const detail: TokenRow = {
    ...row,
    ...(holders !== undefined ? { holders } : {}),
    ...(pools !== undefined ? { pools } : {}),
  }
  details.set(cacheKey, { value: detail, at: now })
  return detail
}
