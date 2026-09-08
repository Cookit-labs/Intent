import { stellarTestnet } from '@intent/config'

import type { AssetRef } from '../assets'
import { fromCanonical, toBaseUnits, toCanonical, toHorizonParams } from '../assets'
import type { QuoteOutcome, QuoteRequest, QuoteSource } from '../quote'

/**
 * Quotes against Stellar's built-in DEX.
 *
 * Worth stating plainly, because it is easy to assume otherwise: Horizon
 * already does liquidity aggregation. `/paths/strict-send` searches order books
 * *and* AMM liquidity pools and returns the best route it finds, including
 * multi-hop paths through intermediate assets. There is no aggregator to build
 * here — the work is asking correctly and replaying the answer exactly.
 *
 * Plain REST rather than `@stellar/stellar-sdk`: this is one GET, and the SDK
 * exists for building and signing. Keeping it out means quoting stays cheap in
 * the bundle, matching the same decision already made in `stellar-account.ts`.
 */

/** Horizon returns amounts as decimal strings; the rest of the code speaks stroops. */
interface HorizonPathRecord {
  source_amount: string
  destination_amount: string
  path: {
    asset_type: string
    asset_code?: string
    asset_issuer?: string
  }[]
}

interface HorizonPathsResponse {
  _embedded?: { records?: HorizonPathRecord[] }
}

function hopToAsset(hop: HorizonPathRecord['path'][number]): AssetRef {
  if (hop.asset_type === 'native') return { kind: 'classic', code: 'XLM' }
  return {
    kind: 'classic',
    code: hop.asset_code ?? '',
    ...(hop.asset_issuer !== undefined ? { issuer: hop.asset_issuer } : {}),
  }
}

export interface HorizonQuoterOptions {
  horizonUrl?: string
  fetchImpl?: typeof fetch
}

export function createHorizonQuoter(options: HorizonQuoterOptions = {}): QuoteSource {
  const horizonUrl = options.horizonUrl ?? stellarTestnet.horizonUrl
  const doFetch = options.fetchImpl ?? fetch

  return {
    id: 'horizon',
    displayName: 'Stellar DEX',
    isConfigured: () => horizonUrl !== '',

    async quote(req: QuoteRequest, signal?: AbortSignal): Promise<QuoteOutcome> {
      const params = new URLSearchParams()
      let endpoint: string

      if (req.kind === 'strict_send') {
        endpoint = 'strict-send'
        // Horizon takes decimal amounts on this endpoint, not stroops.
        params.set('source_amount', decimalFromBase(req.sendAmount))
        for (const [k, v] of Object.entries(toHorizonParams(req.from, 'source'))) {
          params.set(k, v)
        }
        params.set('destination_assets', toCanonical(req.to))
      } else {
        endpoint = 'strict-receive'
        params.set('destination_amount', decimalFromBase(req.receiveAmount))
        for (const [k, v] of Object.entries(toHorizonParams(req.to, 'destination'))) {
          params.set(k, v)
        }
        params.set('source_assets', toCanonical(req.from))
      }

      let res: Response
      try {
        res = await doFetch(`${horizonUrl}/paths/${endpoint}?${params.toString()}`, {
          headers: { Accept: 'application/json' },
          ...(signal !== undefined ? { signal } : {}),
        })
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError'
        return {
          ok: false,
          failure: {
            source: 'horizon',
            reason: aborted ? 'timeout' : 'upstream_error',
            detail: e instanceof Error ? e.message : undefined,
          },
        }
      }

      if (!res.ok) {
        return {
          ok: false,
          failure: { source: 'horizon', reason: 'upstream_error', detail: `HTTP ${res.status}` },
        }
      }

      let body: HorizonPathsResponse
      try {
        body = (await res.json()) as HorizonPathsResponse
      } catch {
        return { ok: false, failure: { source: 'horizon', reason: 'upstream_error' } }
      }

      const records = body._embedded?.records ?? []
      if (records.length === 0) {
        // A thin pair with no route is an ordinary outcome, not a fault.
        return { ok: false, failure: { source: 'horizon', reason: 'no_route' } }
      }

      // Horizon returns candidates unordered, so pick explicitly rather than
      // trusting position: most delivered on a fixed input, least spent on a
      // fixed output.
      const best = records.reduce((a, b) => {
        if (req.kind === 'strict_receive') {
          return BigInt(toBaseUnits(b.source_amount)) < BigInt(toBaseUnits(a.source_amount)) ? b : a
        }
        return BigInt(toBaseUnits(b.destination_amount)) > BigInt(toBaseUnits(a.destination_amount))
          ? b
          : a
      })

      return {
        ok: true,
        quote: {
          source: 'horizon',
          kind: req.kind,
          from: req.from,
          to: req.to,
          sendAmount: toBaseUnits(best.source_amount),
          destAmount: toBaseUnits(best.destination_amount),
          path: best.path.map(hopToAsset),
          quotedAt: new Date().toISOString(),
        },
      }
    },
  }
}

/** Stroops back to the decimal string Horizon's query parameters expect. */
function decimalFromBase(base: string): string {
  const value = BigInt(base)
  const whole = value / 10_000_000n
  const fraction = (value % 10_000_000n).toString().padStart(7, '0')
  return `${whole.toString()}.${fraction}`
}

export { fromCanonical }
