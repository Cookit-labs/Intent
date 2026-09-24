import { NextResponse } from 'next/server'

import { isDefindexConfigured } from '../../../../../lib/lend/defindex/config'
import { buildDefindexDeposit } from '../../../../../lib/lend/defindex/deposit'
import { enforceRateLimit } from '../../../../../lib/server/rate-limit'

/**
 * Builds a deposit into a DeFindex vault, ready for signature.
 *
 * Server-side because the key is, and because the envelope arrives from a
 * third party's server and is admitted here before the browser sees it.
 * The browser names the asset and the amount; it does not name the vault.
 * The vault is resolved from DeFindex's published registry, checked on-chain
 * to hold the asset, and then the API's envelope is re-read field by field
 * against that — see `assertDefindexDeposit`.
 *
 * Unlike the Blend build, there is no simulation step here: the API returns
 * an envelope it has already prepared, and re-assembling it would replace
 * the resource footprint and auth the relay expects to fee-bump.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  account?: unknown
  /** Ticker. Resolved to a vault server-side. */
  asset?: unknown
  /** Base units. */
  amount?: unknown
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  for (const key of ['account', 'asset', 'amount'] as const) {
    if (typeof body[key] !== 'string' || body[key] === '') {
      return NextResponse.json({ error: `${key} is required` }, { status: 400 })
    }
  }

  if (!isDefindexConfigured()) {
    return NextResponse.json(
      { error: 'DeFindex is not configured on this deployment.', code: 'not_configured' },
      { status: 404 }
    )
  }

  try {
    const built = await buildDefindexDeposit({
      account: body.account as string,
      symbol: body.asset as string,
      amount: body.amount as string,
    })
    return NextResponse.json({
      xdr: built.xdr,
      vault: built.vault,
      asset: built.asset,
      assetContract: built.assetContract,
      amount: built.amount,
      recipient: built.recipient,
    })
  } catch (e) {
    // Every refusal here is a safety property — a vault holding the wrong
    // asset, an envelope funded from somebody else — so the reason surfaces
    // rather than being flattened into something generic.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the deposit' },
      { status: 400 }
    )
  }
}
