import { NextResponse } from 'next/server'

import { getRoster, publicRoster } from '../../../../lib/agents/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The line-up as the directory shows it: identity and cost, no keys.
 *
 * The roster is configuration on the server, so a client page cannot know
 * it any other way. Empty when nothing is configured, which the page says.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({ agents: publicRoster(getRoster() ?? []) })
}
