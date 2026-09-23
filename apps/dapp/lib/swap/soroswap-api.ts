/**
 * Soroswap's hosted API, spoken to directly.
 *
 * This is the aggregator's front door, and a different product from the
 * Soroswap AMM the app already simulates against in `sources/soroswap-quoter`.
 * The API does route-finding off-chain — splitting a swap across Soroswap's
 * pools, Aquarius's and the classic order book — and hands back an unsigned
 * transaction. Nothing here signs; the XDR is read, checked and only then
 * shown to a wallet, in `build-aggregator.ts`.
 *
 * Why not `@soroswap/sdk`: it wraps these same three calls in axios with no
 * way to inject a transport, so every test of it would be a network test. The
 * wire format below was read from the API's own OpenAPI document (served at
 * `/api-json`) and from the SDK's serialiser rather than guessed: the key is a
 * bearer token and an `X-API-Key` header is a 403; amounts are decimal strings
 * of stroops; and the quote object goes back to `/quote/build` exactly as it
 * came, because the API reads its own `rawTrade` out of it.
 *
 * Key-gated. `/quote` and `/quote/build` return 403 without one, and the
 * contract-id lookups need none. Register at https://api.soroswap.finance/register.
 */

export const SOROSWAP_API_URL = 'https://api.soroswap.finance'

/** How long a resolved contract id is trusted before it is asked for again. */
export const CONTRACT_TTL_MS = 5 * 60_000

/**
 * The request vocabulary, not testnet capability. `phoenix` is listed by the
 * API for every network while its testnet adapter points at a contract that
 * does not exist; the quoter never sends it, and `aggregator-protocols.ts`
 * says why.
 */
export type AggregatorProtocol = 'soroswap' | 'aqua' | 'sdex' | 'phoenix' | 'comet' | 'sushi'

/**
 * Which shape the built transaction takes. The API decides per quote: a
 * split across venues invokes the aggregator contract, a single Soroswap
 * route invokes the router alone, and a classic-DEX route is a path payment.
 * Each is validated differently, so the platform travels with the quote.
 */
export type AggregatorPlatform = 'aggregator' | 'router' | 'sdex'

export interface RoutePlanLeg {
  protocol: string
  /** Contract ids, endpoints included. */
  path: string[]
  /** Share of the input this leg fills, as the API's percent string. */
  percent: string
}

export interface AggregatorApiQuote {
  assetIn: string
  assetOut: string
  /** Base units. Strings, whatever the API sent — see `integerString`. */
  amountIn: string
  amountOut: string
  /** The floor the API wrote into its route, after the slippage it was asked for. */
  otherAmountThreshold: string
  platform: AggregatorPlatform
  routePlan: RoutePlanLeg[]
  /** The response verbatim; `/quote/build` wants it back untouched. */
  raw: Record<string, unknown>
}

export interface AggregatorQuoteRequest {
  assetIn: string
  assetOut: string
  /** Base units. */
  amount: string
  protocols: readonly AggregatorProtocol[]
  slippageBps: number
}

export type ApiFailureReason = 'unavailable' | 'no_route' | 'upstream_error' | 'timeout'

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ApiFailureReason; detail?: string }

export type SoroswapContractName = 'factory' | 'router' | 'aggregator'

export interface SoroswapApiOptions {
  /** Defaults to `SOROSWAP_API_KEY`. Empty means the aggregator is absent. */
  apiKey?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Injected in tests so the cache's clock can be moved. */
  now?: () => number
  contractTtlMs?: number
}

export interface SoroswapApi {
  isConfigured: () => boolean
  quote: (
    req: AggregatorQuoteRequest,
    signal?: AbortSignal
  ) => Promise<ApiResult<AggregatorApiQuote>>
  /** Unsigned XDR for a quote, paying the account that funds it. */
  build: (
    quote: AggregatorApiQuote,
    account: string,
    signal?: AbortSignal
  ) => Promise<ApiResult<string>>
  /**
   * The live id of one of Soroswap's contracts, or nothing if it cannot be
   * read. Never throws; a failure is not cached.
   */
  contractAddress: (name: SoroswapContractName) => Promise<string | undefined>
}

/** Only testnet exists for this app. Stated once so it cannot drift per call. */
const NETWORK = 'testnet'

/**
 * Resolved ids, keyed by base URL and contract name.
 *
 * Module-level rather than per instance because a quoter is created per
 * request and a cache that lived as long as one would resolve on every quote.
 * The committed address file in Soroswap's own repository lists dead Phoenix
 * contracts, which is why nothing here is read from a file: an id is asked
 * for at runtime and trusted for `CONTRACT_TTL_MS`.
 */
const contractCache = new Map<string, { address: string; expiresAt: number }>()

/** For tests, which otherwise share the cache above. */
export function resetSoroswapApiCache(): void {
  contractCache.clear()
}

const CONTRACT_ID = /^C[A-Z2-7]{55}$/

/**
 * A base-unit amount as a string, from whichever of the two shapes the API
 * uses. Its examples show `amountIn` as a string and `amountOut` as a number
 * on the same response. A number is accepted only while it is a safe integer;
 * beyond that the value has already lost digits and there is nothing to
 * recover.
 */
function integerString(value: unknown): string | undefined {
  if (typeof value === 'string') return /^\d+$/.test(value) ? value : undefined
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value.toString()
  }
  return undefined
}

function isPlatform(value: unknown): value is AggregatorPlatform {
  return value === 'aggregator' || value === 'router' || value === 'sdex'
}

function readRoutePlan(value: unknown): RoutePlanLeg[] | undefined {
  if (!Array.isArray(value)) return undefined
  const legs: RoutePlanLeg[] = []
  for (const item of value) {
    const leg = item as { swapInfo?: { protocol?: unknown; path?: unknown }; percent?: unknown }
    const protocol = leg?.swapInfo?.protocol
    const path = leg?.swapInfo?.path
    if (typeof protocol !== 'string' || !Array.isArray(path)) return undefined
    if (!path.every((p) => typeof p === 'string')) return undefined
    legs.push({
      protocol,
      path: path as string[],
      percent: typeof leg.percent === 'number' ? String(leg.percent) : String(leg.percent ?? ''),
    })
  }
  return legs
}

/** The typed view of a quote, or a reason it cannot be trusted. */
export function readApiQuote(
  body: unknown
): { ok: true; quote: AggregatorApiQuote } | { ok: false; detail: string } {
  if (body === null || typeof body !== 'object')
    return { ok: false, detail: 'quote is not an object' }
  const raw = body as Record<string, unknown>

  if (raw['tradeType'] !== 'EXACT_IN') {
    return { ok: false, detail: `tradeType ${String(raw['tradeType'])} is not EXACT_IN` }
  }
  const assetIn = raw['assetIn']
  const assetOut = raw['assetOut']
  if (typeof assetIn !== 'string' || typeof assetOut !== 'string') {
    return { ok: false, detail: 'quote names no assets' }
  }
  const amountIn = integerString(raw['amountIn'])
  const amountOut = integerString(raw['amountOut'])
  const otherAmountThreshold = integerString(raw['otherAmountThreshold'])
  if (amountIn === undefined || amountOut === undefined || otherAmountThreshold === undefined) {
    return { ok: false, detail: 'quote amounts are not integers' }
  }
  if (!isPlatform(raw['platform'])) {
    return { ok: false, detail: `platform ${String(raw['platform'])} is not one this app builds` }
  }
  const routePlan = readRoutePlan(raw['routePlan'])
  if (routePlan === undefined) return { ok: false, detail: 'quote has no readable route plan' }

  return {
    ok: true,
    quote: {
      assetIn,
      assetOut,
      amountIn,
      amountOut,
      otherAmountThreshold,
      platform: raw['platform'],
      routePlan,
      raw,
    },
  }
}

/** The API's error body, whichever of its shapes it took. */
function messageOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const message = (body as { message?: unknown }).message
  if (typeof message === 'string') return message
  if (Array.isArray(message)) return message.map(String).join('; ')
  return undefined
}

export function createSoroswapApi(options: SoroswapApiOptions = {}): SoroswapApi {
  const apiKey = options.apiKey ?? process.env['SOROSWAP_API_KEY'] ?? ''
  const baseUrl = (options.baseUrl ?? SOROSWAP_API_URL).replace(/\/$/, '')
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const ttl = options.contractTtlMs ?? CONTRACT_TTL_MS

  /**
   * One keyed POST, with the API's status codes mapped onto the quoter's
   * vocabulary. A rejected key is `unavailable` rather than `no_route`: the
   * pair may well have a route, and reporting it as thin would send someone
   * looking at liquidity instead of at the key.
   */
  async function post(
    path: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<ApiResult<unknown>> {
    let res: Response
    try {
      res = await doFetch(`${baseUrl}${path}?network=${NETWORK}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError'
      return {
        ok: false,
        reason: aborted ? 'timeout' : 'upstream_error',
        ...(e instanceof Error ? { detail: e.message } : {}),
      }
    }

    let parsed: unknown
    try {
      parsed = await res.json()
    } catch {
      return { ok: false, reason: 'upstream_error', detail: `HTTP ${res.status}: not JSON` }
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'unavailable', detail: 'the API key was rejected' }
    }
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      // The API's answer to a pair it cannot route, and to inputs it will not
      // accept. Both are ordinary outcomes for this source, not faults.
      return { ok: false, reason: 'no_route', detail: messageOf(parsed) ?? `HTTP ${res.status}` }
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: 'upstream_error',
        detail: messageOf(parsed) ?? `HTTP ${res.status}`,
      }
    }
    return { ok: true, value: parsed }
  }

  return {
    isConfigured: () => apiKey !== '',

    async quote(req, signal) {
      const out = await post(
        '/quote',
        {
          assetIn: req.assetIn,
          assetOut: req.assetOut,
          // A decimal string, as the SDK serialises its bigint. JSON has no
          // integer type wide enough for stroop counts.
          amount: req.amount,
          tradeType: 'EXACT_IN',
          protocols: [...req.protocols],
          slippageBps: req.slippageBps,
        },
        signal
      )
      if (!out.ok) return out

      const read = readApiQuote(out.value)
      if (!read.ok) {
        return { ok: false, reason: 'upstream_error', detail: `malformed quote: ${read.detail}` }
      }
      return { ok: true, value: read.quote }
    },

    async build(quote, account, signal) {
      // `to` is the funding account, stated here and nowhere else. The API
      // would pay any address it is given; this client has no parameter for
      // one, and the builder re-reads the recipient out of the XDR anyway.
      const out = await post(
        '/quote/build',
        { quote: quote.raw, from: account, to: account },
        signal
      )
      if (!out.ok) return out

      const xdr = (out.value as { xdr?: unknown } | null)?.xdr
      if (typeof xdr !== 'string' || xdr === '') {
        return { ok: false, reason: 'upstream_error', detail: 'build returned no xdr' }
      }
      return { ok: true, value: xdr }
    },

    async contractAddress(name) {
      const key = `${baseUrl}/${NETWORK}/${name}`
      const cached = contractCache.get(key)
      if (cached !== undefined && cached.expiresAt > now()) return cached.address

      try {
        const res = await doFetch(`${baseUrl}/api/${NETWORK}/${name}`, {
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) return undefined
        const body = (await res.json()) as { address?: unknown } | null
        const address = body?.address
        if (typeof address !== 'string' || !CONTRACT_ID.test(address)) return undefined
        contractCache.set(key, { address, expiresAt: now() + ttl })
        return address
      } catch {
        return undefined
      }
    },
  }
}
