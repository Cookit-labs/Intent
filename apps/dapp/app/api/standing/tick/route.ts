import { timingSafeEqual } from 'node:crypto'
import { enabledNetworks, isMultiNetwork, type StellarNetworkName } from '@intent/config'
import { NextResponse } from 'next/server'

import { fetchFxPrices } from '../../../../lib/prices/reflector'
import { alertRecipient, getAlertsRepo, sponsorAlertThreshold } from '../../../../lib/server/alerts'
import { getEmailSender } from '../../../../lib/server/email'
import { getStandingRulesRepo } from '../../../../lib/server/standing-rules'
import { runTick, type SponsorWatch } from '../../../../lib/server/standing-tick'
import { tickAllNetworks } from '../../../../lib/server/standing-tick-all'
import { readSponsorBalance } from '../../../../lib/sponsor/balance'
import { sponsorAccount } from '../../../../lib/sponsor/sponsor'
import { fetchMarketPrices, toPriceTable } from '../../../../lib/swap/prices'

/**
 * The scheduled evaluation of every armed standing rule.
 *
 * Called by whatever runs on a schedule: a cron hitting this URL, a hosted
 * scheduled function, or `pnpm standing:tick` in development. The route does
 * the work so the scheduler needs nothing but a secret and a URL.
 *
 * Guarded by a shared secret rather than a session, because the caller is a
 * machine. And it refuses to run at all when no secret is configured: an
 * open tick would let anyone on the internet trigger emails to every user
 * with a due rule, so a missing secret is a deployment error, not a default.
 *
 * Safe to call as often as anyone likes — see `runTick` for why.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Below this the secret is not a secret. Matches the admin token's floor. */
const MIN_SECRET_LENGTH = 16

function authorised(request: Request, expected: string): boolean {
  const provided = request.headers.get('x-tick-secret') ?? ''
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Where the email links to. Explicit in production; the request's own origin in dev. */
function appUrl(request: Request): string {
  const configured = process.env['APP_URL'] ?? process.env['NEXT_PUBLIC_APP_URL']
  if (configured !== undefined && configured !== '') return configured
  return new URL(request.url).origin
}

/** The sponsor watch, when there is a sponsor to watch and someone to tell. */
async function sponsorWatch(network: StellarNetworkName): Promise<SponsorWatch | undefined> {
  const account = sponsorAccount(process.env, network)
  const alertEmail = alertRecipient()
  if (account === undefined || alertEmail === undefined) return undefined

  // One "already told you today" record per network, so a low testnet sponsor
  // cannot silence the mainnet one. With one network the kinds are unchanged.
  const alerts = await getAlertsRepo()
  const kind = (k: string): string => (isMultiNetwork() ? `${k}:${network}` : k)

  return {
    account,
    balance: () => readSponsorBalance(account),
    alertBelowXlm: sponsorAlertThreshold(),
    alertEmail,
    alerts: {
      wasSent: (k, day) => alerts.wasSent(kind(k), day),
      markSent: (k, day) => alerts.markSent(kind(k), day),
    },
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const expected = process.env['STANDING_TICK_SECRET']
  if (expected === undefined || expected.length < MIN_SECRET_LENGTH) {
    return NextResponse.json(
      {
        error: `STANDING_TICK_SECRET is not set (or is shorter than ${MIN_SECRET_LENGTH} characters). Refusing to run an open tick.`,
      },
      { status: 503 }
    )
  }
  if (!authorised(request, expected)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Each served network runs on its own, with that network selected: its
  // rules, its prices and its sponsor. A scheduler has no request to read a
  // network from, so each is named here.
  const { result, failed } = await tickAllNetworks(enabledNetworks(), async (network) => {
    // The same sources the rest of the app prices with, minus route quoting —
    // a tick needs to know what an asset is worth, not what a swap would fill
    // at. Both readers degrade rather than throw.
    const [market, fx] = await Promise.all([fetchMarketPrices(), fetchFxPrices()])
    const prices = { ...toPriceTable(fx), ...toPriceTable(market) }

    const sponsor = await sponsorWatch(network)
    return runTick({
      now: new Date(),
      prices,
      repo: await getStandingRulesRepo(network),
      mailer: getEmailSender(),
      appUrl: appUrl(request),
      ...(sponsor !== undefined ? { sponsor } : {}),
    })
  })

  // A network that failed is named, and the status says so, so the scheduler
  // can alert; the networks that ran have done their work either way.
  return NextResponse.json(failed.length === 0 ? result : { ...result, failed }, {
    status: failed.length === 0 ? 200 : 500,
  })
}
