import { NextResponse } from 'next/server'

import { enforceRateLimit } from '../../../../../lib/server/rate-limit'
import { reportError } from '../../../../../lib/server/report'
import {
  isTokenChain,
  searchTokens,
  tokenDetail,
  tokenDirectory,
} from '../../../../../lib/tokens/directory'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const MAX_QUERY = 64
const MAX_ID = 200

/**
 * The tokens on a chain, a search of them, or one in full. Only shown, never used to decide what
 * can be traded: that stays with each chain's own table.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ chain: string }> }
): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'read')
  if (limited !== undefined) return limited

  const { chain } = await params
  if (!isTokenChain(chain)) return NextResponse.json({ error: 'unknown_chain' }, { status: 404 })

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  const query = url.searchParams.get('q')
  if ((id?.length ?? 0) > MAX_ID || (query?.length ?? 0) > MAX_QUERY) {
    return NextResponse.json({ error: 'too_long' }, { status: 400 })
  }

  try {
    if (id !== null) {
      const token = await tokenDetail(chain, id)
      return token === undefined
        ? NextResponse.json({ error: 'unknown_token' }, { status: 404 })
        : NextResponse.json({ token })
    }
    const body =
      query !== null && query.trim() !== ''
        ? await searchTokens(chain, query)
        : await tokenDirectory(chain)
    return NextResponse.json(body)
  } catch (e) {
    reportError('chain/tokens', e, { chain })
    return NextResponse.json({ error: 'tokens_unavailable' }, { status: 503 })
  }
}
