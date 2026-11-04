import { Transaction } from '@mysten/sui/transactions'
import { fromBase64 } from '@mysten/sui/utils'

import {
  ChainActionRefused,
  toBaseUnits,
  type ChainActionRequest,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
} from '../types'
import { assertSuiAccount, buildUnsigned, suiClient, withTimeout } from './client'
import {
  mintedAmount,
  SPRINGSUI_PACKAGE,
  SPRINGSUI_POLICY,
  SSUI_INFO,
  SSUI_TYPE,
  SSUI_WEIGHT_HOOK,
} from './policies'
import { assertPtbSafe } from './safety'
import { displayAmount } from './tokens'

const SUI_SYSTEM_STATE = '0x5'
const SUI_DECIMALS = 9
const SSUI_DECIMALS = 9
const DRY_RUN_TIMEOUT_MS = 15_000

async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  assertSuiAccount(account)
  if (request.tokenIn.trim().toUpperCase() !== 'SUI') {
    throw new ChainActionRefused(
      `SpringSui stakes SUI, not ${request.tokenIn}. Try "stake 1 SUI with SpringSui".`
    )
  }
  const amount = toBaseUnits(request.amount, SUI_DECIMALS)

  const tx = new Transaction()
  tx.setSender(account)
  const [sui] = tx.splitCoins(tx.gas, [BigInt(amount)])
  if (sui === undefined) throw new Error('Splitting a coin returned nothing.')
  const [minted] = tx.moveCall({
    target: `${SPRINGSUI_PACKAGE}::liquid_staking::mint`,
    typeArguments: [SSUI_TYPE],
    arguments: [tx.object(SSUI_INFO), tx.object(SUI_SYSTEM_STATE), sui],
  })
  if (minted === undefined) throw new Error('Minting returned nothing.')
  tx.moveCall({
    target: `${SPRINGSUI_PACKAGE}::weight::rebalance`,
    typeArguments: [SSUI_TYPE],
    arguments: [tx.object(SSUI_WEIGHT_HOOK), tx.object(SUI_SYSTEM_STATE), tx.object(SSUI_INFO)],
  })
  tx.transferObjects([minted], account)

  const client = suiClient()
  const transaction = await buildUnsigned(tx, client, 'SUI')
  const simulated = await withTimeout(
    client.core.simulateTransaction({
      transaction: fromBase64(transaction),
      include: { balanceChanges: true },
    }),
    DRY_RUN_TIMEOUT_MS,
    'Checking the stake'
  )
  const received = mintedAmount(simulated.Transaction?.balanceChanges, account)
  if (received === undefined) {
    throw new ChainActionRefused(
      "I couldn't confirm how much sSUI this stake would return, so I stopped. Nothing was signed or sent. Try again shortly."
    )
  }

  const receive = displayAmount(received, SSUI_DECIMALS)
  return {
    venueId: 'springsui',
    venueName: 'SpringSui',
    kind: 'stake',
    summary: `Stake ${request.amount} SUI with SpringSui for about ${receive} sSUI.`,
    pay: { amount: request.amount, symbol: 'SUI' },
    receive: { amount: receive, symbol: 'sSUI', approximate: true },
    notes: [
      'Staking rewards are not guaranteed. They depend on the validators, and I am not showing a rate because I could not read one from SpringSui.',
      'sSUI is worth more than SUI over time, so you get fewer of them. Converting back has a small fee, and sSUI can trade below its value on the market.',
      'Your SUI sits in third-party contracts that can fail. SpringSui shares an operator group with Suilend, Bluefin and Ember.',
    ],
    signing: { family: 'sui', transaction },
  }
}

export const springsuiVenue: ChainVenue = {
  id: 'springsui',
  name: 'SpringSui',
  kinds: ['stake'],
  prepare,
  assertSafe: (payload: SigningPayload, account: string) =>
    assertPtbSafe(payload, account, SPRINGSUI_POLICY),
}
