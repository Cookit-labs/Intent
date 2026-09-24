import { NextResponse } from 'next/server'
import { z } from 'zod'

import { readSessionFromRequest } from '../../../../lib/server/session'
import { getStandingRulesRepo } from '../../../../lib/server/standing-rules'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * The in-app half of "notify both ways".
 *
 * An email can be missed, filtered, or read on a phone with no wallet. The
 * inbox is the same firing shown on the next visit, with the rule ready to
 * sign. "Unseen" is the only state it tracks: once the user has opened the
 * panel the item has done its job, and the rule itself — still waiting on a
 * signature — is in the rules list as before.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const seenSchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(100) })

const unauthorised = (): NextResponse =>
  NextResponse.json({ error: 'unauthorised' }, { status: 401 })

export async function GET(request: Request): Promise<NextResponse> {
  const session = readSessionFromRequest(request)
  if (session === undefined) return unauthorised()

  const chain = new URL(request.url).searchParams.get('chain')
  if (chain === null || chain === '') {
    return NextResponse.json({ error: 'chain_required' }, { status: 400 })
  }

  const repo = await getStandingRulesRepo()
  return NextResponse.json({ rules: await repo.unseenFired(session.email, chain) })
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'standing')
  if (limited !== undefined) return limited

  const session = readSessionFromRequest(request)
  if (session === undefined) return unauthorised()

  let body: z.infer<typeof seenSchema>
  try {
    body = seenSchema.parse(await request.json())
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const repo = await getStandingRulesRepo()
  await repo.markSeen(session.email, body.ids)
  return NextResponse.json({ status: 'seen' })
}
