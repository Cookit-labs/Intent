import { NextResponse } from 'next/server'

import { isDefindexConfigured } from '../../../../../lib/lend/defindex/config'
import { readDefindexVaultFor } from '../../../../../lib/lend/defindex/rate'

/**
 * Which DeFindex vault a deposit of an asset would go to, and what it pays.
 *
 * Asked by the sequence before its first signature. The browser cannot see
 * the server's keys, so this is how it learns whether the deployment can
 * reach DeFindex at all — and a venue it cannot reach has to be refused
 * here, while nothing has moved, rather than discovered after the swap has
 * settled and left the user holding the asset with nowhere planned for it.
 *
 * Every refusal is a 4xx with a reason the card can show verbatim.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const asset = new URL(request.url).searchParams.get('asset') ?? ''
  if (asset === '') {
    return NextResponse.json({ error: 'asset is required' }, { status: 400 })
  }

  if (!isDefindexConfigured()) {
    return NextResponse.json(
      { error: 'DeFindex is not configured on this deployment.', code: 'not_configured' },
      { status: 404 }
    )
  }

  try {
    const found = await readDefindexVaultFor(asset)
    if (found === undefined) {
      return NextResponse.json(
        { error: `DeFindex has no ${asset} vault on testnet right now.`, code: 'offline' },
        { status: 404 }
      )
    }
    return NextResponse.json({
      vault: found.vault,
      asset,
      // Absent when the API has none yet, so the label says nothing rather
      // than "about 0%".
      ...(found.apy !== undefined ? { apy: found.apy } : {}),
    })
  } catch (e) {
    return NextResponse.json(
      {
        error: `DeFindex could not be read: ${e instanceof Error ? e.message : 'no answer'}`,
        code: 'unreachable',
      },
      { status: 502 }
    )
  }
}
