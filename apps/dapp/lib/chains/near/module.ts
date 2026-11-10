import { canIssueOneClick } from '../oneclick-origin'
import { createSendVenue, SEND_VENUE_ID } from '../send'
import type { ChainModule, ChainVenue } from '../types'
import { readNearBalances } from './balances'
import { crossChainVenue, isCrossChainRecipient } from './cross-chain'
import { EARN_VENUE_ID, earnVenue } from './earn'
import { assetIdOf, oneClickPrice } from './oneclick'
import { RHEA_VENUE_ID, rheaBook, rheaVenue } from './rhea-dcl'
import { RHEA_LEND_VENUE_ID, rheaLendVenue } from './rhea-lend'
import { RHEA_DEX_VENUE_ID, rheaDexVenue } from './rhea-swap'
import { confirmStake, metapoolVenue, METAPOOL_VENUE_ID, rnearVenue } from './stake'
import { oneClickVenue } from './swap'
import { nearTokens } from './tokens'

export function buildNearVenues(
  env: Record<string, string | undefined> = process.env
): ChainVenue[] {
  return [
    oneClickVenue,
    // Before the exchange: "rhea" answers to both, and a person saying it means the lending market.
    rheaLendVenue,
    rheaDexVenue,
    metapoolVenue,
    rnearVenue,
    earnVenue,
    rheaVenue,
    // Sends come together: a deployment that can't offer one offers neither, and says so.
    ...(canIssueOneClick(env) ? [createSendVenue('near'), crossChainVenue] : []),
  ]
}

export const nearModule: ChainModule = {
  chain: 'near',
  tokens: nearTokens,
  venues: buildNearVenues(),
  defaultVenue: {
    // 1Click refused every route with an on-chain NEAR leg on 5 November 2026, and still races.
    swap: RHEA_DEX_VENUE_ID,
    supply: EARN_VENUE_ID,
    withdraw: EARN_VENUE_ID,
    borrow: RHEA_LEND_VENUE_ID,
    repay: RHEA_LEND_VENUE_ID,
    unstake: METAPOOL_VENUE_ID,
    claim: METAPOOL_VENUE_ID,
    /**
     * Meta Pool over rNEAR because more of it could be checked: its contract source
     * is public and was read, while the source link rNEAR publishes on-chain returns
     * 404. Its payload is also simpler, and it doesn't lean on Rhea Lend.
     */
    stake: METAPOOL_VENUE_ID,
    send: SEND_VENUE_ID,
    limit: RHEA_VENUE_ID,
  },
  venueForToken: {
    unstake: { STNEAR: METAPOOL_VENUE_ID, RNEAR: 'rnear' },
    claim: { USDC: EARN_VENUE_ID },
  },
  priceUsd: (token) => oneClickPrice(assetIdOf(token), token.decimals),
  submit: confirmStake,
  balances: readNearBalances,
  limitBook: rheaBook(),
  crossChainSend: canIssueOneClick(process.env)
    ? { venue: crossChainVenue, reaches: isCrossChainRecipient }
    : undefined,
}
