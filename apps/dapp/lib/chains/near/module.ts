import { canIssueOneClick } from '../oneclick-origin'
import { createSendVenue, SEND_VENUE_ID } from '../send'
import type { ChainModule, ChainVenue } from '../types'
import { readNearBalances } from './balances'
import { EARN_VENUE_ID, earnVenue } from './earn'
import { assetIdOf, oneClickPrice } from './oneclick'
import { confirmStake, metapoolVenue, METAPOOL_VENUE_ID, rnearVenue } from './stake'
import { ONECLICK_VENUE_ID, oneClickVenue } from './swap'
import { nearTokens } from './tokens'

export function buildNearVenues(
  env: Record<string, string | undefined> = process.env
): ChainVenue[] {
  return [
    oneClickVenue,
    metapoolVenue,
    rnearVenue,
    earnVenue,
    ...(canIssueOneClick(env) ? [createSendVenue('near')] : []),
  ]
}

export const nearModule: ChainModule = {
  chain: 'near',
  tokens: nearTokens,
  venues: buildNearVenues(),
  defaultVenue: {
    swap: ONECLICK_VENUE_ID,
    supply: EARN_VENUE_ID,
    /**
     * Meta Pool over rNEAR because more of it could be checked: its contract source
     * is public and was read, while the source link rNEAR publishes on-chain returns
     * 404. Its payload is also simpler, and it doesn't lean on Rhea Lend.
     */
    stake: METAPOOL_VENUE_ID,
    send: SEND_VENUE_ID,
  },
  priceUsd: (token) => oneClickPrice(assetIdOf(token), token.decimals),
  submit: confirmStake,
  balances: readNearBalances,
}
