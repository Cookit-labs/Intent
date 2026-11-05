import { coinWithBalance, Transaction } from '@mysten/sui/transactions'
import { normalizeStructTag } from '@mysten/sui/utils'

import {
  ChainActionRefused,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type PreparedAction,
  type SigningPayload,
} from '../types'
import { assertSuiAccount, buildUnsigned, suiClient } from './client'
import {
  assertPinnedObjects,
  dryRun,
  percentText,
  readObjectJson,
  returnedCoinAmount,
  SUI_SYSTEM_STATE,
  u64Field,
} from './haedal'
import { SPRINGSUI_PACKAGE, SSUI_INFO, SSUI_TYPE, SSUI_WEIGHT_HOOK } from './policies'
import { assertPtbSafe, moveTarget, type ParsedCall, type PtbPolicy } from './safety'
import { displayAmount } from './tokens'

/** On chain, its coin metadata 0x06e4724a...7d9a says sSUI, 9 decimals. */
export const SPRINGSUI_TOKENS: ChainToken[] = [
  { symbol: 'sSUI', id: SSUI_TYPE, decimals: 9, name: 'Spring SUI' },
]

const SUI_DECIMALS = 9
const SSUI_DECIMALS = 9
const BPS_PER_PERCENT = 100

/** springsui-sdk 4.1.0's `redeemAmountAndRebalanceAndSendToUser` makes these two calls, in this order. */
const REDEEM = moveTarget(SPRINGSUI_PACKAGE, 'liquid_staking', 'redeem')
const REBALANCE = moveTarget(SPRINGSUI_PACKAGE, 'weight', 'rebalance')

function fail(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

async function readRedeemFeeBps(): Promise<bigint> {
  const info = await readObjectJson(SSUI_INFO)
  const cell = info?.['fee_config'] as Record<string, unknown> | undefined
  const fees = cell?.['element'] as Record<string, unknown> | undefined
  const bps = u64Field(fees?.['redeem_fee_bps'])
  if (bps === undefined) fail("I couldn't read SpringSui's fee, so I stopped. Try again shortly.")
  return bps
}

export async function prepareSpringsuiUnstake(
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  assertSuiAccount(account)
  if (request.tokenIn.trim().toUpperCase() !== 'SSUI') {
    throw new ChainActionRefused(
      `SpringSui unstakes sSUI, not ${request.tokenIn}. If this came from another app, name it, like "unstake 1 afSUI with Aftermath".`
    )
  }
  const amount = toBaseUnits(request.amount, SSUI_DECIMALS)

  const tx = new Transaction()
  tx.setSender(account)
  const coin = tx.add(
    coinWithBalance({ type: SSUI_TYPE, balance: BigInt(amount), useGasCoin: false })
  )
  const [sui] = tx.moveCall({
    target: REDEEM,
    typeArguments: [SSUI_TYPE],
    arguments: [tx.object(SSUI_INFO), coin, tx.object(SUI_SYSTEM_STATE)],
  })
  if (sui === undefined) throw new Error('Redeeming returned nothing.')
  tx.moveCall({
    target: REBALANCE,
    typeArguments: [SSUI_TYPE],
    arguments: [tx.object(SSUI_WEIGHT_HOOK), tx.object(SUI_SYSTEM_STATE), tx.object(SSUI_INFO)],
  })
  tx.transferObjects([sui], account)

  const transaction = await buildUnsigned(tx, suiClient(), 'sSUI')
  const simulated = await dryRun(transaction, 'Checking the unstake')
  const received = returnedCoinAmount(simulated.commandResults, transaction, REDEEM)
  if (received === undefined) {
    fail(
      "I couldn't confirm how much SUI this unstake would return, so I stopped. Try again shortly."
    )
  }
  const receive = displayAmount(received, SUI_DECIMALS)
  const feeBps = await readRedeemFeeBps()

  return {
    venueId: 'springsui',
    venueName: 'SpringSui',
    kind: 'unstake',
    summary: `Unstake ${request.amount} sSUI with SpringSui for about ${receive} SUI, right away.`,
    pay: { amount: request.amount, symbol: 'sSUI' },
    receive: { amount: receive, symbol: 'SUI', approximate: true },
    notes: [
      `There is no wait: the SUI is in your wallet once this lands. The fee is ${percentText(Number(feeBps) / BPS_PER_PERCENT)}%, already taken off the amount shown.`,
      'Your remaining sSUI stays in third-party contracts that can fail. SpringSui shares an operator group with Suilend, Bluefin and Ember.',
    ],
    signing: { family: 'sui', transaction },
  }
}

/** Anyone can create a token in this package, so the allowed call says nothing about the coin. */
function checkBurnsSsui(call: ParsedCall): void {
  for (const coin of call.typeArguments) {
    if (normalizeStructTag(coin) !== normalizeStructTag(SSUI_TYPE)) {
      fail('This unstake burns a token other than sSUI.')
    }
  }
}

export const SPRINGSUI_UNSTAKE_POLICY: PtbPolicy = {
  venueName: 'SpringSui',
  allowedCalls: new Set([REDEEM, REBALANCE]),
  checkCall: checkBurnsSsui,
}

const PINS: ReadonlyMap<string, readonly (string | undefined)[]> = new Map([
  [REDEEM, [SSUI_INFO, undefined, SUI_SYSTEM_STATE]],
  [REBALANCE, [SSUI_WEIGHT_HOOK, SUI_SYSTEM_STATE, SSUI_INFO]],
])

/** Whether these bytes redeem. Bytes that can't be read aren't, and the stake policy refuses them. */
export function isSpringsuiRedeem(payload: SigningPayload): boolean {
  if (payload.family !== 'sui') return false
  try {
    return Transaction.from(payload.transaction)
      .getData()
      .commands.some(
        (c) =>
          c.$kind === 'MoveCall' &&
          moveTarget(c.MoveCall.package, c.MoveCall.module, c.MoveCall.function) === REDEEM
      )
  } catch {
    return false
  }
}

export function assertSpringsuiUnstakeSafe(payload: SigningPayload, account: string): void {
  assertPtbSafe(payload, account, SPRINGSUI_UNSTAKE_POLICY)
  assertPinnedObjects(payload, PINS, 'SpringSui')
}
