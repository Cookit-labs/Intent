import { resolveVerifiedAsset } from '../asset-registry'
import type { ClassicAsset } from '../assets'
import { resolveAggregatorProtocols, type ProtocolWhitelist } from '../aggregator-protocols'
import { sacFor } from '../build-soroban'
import { DEFAULT_SLIPPAGE_BPS } from '../build-tx'
import { lookupContract } from '../contract-registry'
import type { QuoteFailure, QuoteOutcome, QuoteRequest, QuoteSource, SwapQuote } from '../quote'
import {
  createSoroswapApi,
  type AggregatorApiQuote,
  type AggregatorProtocol,
  type SoroswapApi,
} from '../soroswap-api'

/**
 * Quotes through Soroswap's aggregator: the hosted route-finder that splits
 * one swap across Soroswap's pools, Aquarius's and the classic order book.
 *
 * A different product from `soroswap-quoter.ts`, which simulates a single
 * pool on the router contract. This asks the API, which does the search
 * off-chain and answers with a plan and an unsigned transaction. Two things
 * follow from that and shape everything here:
 *
 * - **Several of its routes originate from routers the app already quotes
 *   directly.** A 100% Soroswap plan is the same liquidity `soroswap` already
 *   reports; a 100% `sdex` plan is Horizon's book. So this is one source among
 *   the others, under its own id, not a replacement for them: an agent that
 *   sees "soroswap" and "soroswap-aggregator" quoting the same number learns
 *   something, and one that sees the aggregator beat both learns more.
 *
 * - **Nothing it says is trusted on arrival.** The aggregator id is resolved
 *   at runtime and must be one the registry has reviewed; the protocol list
 *   is read from the contract and the ledger rather than from a file; and
 *   the quote that comes back is checked against the question — same
 *   assets, same amount, no venue that was not asked for. The transaction it
 *   later builds is re-read the same way in `build-aggregator.ts`.
 *
 * Absent without `SOROSWAP_API_KEY`. `collectQuotes` skips an unconfigured
 * source, so with no key the aggregator simply is not in the line-up.
 */

export const SOURCE_ID = 'soroswap-aggregator' as const

export interface SoroswapAggregatorQuoterOptions {
  /** Defaults to `SOROSWAP_API_KEY`. Empty means not configured. */
  apiKey?: string
  /** Injected in tests. */
  api?: SoroswapApi
  /** Injected in tests; defaults to simulating `get_adapters()` on the live contract. */
  protocolsImpl?: (aggregatorId: string) => Promise<ProtocolWhitelist | undefined>
  /** Tolerance the API is asked to write into its floor. */
  slippageBps?: number
  rpcUrl?: string
}

/** A quote together with what the builder needs and the quoter already learned. */
export interface AggregatorQuoted {
  quote: SwapQuote
  /** The API's own object, handed back verbatim to `/quote/build`. */
  raw: AggregatorApiQuote
  aggregatorId: string
  protocols: AggregatorProtocol[]
  slippageBps: number
}

export type AggregatorQuoteOutcome =
  | { ok: true; quoted: AggregatorQuoted }
  | { ok: false; failure: QuoteFailure }

export interface SoroswapAggregatorQuoter extends QuoteSource {
  /** The full answer, for the builder. `quote()` is this with the raw object dropped. */
  quoteWithRaw: (req: QuoteRequest, signal?: AbortSignal) => Promise<AggregatorQuoteOutcome>
}

function failure(reason: QuoteFailure['reason'], detail?: string): AggregatorQuoteOutcome {
  return {
    ok: false,
    failure: { source: SOURCE_ID, reason, ...(detail !== undefined ? { detail } : {}) },
  }
}

/**
 * The canonical contract for a classic asset the app has verified, or
 * nothing. A SAC id can be derived for any well-formed asset, so derivation
 * proves nothing; the allowlist is the check, as in every other builder.
 */
function contractFor(asset: ClassicAsset): string | undefined {
  if (resolveVerifiedAsset(asset.code) === undefined) return undefined
  try {
    return sacFor(asset)
  } catch {
    return undefined
  }
}

export function createSoroswapAggregatorQuoter(
  options: SoroswapAggregatorQuoterOptions = {}
): SoroswapAggregatorQuoter {
  const apiKey = options.apiKey ?? process.env['SOROSWAP_API_KEY'] ?? ''
  const api = options.api ?? createSoroswapApi({ apiKey })
  const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS
  const protocolsImpl =
    options.protocolsImpl ??
    ((aggregatorId: string) =>
      resolveAggregatorProtocols({
        aggregatorId,
        ...(options.rpcUrl !== undefined ? { rpcUrl: options.rpcUrl } : {}),
      }))

  async function quoteWithRaw(
    req: QuoteRequest,
    signal?: AbortSignal
  ): Promise<AggregatorQuoteOutcome> {
    // Fixed-input only, as with the other Soroban sources. The API quotes
    // EXACT_OUT too, but nothing here has ever executed one, and quoting a
    // shape this source has never filled would be worse than declining.
    if (req.kind !== 'strict_send') return failure('unsupported_pair')

    const fromContract = contractFor(req.from)
    const toContract = contractFor(req.to)
    if (fromContract === undefined || toContract === undefined) {
      return failure('unsupported_pair')
    }

    // Resolved at runtime, then checked against the registry. The API is
    // the authority on which contract is live; the registry is the authority
    // on which contracts this app will sign a call to. Both have to agree.
    const aggregatorId = await api.contractAddress('aggregator')
    if (aggregatorId === undefined) {
      return failure('unavailable', 'the aggregator contract id could not be resolved')
    }
    if (lookupContract(aggregatorId) === undefined) {
      return failure(
        'unavailable',
        `the API names aggregator ${aggregatorId}, which this app has not reviewed`
      )
    }

    const whitelist = await protocolsImpl(aggregatorId)
    if (whitelist === undefined || whitelist.protocols.length === 0) {
      return failure('unavailable', 'the aggregator adapters could not be read')
    }

    const answer = await api.quote(
      {
        assetIn: fromContract,
        assetOut: toContract,
        amount: req.sendAmount,
        protocols: whitelist.protocols,
        slippageBps,
      },
      signal
    )
    if (!answer.ok) return failure(answer.reason, answer.detail)
    const raw = answer.value

    // The answer against the question. The API is trusted to find a route,
    // not to have understood the request: a quote for a different amount or
    // pair would be compared against the others as if it were for this one.
    if (raw.assetIn !== fromContract || raw.assetOut !== toContract) {
      return failure('upstream_error', 'the quote is for a different pair than requested')
    }
    if (raw.amountIn !== req.sendAmount) {
      return failure('upstream_error', 'the quote is for a different amount than requested')
    }
    const dest = BigInt(raw.amountOut)
    if (dest <= BigInt(0)) return failure('no_route')

    // Every leg through a venue that was asked for. Phoenix's testnet adapter
    // points at a contract the ledger does not have, so a plan through it is
    // a plan that fails at execution — and a plan through anything not on
    // the whitelist is one this app has not verified.
    const allowed = new Set<string>(whitelist.protocols)
    const stray = raw.routePlan.find((leg) => !allowed.has(leg.protocol))
    if (stray !== undefined) {
      return failure(
        'upstream_error',
        `the route goes through ${stray.protocol}, which was not asked for`
      )
    }

    const quote: SwapQuote = {
      source: SOURCE_ID,
      kind: 'strict_send',
      from: req.from,
      to: req.to,
      sendAmount: req.sendAmount,
      destAmount: dest.toString(),
      // No classic hops to replay: the API rebuilds its own plan at signing
      // time, and the plan is carried separately below.
      path: [],
      routePlan: raw.routePlan.map((leg) => ({
        protocol: leg.protocol,
        percent: leg.percent,
        hops: Math.max(0, leg.path.length - 2),
      })),
      platform: raw.platform,
      // Both ends are canonical Stellar Asset Contracts, which *are* the
      // classic assets named — so nothing is substituted and `deliversAsset`
      // stays unset, exactly as for the direct Soroban quoters.
      quotedAt: new Date().toISOString(),
    }

    return {
      ok: true,
      quoted: { quote, raw, aggregatorId, protocols: whitelist.protocols, slippageBps },
    }
  }

  async function guarded(req: QuoteRequest, signal?: AbortSignal): Promise<AggregatorQuoteOutcome> {
    try {
      return await quoteWithRaw(req, signal)
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError'
      return failure(
        aborted ? 'timeout' : 'upstream_error',
        e instanceof Error ? e.message : undefined
      )
    }
  }

  return {
    id: SOURCE_ID,
    displayName: 'Soroswap Aggregator',
    isConfigured: () => apiKey !== '',
    quoteWithRaw: guarded,

    async quote(req: QuoteRequest, signal?: AbortSignal): Promise<QuoteOutcome> {
      const out = await guarded(req, signal)
      return out.ok ? { ok: true, quote: out.quoted.quote } : out
    },
  }
}
