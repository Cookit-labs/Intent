import { stellarDescriptorFor, type StellarNetworkName } from '@intent/config'
import { NextResponse } from 'next/server'

import { evmExplorerUrl } from '../../../../lib/chains/evm/tokens'
import { explorerUrl as nearExplorerUrl } from '../../../../lib/chains/near/tokens'
import { explorerUrl as solanaExplorerUrl } from '../../../../lib/chains/solana/submit'
import { isAdminRequest } from '../../../../lib/server/admin-session'
import {
  getMetricsRepo,
  isAdminChain,
  isRange,
  type MetricsRepo,
  type RangeKey,
  type Scope,
} from '../../../../lib/server/admin-metrics'
import { reportError } from '../../../../lib/server/report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VIEWS = [
  'overview',
  'transactions',
  'intents',
  'agents',
  'wallets',
  'waitlist',
  'payouts',
] as const
type View = (typeof VIEWS)[number]

const PAGE = 25
const KINDS = [
  'swap',
  'plan',
  'offer',
  'send',
  'lend',
  'offramp',
  'perp',
  'withdraw',
  'borrow',
  'claim',
  'cancel',
  'invoice',
  'setup',
  'unknown',
]

const isView = (v: string | null): v is View =>
  v !== null && (VIEWS as readonly string[]).includes(v)
const isNetwork = (v: string | null): v is StellarNetworkName => v === 'mainnet' || v === 'testnet'

/** Where a transaction can be looked up, on the chain it ran on. */
function txUrl(chain: string, network: StellarNetworkName, hash: string): string {
  switch (chain) {
    case 'solana':
      return solanaExplorerUrl(hash)
    case 'sui':
      return `https://suiscan.xyz/mainnet/tx/${hash}`
    case 'near':
      return nearExplorerUrl(hash)
    case 'avalanche':
    case 'monad':
      return evmExplorerUrl(chain, hash)
    default:
      return `${stellarDescriptorFor(network).blockExplorerUrl}/tx/${hash}`
  }
}

function flag(value: string | null): boolean | undefined {
  return value === 'true' ? true : value === 'false' ? false : undefined
}

async function read(repo: MetricsRepo, view: View, scope: Scope, params: URLSearchParams) {
  switch (view) {
    case 'overview': {
      const [overview, series, kinds, pairs] = await Promise.all([
        repo.overview(scope),
        repo.series(scope),
        repo.byKind(scope),
        repo.pairs(scope),
      ])
      return { overview, series, kinds, pairs }
    }
    case 'wallets': {
      const [overview, series, wallets] = await Promise.all([
        repo.overview(scope),
        repo.series(scope),
        repo.wallets(scope),
      ])
      return {
        wallets,
        series: series.map((p) => ({ day: p.day, wallets: p.wallets })),
        active: overview.wallets,
        fresh: overview.newWallets,
        returning: Math.max(overview.wallets - overview.newWallets, 0),
      }
    }
    case 'transactions': {
      const page = Math.max(Number(params.get('page')) || 1, 1)
      const kind = params.get('kind')
      const { total, rows } = await repo.transactions(scope, {
        ...(kind !== null && KINDS.includes(kind) ? { kind } : {}),
        ...(flag(params.get('ok')) === undefined ? {} : { ok: flag(params.get('ok')) as boolean }),
        ...(flag(params.get('sponsored')) === undefined
          ? {}
          : { sponsored: flag(params.get('sponsored')) as boolean }),
        limit: PAGE,
        offset: (page - 1) * PAGE,
      })
      return {
        total,
        page,
        pageSize: PAGE,
        rows: rows.map((r) => ({
          ...r,
          explorerUrl: r.hash === null ? null : txUrl(r.chain, scope.network, r.hash),
        })),
      }
    }
    case 'agents':
      return { agents: await repo.agents(scope) }
    case 'intents': {
      const [intents, overview] = await Promise.all([repo.intents(scope), repo.overview(scope)])
      return { intents, races: overview.intents, transactions: overview.transactions }
    }
    case 'waitlist':
      return { waitlist: await repo.waitlist() }
    case 'payouts': {
      const explorer = stellarDescriptorFor(scope.network).blockExplorerUrl
      const naira = await repo.naira(scope)
      return {
        naira: {
          ...naira,
          attention: naira.attention.map((r) => ({
            ...r,
            explorerUrl: `${explorer}/tx/${r.paymentHash}`,
          })),
        },
      }
    }
  }
}

/**
 * The numbers behind the admin dashboard, for one chain or all of them, a network
 * and a date range.
 *
 * Admin only, and read only. Chains that are not recorded yet answer `tracked:
 * false` rather than an empty chart, so the page can say so. All chains, and
 * every chain but Stellar, are mainnet only.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }

  const params = new URL(request.url).searchParams
  const view = params.get('view')
  const chain = params.get('chain') ?? 'all'
  const network = params.get('network') ?? 'mainnet'
  const range = params.get('range') ?? '30d'

  if (!isView(view)) return NextResponse.json({ error: 'invalid_view' }, { status: 400 })
  if (!isNetwork(network)) return NextResponse.json({ error: 'invalid_network' }, { status: 400 })
  if (!isRange(range)) return NextResponse.json({ error: 'invalid_range' }, { status: 400 })

  const headers = { 'Cache-Control': 'no-store' }

  if (!isAdminChain(chain)) {
    if (view !== 'waitlist') return NextResponse.json({ tracked: false, chain }, { headers })
  } else if (chain !== 'stellar' && network !== 'mainnet') {
    return NextResponse.json({ error: 'invalid_network' }, { status: 400, headers })
  }

  const repo = await getMetricsRepo().catch((e: unknown) => {
    reportError('admin/metrics', e)
    return undefined
  })
  if (repo === undefined) {
    return NextResponse.json({ error: 'no_database' }, { status: 503, headers })
  }

  try {
    const data = await read(
      repo,
      view,
      { network, chain: isAdminChain(chain) ? chain : 'all', range: range as RangeKey },
      params
    )
    return NextResponse.json({ tracked: true, chain, network, range, view, ...data }, { headers })
  } catch (e) {
    reportError('admin/metrics', e, { view })
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers })
  }
}
