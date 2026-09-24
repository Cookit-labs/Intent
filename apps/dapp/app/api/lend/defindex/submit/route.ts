import { stellarNetwork } from '@intent/config'
import { NextResponse } from 'next/server'

import { sendSigned } from '../../../../../lib/lend/defindex/api'
import { isDefindexConfigured } from '../../../../../lib/lend/defindex/config'
import { resolveDefindexVault } from '../../../../../lib/lend/defindex/contracts'
import { assertDefindexDeposit } from '../../../../../lib/lend/defindex/deposit'
import { enforceRateLimit } from '../../../../../lib/server/rate-limit'

/**
 * Submits a signed DeFindex deposit through DeFindex's relay.
 *
 * The vault is resolved **again** here, and the envelope re-asserted against
 * that fresh read. Between build and submit the XDR passed through the
 * browser and a wallet extension; two independent reads bracket the
 * signature, the same discipline the offramp applies. The amount the client
 * states is checked against the bytes too: it is the figure the user
 * reviewed on the card.
 *
 * Through the relay rather than Horizon because the relay fee-bumps the
 * transaction, so the depositor pays no fee. The result is mapped onto the
 * shape every other submit returns.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  signedXdr?: unknown
  account?: unknown
  asset?: unknown
  amount?: unknown
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'submit')
  if (limited !== undefined) return limited

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  for (const key of ['signedXdr', 'account', 'asset', 'amount'] as const) {
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

  let vault
  try {
    vault = await resolveDefindexVault(body.asset as string)
  } catch (e) {
    return NextResponse.json(
      {
        error: `Refusing to submit: ${e instanceof Error ? e.message : 'the registry could not be read'}`,
      },
      { status: 502 }
    )
  }
  if (vault === undefined) {
    return NextResponse.json(
      { error: `Refusing to submit: DeFindex no longer lists a ${body.asset as string} vault.` },
      { status: 409 }
    )
  }

  try {
    assertDefindexDeposit(body.signedXdr as string, body.account as string, {
      vault: vault.id,
      amount: body.amount as string,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'refusing to submit' },
      { status: 400 }
    )
  }

  const result = await sendSigned(body.signedXdr as string)
  if (!result.ok) return NextResponse.json(result)

  return NextResponse.json({
    ...result,
    explorerUrl: `${stellarNetwork.blockExplorerUrl}/tx/${result.hash}`,
  })
}
