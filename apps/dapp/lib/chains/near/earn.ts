import {
  ChainActionRefused,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type VenueQuote,
} from '../types'
import { assertOneClickSafe } from './safety'
import { prepareOneClickDeposit, quoteOneClick, submitOneClick } from './swap'
import { nearTokens, USDC_NEAR, USDT_NEAR } from './tokens'

export const EARN_VENUE_ID = '1click-earn'
const VENUE_NAME = '1Click Earn'

/**
 * Gauntlet USDC Prime, a Morpho vault on Base. Listed in the Earn docs, with this
 * asset id and decimals confirmed against the live 1Click token list. Chosen over
 * Taler USDC, which quotes at smaller sizes but has no independent usage data.
 *
 * The share stays in the user's NEAR Intents balance, because a NEAR wallet has no
 * address on Base to deliver it to.
 */
const VAULT = {
  assetId: 'nep141:base-0x0bb69b79bc829e1cfcc34a740110886d98d2bd14.omft.near',
  symbol: 'gtUSDCp',
  decimals: 18,
  recipientType: 'INTENTS',
} as const

const EARN_NOTE =
  "Your stablecoin becomes a share in Gauntlet USDC Prime, a Morpho vault on Base, held in your NEAR Intents balance. That stacks bridge, NEAR Intents and vault risk, the principal isn't guaranteed, and 1Click publishes no rate to show here. This app can't show this position or withdraw it yet. Getting out takes a separate signed withdrawal through NEAR Intents."

function stablecoinIn(request: ChainActionRequest): ChainToken {
  const tokenIn = tokenBySymbol(nearTokens, request.tokenIn)
  if (
    request.kind !== 'supply' ||
    tokenIn === undefined ||
    (tokenIn.id !== USDC_NEAR && tokenIn.id !== USDT_NEAR)
  ) {
    throw new ChainActionRefused(`${VENUE_NAME} here takes USDC or USDT.`)
  }
  return tokenIn
}

/** No apyPercent: 1Click publishes no rate for the vault, and a rate is never invented. */
async function quoteEarn(request: ChainActionRequest, account: string): Promise<VenueQuote> {
  return quoteOneClick(request.amount, stablecoinIn(request), VAULT, account)
}

async function prepareEarn(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  const tokenIn = stablecoinIn(request)
  return prepareOneClickDeposit(
    {
      venueId: EARN_VENUE_ID,
      venueName: VENUE_NAME,
      kind: 'supply',
      summary: (amount, token) =>
        `Put ${amount} ${token.symbol} into a vault on Base through NEAR Intents. Vault shares are small units, so the share count looks large.`,
      extraNotes: [EARN_NOTE],
    },
    request.amount,
    tokenIn,
    VAULT,
    account
  )
}

/** The swap check, without the wrap path: this venue only ever spends stablecoins. */
function assertEarnSafe(payload: SigningPayload, account: string): void {
  assertOneClickSafe(payload, account)
  if (payload.family !== 'near') return
  const receiver = payload.transactions[0]?.receiverId
  if (receiver !== USDC_NEAR && receiver !== USDT_NEAR) {
    throw new ChainActionRefused(
      `This transaction was stopped before signing because ${VENUE_NAME} only spends USDC or USDT. Nothing was signed or sent.`
    )
  }
}

export const earnVenue: ChainVenue = {
  id: EARN_VENUE_ID,
  name: VENUE_NAME,
  kinds: ['supply'],
  quote: quoteEarn,
  prepare: prepareEarn,
  assertSafe: assertEarnSafe,
  submit: submitOneClick,
}
