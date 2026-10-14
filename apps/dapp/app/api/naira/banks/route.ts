import { NextResponse } from 'next/server'

import { NIGERIAN_BANKS } from '../../../../lib/naira/banks'

export const runtime = 'nodejs'

/** The banks a payout can go to. Static: the provider publishes the list. */
export async function GET(): Promise<Response> {
  return NextResponse.json({ banks: NIGERIAN_BANKS })
}
