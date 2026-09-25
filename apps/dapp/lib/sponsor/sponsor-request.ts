import { gateEnabled } from '../server/access-gate'
import { readSessionFromRequest } from '../server/session'
import {
  sponsorForSubmission,
  type SponsoredSubmission,
  type SponsorForSubmissionOptions,
} from './sponsor'

/**
 * Sponsorship for a request, behind the access gate.
 *
 * The gate (`middleware.ts`) stands in front of the pages and deliberately
 * not the API, so on its own it decides who sees the app, not who spends the
 * sponsor. This is the other half: when the gate is on, the sponsor pays
 * only for a request that carries the session the gate issues. A request
 * without one is not refused — the user's own signed transaction goes out
 * exactly as before sponsorship existed, paying its own fee — it is simply
 * not paid for, with the reason named. When the gate is off nothing here
 * applies and `sponsorForSubmission` decides as it always did.
 *
 * Decided before Horizon or the ledger is asked anything, so an anonymous
 * caller costs the deployment no round trip. A session that cannot be
 * verified — forged, expired, or with no `AUTH_SECRET` to check it against —
 * is no session.
 *
 * One helper, called by every submit route, so the rule cannot be applied
 * to five routes and forgotten on the sixth.
 */
export async function sponsorForRequest(
  request: Request,
  signedXdr: string,
  account: string,
  options: SponsorForSubmissionOptions = {}
): Promise<SponsoredSubmission> {
  if (gateEnabled(options.env ?? process.env) && readSessionFromRequest(request) === undefined) {
    return { xdr: signedXdr, sponsored: false, reason: 'no_session' }
  }
  return sponsorForSubmission(signedXdr, account, options)
}
