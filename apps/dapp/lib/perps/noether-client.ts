/**
 * Noether's HTTP gateway: reads, the API-key handshake, prepare and submit.
 *
 * Noether is a perpetual-futures DEX on Stellar testnet, and testnet only —
 * mainnet has not launched. Its npm SDK (`noether-sdk` 0.2.0) defaults to
 * `api.noether.exchange`, which does not resolve (NXDOMAIN on 2026-09-23,
 * as does `docs.noether.exchange`). The host that answers was extracted from
 * the production JS bundle and serves live Swagger at `/docs` and the spec
 * at `/docs/json`. It is an env var because a dev-tagged gateway on a cloud
 * container app can move; the default is the only one known to work.
 *
 * The SDK is not a dependency: it pins `@stellar/stellar-sdk@^14` against
 * this app's `^17`, and its entire client is thin `fetch` over the shapes
 * below, which were read from the live spec and confirmed by calling them.
 *
 * `fetch` is injected so every path here is tested without a network. The
 * gateway reports `version: 0.0.0-dev`; the venue text says so.
 */

export const DEFAULT_NOETHER_API_URL =
  'https://noether-api.proudmeadow-533cf0d8.germanywestcentral.azurecontainerapps.io'

export function noetherApiUrl(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): string {
  const configured = env['NOETHER_API_URL']
  const url = configured !== undefined && configured !== '' ? configured : DEFAULT_NOETHER_API_URL
  return url.replace(/\/+$/, '')
}

/** The label a key minted by this app carries on the gateway's key list. */
const KEY_LABEL = 'intent-dapp'

/** The gateway did not answer, or answered without the contracts a trade needs. */
export class NoetherOfflineError extends Error {}

/** The gateway answered with an error status. `code` is its `error` field. */
export class NoetherHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

export interface NoetherContracts {
  market: string
  router: string
  vault: string
  /** The USDC token the market takes as collateral — its own, not Circle's. */
  usdcToken: string
}

export interface NoetherHealth {
  version: string
  network: string
  contracts: NoetherContracts
  /** True when the market's pause mode is anything but 0. */
  paused: boolean
  /** Age of the indexer's last ledger, when reported. */
  ledgerAgeSeconds?: number
}

export interface NoetherMarket {
  asset: string
  name: string
  decimals: number
  /** The oracle price, 7 decimals, as a base-unit string. */
  markPrice: string
  markPriceUsd: number
  priceTimestamp: number
}

export interface NoetherMarketStats {
  asset: string
  /** USD notional, 7 decimals. */
  openInterestLong: string
  openInterestShort: string
  openPositions: number
  volume24h: string
  headroomLong?: string
  headroomShort?: string
}

export interface NoetherVault {
  id: number
  name: string
  totalUsdc: string
  apyBps: number
  apyKind?: string
}

export interface NoetherKey {
  keyId: string
  secret: string
}

/** The bearer the gateway reads: `Bearer <keyId>:<secret>`, per its own 401 hint. */
export function sessionToken(key: NoetherKey): string {
  return `${key.keyId}:${key.secret}`
}

export interface PrepareOpenRequest {
  token: string
  asset: string
  /** Collateral in the market's USDC, 7-decimal base units. */
  collateral: string
  leverage: number
  side: 'long' | 'short'
}

export interface PreparedOpen {
  op: string
  trader: string
  /** Unsigned, simulated, assembled. Never signed before `assertPerpOrder`. */
  xdr: string
}

export interface NoetherSubmitResult {
  hash: string
  status: 'SUCCESS' | 'PENDING' | 'FAILED'
  ledger?: number
  contractError?: { code: number; name: string }
  hostError?: { type: string; code: string }
  txResultCode?: string
}

export interface NoetherClient {
  readHealth: () => Promise<NoetherHealth>
  readMarkets: () => Promise<NoetherMarket[]>
  readStats: () => Promise<NoetherMarketStats[]>
  readVaults: () => Promise<NoetherVault[]>
  betaStatus: (address: string) => Promise<{ gated: boolean; allowed: boolean }>
  requestChallenge: (address: string) => Promise<{ challengeHex: string; expiresAt: number }>
  exchangeChallenge: (input: {
    address: string
    challengeHex: string
    signedXdr: string
  }) => Promise<NoetherKey>
  prepareOpen: (req: PrepareOpenRequest) => Promise<PreparedOpen>
  submit: (req: { token: string; signedXdr: string }) => Promise<NoetherSubmitResult>
}

export interface NoetherClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
}

interface Call {
  method?: 'GET' | 'POST'
  body?: unknown
  token?: string
}

export function createNoetherClient(options: NoetherClientOptions = {}): NoetherClient {
  const base = (options.baseUrl ?? noetherApiUrl()).replace(/\/+$/, '')
  const doFetch = options.fetchImpl ?? fetch

  async function call<T>(path: string, opts: Call = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.token !== undefined) headers['Authorization'] = `Bearer ${opts.token}`

    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method: opts.method ?? 'GET',
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      })
    } catch (e) {
      throw new NoetherOfflineError(
        `Noether's gateway did not answer: ${e instanceof Error ? e.message : 'network error'}`
      )
    }

    let parsed: unknown
    try {
      parsed = await res.json()
    } catch {
      throw new NoetherHttpError(
        res.status,
        `Noether's gateway answered ${res.status} without JSON`
      )
    }

    if (!res.ok) {
      const body = parsed as { error?: unknown; message?: unknown; hint?: unknown }
      const code = typeof body.error === 'string' ? body.error : undefined
      const detail =
        typeof body.message === 'string'
          ? body.message
          : typeof body.hint === 'string'
            ? body.hint
            : (code ?? `HTTP ${res.status}`)
      throw new NoetherHttpError(res.status, `Noether's gateway refused: ${detail}`, code)
    }
    return parsed as T
  }

  return {
    async readHealth() {
      let raw: {
        version?: unknown
        network?: unknown
        contracts?: Record<string, { address?: unknown } | undefined>
        market?: { pauseState?: { mode?: unknown } }
        indexer?: { ledgerAgeSeconds?: unknown }
      }
      try {
        raw = await call('/v1/health')
      } catch (e) {
        if (e instanceof NoetherOfflineError) throw e
        throw new NoetherOfflineError(
          `Noether's health check failed: ${e instanceof Error ? e.message : 'unknown'}`
        )
      }

      // The gateway names which network it serves. This app is testnet-only,
      // and a contract id from another network would fail at simulation with
      // a message about nothing.
      if (raw.network !== 'testnet') {
        throw new NoetherOfflineError(
          `Noether's gateway serves ${String(raw.network)}, and this app trades only on testnet`
        )
      }

      // Resolved from the gateway on every read rather than pinned: testnet
      // resets remove contracts, and the gateway reports what it actually
      // serves. A missing one is the venue being offline, not a default.
      const address = (key: string): string => {
        const value = raw.contracts?.[key]?.address
        if (typeof value !== 'string' || value === '') {
          throw new NoetherOfflineError(`Noether's gateway lists no ${key} contract; venue offline`)
        }
        return value
      }
      const contracts: NoetherContracts = {
        market: address('market'),
        router: address('noetherRouter'),
        vault: address('vault'),
        usdcToken: address('usdcToken'),
      }

      const mode = raw.market?.pauseState?.mode
      const age = raw.indexer?.ledgerAgeSeconds
      return {
        version: typeof raw.version === 'string' ? raw.version : 'unknown',
        network: raw.network,
        contracts,
        paused: typeof mode === 'number' && mode !== 0,
        ...(typeof age === 'number' ? { ledgerAgeSeconds: age } : {}),
      }
    },

    async readMarkets() {
      const raw = await call<{
        markets?: {
          asset?: { symbol?: unknown; name?: unknown; decimals?: unknown }
          oracle?: { price?: unknown; priceFloat?: unknown; timestamp?: unknown }
        }[]
      }>('/v1/markets')
      const out: NoetherMarket[] = []
      for (const m of raw.markets ?? []) {
        const symbol = m.asset?.symbol
        const price = m.oracle?.price
        const priceFloat = m.oracle?.priceFloat
        if (
          typeof symbol !== 'string' ||
          typeof price !== 'string' ||
          typeof priceFloat !== 'number'
        )
          continue
        out.push({
          asset: symbol,
          name: typeof m.asset?.name === 'string' ? m.asset.name : symbol,
          decimals: typeof m.asset?.decimals === 'number' ? m.asset.decimals : 7,
          markPrice: price,
          markPriceUsd: priceFloat,
          priceTimestamp: typeof m.oracle?.timestamp === 'number' ? m.oracle.timestamp : 0,
        })
      }
      return out
    },

    async readStats() {
      const raw = await call<{
        stats?: {
          asset?: unknown
          openInterestLong?: unknown
          openInterestShort?: unknown
          openPositions?: unknown
          volume24h?: unknown
          capacity?: { headroomLong?: unknown; headroomShort?: unknown }
        }[]
      }>('/v1/markets/stats')
      const out: NoetherMarketStats[] = []
      for (const s of raw.stats ?? []) {
        if (
          typeof s.asset !== 'string' ||
          typeof s.openInterestLong !== 'string' ||
          typeof s.openInterestShort !== 'string'
        )
          continue
        const headroomLong = s.capacity?.headroomLong
        const headroomShort = s.capacity?.headroomShort
        out.push({
          asset: s.asset,
          openInterestLong: s.openInterestLong,
          openInterestShort: s.openInterestShort,
          openPositions: typeof s.openPositions === 'number' ? s.openPositions : 0,
          volume24h: typeof s.volume24h === 'string' ? s.volume24h : '0',
          ...(typeof headroomLong === 'string' ? { headroomLong } : {}),
          ...(typeof headroomShort === 'string' ? { headroomShort } : {}),
        })
      }
      return out
    },

    async readVaults() {
      const raw = await call<{
        vaults?: {
          id?: unknown
          name?: unknown
          totalUsdc?: unknown
          apyBps?: unknown
          apyKind?: unknown
        }[]
      }>('/v1/vaults')
      const out: NoetherVault[] = []
      for (const v of raw.vaults ?? []) {
        if (typeof v.id !== 'number' || typeof v.name !== 'string') continue
        out.push({
          id: v.id,
          name: v.name,
          totalUsdc: typeof v.totalUsdc === 'string' ? v.totalUsdc : '0',
          apyBps: typeof v.apyBps === 'number' ? v.apyBps : 0,
          ...(typeof v.apyKind === 'string' ? { apyKind: v.apyKind } : {}),
        })
      }
      return out
    },

    async betaStatus(address) {
      const raw = await call<{ gated?: unknown; allowed?: unknown }>(
        `/v1/keys/beta-status?address=${encodeURIComponent(address)}`
      )
      return { gated: raw.gated === true, allowed: raw.allowed === true }
    },

    async requestChallenge(address) {
      const raw = await call<{ challengeHex?: unknown; expiresAt?: unknown }>(
        '/v1/keys/challenge',
        {
          method: 'POST',
          body: { address },
        }
      )
      if (typeof raw.challengeHex !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.challengeHex)) {
        throw new Error("Noether's gateway issued no challenge")
      }
      return {
        challengeHex: raw.challengeHex,
        expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
      }
    },

    async exchangeChallenge(input) {
      // The wire field is `signature`, but it carries the whole signed
      // envelope: the gateway's verifier parses it as a transaction and
      // checks any signature against the address (its walletAuth.ts).
      const raw = await call<{ keyId?: unknown; secret?: unknown }>('/v1/keys', {
        method: 'POST',
        body: {
          address: input.address,
          challenge: input.challengeHex,
          signature: input.signedXdr,
          label: KEY_LABEL,
        },
      })
      if (typeof raw.keyId !== 'string' || typeof raw.secret !== 'string') {
        throw new Error("Noether's gateway returned no key")
      }
      return { keyId: raw.keyId, secret: raw.secret }
    },

    async prepareOpen(req) {
      // The gateway's schema takes collateral as a decimal-digit string. A
      // display figure passed by mistake would be read as stroops and open a
      // position ten million times too small.
      if (!/^[0-9]+$/.test(req.collateral)) {
        throw new Error(`collateral must be in base units, got ${req.collateral}`)
      }
      const raw = await call<{ op?: unknown; trader?: unknown; xdr?: unknown }>(
        '/v1/orders/prepare',
        {
          method: 'POST',
          token: req.token,
          body: {
            op: 'open_position',
            asset: req.asset,
            collateral: req.collateral,
            leverage: req.leverage,
            direction: req.side === 'long' ? 'Long' : 'Short',
          },
        }
      )
      if (typeof raw.xdr !== 'string' || raw.xdr === '') {
        throw new Error("Noether's gateway prepared no transaction")
      }
      return {
        op: typeof raw.op === 'string' ? raw.op : 'open_position',
        trader: typeof raw.trader === 'string' ? raw.trader : '',
        xdr: raw.xdr,
      }
    },

    async submit(req) {
      const raw = await call<{
        hash?: unknown
        status?: unknown
        ledger?: unknown
        contractError?: { code?: unknown; name?: unknown } | null
        hostError?: { type?: unknown; code?: unknown } | null
        txResultCode?: unknown
      }>('/v1/tx/submit', { method: 'POST', token: req.token, body: { signedXdr: req.signedXdr } })
      if (typeof raw.hash !== 'string' || typeof raw.status !== 'string') {
        throw new Error("Noether's gateway returned no submission status")
      }
      const status = raw.status === 'SUCCESS' || raw.status === 'PENDING' ? raw.status : 'FAILED'
      const contractError =
        raw.contractError !== null &&
        raw.contractError !== undefined &&
        typeof raw.contractError.code === 'number' &&
        typeof raw.contractError.name === 'string'
          ? { code: raw.contractError.code, name: raw.contractError.name }
          : undefined
      const hostError =
        raw.hostError !== null &&
        raw.hostError !== undefined &&
        typeof raw.hostError.type === 'string' &&
        typeof raw.hostError.code === 'string'
          ? { type: raw.hostError.type, code: raw.hostError.code }
          : undefined
      return {
        hash: raw.hash,
        status,
        ...(typeof raw.ledger === 'number' ? { ledger: raw.ledger } : {}),
        ...(contractError !== undefined ? { contractError } : {}),
        ...(hostError !== undefined ? { hostError } : {}),
        ...(typeof raw.txResultCode === 'string' ? { txResultCode: raw.txResultCode } : {}),
      }
    },
  }
}
