import { assertDepositIsNotTokenAccount } from '../../weave/deposit/solana'
import { oneClickAssetId, type OneClickOriginChain } from '../oneclick-origin'
import { isValidRecipient } from '../recipient'
import { inSendWords, sendWords } from '../send'
import { SOLANA_TOKENS } from '../solana/tokens'
import { SUI_TOKENS } from '../sui/tokens'
import {
  ChainActionRefused,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SubmitInput,
  type SubmitResult,
} from '../types'
import { assertOneClickSafe } from './safety'
import { ONECLICK_RISK_NOTE, prepareOneClickDeposit, submitOneClick } from './swap'
import { nearTokens } from './tokens'

export const CROSS_CHAIN_VENUE_ID = 'near-intents-send'

const USDC_HERE = tokenBySymbol(nearTokens, 'USDC') as ChainToken
const NOTHING_MOVED = 'Nothing was signed or sent.'

/**
 * Where a person can send NEAR's USDC. An address says which of these it belongs to by its shape.
 * EVM chains aren't here, because one 0x address is valid on all of them and a person's message
 * doesn't name which they meant.
 */
const TARGETS: readonly {
  chain: OneClickOriginChain & ('solana' | 'sui')
  name: string
  usdc: ChainToken | undefined
}[] = [
  { chain: 'solana', name: 'Solana', usdc: tokenBySymbol(SOLANA_TOKENS, 'USDC') },
  { chain: 'sui', name: 'Sui', usdc: tokenBySymbol(SUI_TOKENS, 'USDC') },
]

function targetOf(recipient: string): (typeof TARGETS)[number] | undefined {
  return TARGETS.find((target) => isValidRecipient(target.chain, recipient))
}

/** Whether this address is one this send can reach, and NEAR's own send can't. */
export function isCrossChainRecipient(recipient: string): boolean {
  return !isValidRecipient('near', recipient) && targetOf(recipient) !== undefined
}

async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  const recipient = request.recipient
  const target = recipient === undefined ? undefined : targetOf(recipient)
  if (recipient === undefined || target?.usdc === undefined) {
    throw new ChainActionRefused(
      `NEAR Intents sends from here pay Solana or Sui addresses. To pay a NEAR account, leave out the app's name. ${NOTHING_MOVED}`
    )
  }
  if (request.tokenIn.toUpperCase() !== 'USDC') {
    throw new ChainActionRefused(
      `From NEAR, only USDC can be sent to ${target.name}, not ${request.tokenIn}. ${NOTHING_MOVED}`
    )
  }
  // 1Click pays an address as its owner, so USDC sent to a token account or program is out of reach.
  const usdc = target.usdc
  if (target.chain === 'solana') {
    await inSendWords(() =>
      assertDepositIsNotTokenAccount(recipient, usdc, { refusePrograms: true })
    )
  }
  const assetId = await oneClickAssetId(target.chain, target.usdc)
  if (assetId === undefined) {
    throw new ChainActionRefused(
      `NEAR Intents isn't offering USDC on ${target.name} right now. ${NOTHING_MOVED}`
    )
  }
  const prepared = await prepareOneClickDeposit(
    {
      venueId: CROSS_CHAIN_VENUE_ID,
      venueName: 'NEAR Intents',
      kind: 'send',
      summary: (amount) => `Send ${amount} USDC from NEAR to ${recipient} on ${target.name}.`,
      extraNotes: [
        "Transfers can't be undone. Check the address.",
        `It should arrive on ${target.name} within a few minutes. If NEAR Intents can't complete it, the refund goes back to your NEAR account.`,
        ONECLICK_RISK_NOTE,
      ],
      costWording: {
        withdrawFor: `for the payout on ${target.name}`,
        total: 'After all costs',
      },
    },
    request.amount,
    USDC_HERE,
    {
      assetId,
      symbol: target.usdc.symbol,
      decimals: target.usdc.decimals,
      recipientType: 'DESTINATION_CHAIN',
      recipient,
    },
    account
  )
  return { ...prepared, notes: prepared.notes.map(sendWords) }
}

/** The deposit is followed the way every 1Click deposit is, and said as a transfer. */
async function submit(input: SubmitInput): Promise<SubmitResult> {
  const result = await submitOneClick(input)
  return result.ok ? result : { ...result, error: sendWords(result.error) }
}

export const crossChainVenue: ChainVenue = {
  id: CROSS_CHAIN_VENUE_ID,
  name: 'NEAR Intents',
  kinds: ['send'],
  prepare,
  // The deposit is checked the way every 1Click deposit is. The quote already fixed who it pays.
  assertSafe: assertOneClickSafe,
  submit,
  assertCanFollow: async () => {
    throw new ChainActionRefused(
      `A send to another chain can't follow a swap yet. Swap first, then send what arrives. ${NOTHING_MOVED}`
    )
  },
}
