import { NextResponse } from 'next/server'

import { resolveVerifiedAsset } from '../../../../lib/swap/asset-registry'
import { ensureLiveAssets } from '../../../../lib/swap/live-assets'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * Which of these tickers are real, verified assets here.
 *
 * Answered by the same check the trade routes use, so the page asks the server
 * rather than deciding for itself that a token is genuine. A ticker that cannot
 * prove its issuer is simply absent from the answer.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'compete')
  if (limited !== undefined) return limited

  const raw = new URL(request.url).searchParams.get('symbols') ?? ''
  const symbols = [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z0-9]{2,12}$/.test(s))
    ),
  ].slice(0, 5)

  await ensureLiveAssets(symbols)
  const assets = symbols.flatMap((s) => {
    const asset = resolveVerifiedAsset(s)
    return asset === undefined ? [] : [asset]
  })
  return NextResponse.json({ assets })
}
