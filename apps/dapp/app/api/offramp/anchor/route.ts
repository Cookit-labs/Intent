import { NextResponse } from 'next/server'

import { resolveAnchor } from '../../../../lib/offramp/anchors'
import { readWithdrawInfo } from '../../../../lib/offramp/sep24'
import { readAnchorToml } from '../../../../lib/offramp/toml'
import { USDC } from '../../../../lib/swap/assets'

/**
 * The anchor's verified endpoints and limits, for the browser.
 *
 * The pinned-key check runs here rather than in the browser so the browser
 * never compares keys — it receives endpoints the server already vouched for.
 * The rest of the flow (SEP-10, SEP-24) talks to the anchor directly, which
 * the anchor permits: SEP-1 requires CORS on the TOML and SEP-10/24 on their
 * endpoints.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const id = new URL(request.url).searchParams.get('id') ?? ''
  // For this network. On mainnet with nothing configured the answer is that
  // there is no off-ramp yet, which is what the person asking needs to hear.
  const resolved = resolveAnchor(id)
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.reason }, { status: 400 })
  }
  const anchor = resolved.anchor

  try {
    const toml = await readAnchorToml(anchor)
    const limits = await readWithdrawInfo(toml, USDC.code)
    return NextResponse.json({
      anchor: {
        id: anchor.id,
        name: anchor.name,
        homeDomain: anchor.homeDomain,
        what: anchor.what,
      },
      toml,
      limits: limits ?? null,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not read the anchor' },
      { status: 502 }
    )
  }
}
