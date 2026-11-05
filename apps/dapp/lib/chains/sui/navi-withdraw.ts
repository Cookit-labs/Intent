import { bcs } from '@mysten/sui/bcs'
import { ObjectError } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { fromHex, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'

import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type PreparedAction,
  type SigningPayload,
} from '../types'
import { assertSuiAccount, buildUnsigned, suiClient } from './client'
import {
  assertCallsPinned,
  dryRunChange,
  gaveWhatWasAsked,
  pinnedPolicy,
  type PinnedCalls,
} from './lending-calls'
import { NAVI_PACKAGE } from './policies'
import { assertPtbSafe, moveTarget } from './safety'
import { displayAmount, SUI_TOKENS } from './tokens'

/**
 * NAVI's `/navi/config` and `/navi/pools`, what @naviprotocol/lending's `getConfig` and
 * `getPools` return. Pinned rather than read each time, so getting money out doesn't
 * depend on NAVI's server. On chain each is a shared object of the type
 * `incentive_v3::entry_withdraw` and `oracle_pro::update_single_price_v3` declare, and
 * the live test fails when NAVI's config moves away from any of them.
 */
export const NAVI_STORAGE = '0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe'
export const NAVI_INCENTIVE_V2 =
  '0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c'
export const NAVI_INCENTIVE_V3 =
  '0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80'
export const NAVI_PRICE_ORACLE =
  '0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef'
export const NAVI_USDC_POOL = '0xa3582097b4c57630046c0c49a88bfc6b202a3ec0a9db5597c31765f7563755a8'
export const NAVI_USDC_ASSET_ID = 10
export const NAVI_ORACLE_PACKAGE =
  '0x4837ae94425107554c8847721cf9954c1ad8e10520433b9e37dc11c507148bea'
export const NAVI_ORACLE_CONFIG =
  '0x1afe1cb83634f581606cc73c4487ddd8cc39a944b951283af23f7d69d5589478'
export const NAVI_SUPRA_HOLDER =
  '0xaa0315f0748c1f24ddb2b45f7939cff40f7a8104af5ccbc4a1d32f870c0b4105'
export const NAVI_SWITCHBOARD = '0x1fa7566f40f93cdbafd5a029a231e06664219444debb59beec2fe3f19ca08b7e'
export const NAVI_USDC_PYTH_OBJECT =
  '0x6ddfc6f9921e55998cbc2e68f78eba897981d79ac17f66c5277bc38954a2a3f8'
export const NAVI_USDC_FEED = '0xe120611435395f144b4bcc4466a00b6b26d7a27318f96e148648852a9dd6b31c'
/** The `user_info` table of the storage object above: address to the assets a person holds. */
export const NAVI_USER_INFO = '0xabc6c3fbc89b96e3351fdbeb5730bcc5398648367260c6a4e201779e34694e04'

const USDC = SUI_TOKENS.find((t) => t.symbol === 'USDC')
if (USDC === undefined) throw new Error('USDC is missing from the Sui token table.')
const USDC_TYPE = USDC.id

const CLOCK = '0x0000000000000000000000000000000000000000000000000000000000000006'
const ENTRY_DEPOSIT = moveTarget(NAVI_PACKAGE, 'incentive_v3', 'entry_deposit')
const ENTRY_WITHDRAW = moveTarget(NAVI_PACKAGE, 'incentive_v3', 'entry_withdraw')
const UPDATE_PRICE = moveTarget(NAVI_ORACLE_PACKAGE, 'oracle_pro', 'update_single_price_v3')
const ASSET_ID_BYTES = toBase64(bcs.u8().serialize(NAVI_USDC_ASSET_ID).toBytes())

/**
 * `entry_withdraw` names no recipient: the contract pays the sender. Only the USDC
 * pool is allowed, so the type and the asset id can't point at another reserve.
 * `update_single_price_v3` moves no money. It only copies a price into NAVI's oracle.
 */
const PINS: PinnedCalls = new Map([
  [
    ENTRY_DEPOSIT,
    {
      typeArguments: [USDC_TYPE],
      argumentCount: 8,
      objects: { 1: NAVI_STORAGE, 2: NAVI_USDC_POOL, 6: NAVI_INCENTIVE_V2, 7: NAVI_INCENTIVE_V3 },
      pure: { 3: ASSET_ID_BYTES },
    },
  ],
  [
    ENTRY_WITHDRAW,
    {
      typeArguments: [USDC_TYPE],
      argumentCount: 8,
      objects: {
        1: NAVI_PRICE_ORACLE,
        2: NAVI_STORAGE,
        3: NAVI_USDC_POOL,
        6: NAVI_INCENTIVE_V2,
        7: NAVI_INCENTIVE_V3,
      },
      pure: { 4: ASSET_ID_BYTES },
    },
  ],
  [
    UPDATE_PRICE,
    {
      typeArguments: [],
      argumentCount: 7,
      objects: {
        1: NAVI_ORACLE_CONFIG,
        2: NAVI_PRICE_ORACLE,
        3: NAVI_SUPRA_HOLDER,
        4: NAVI_USDC_PYTH_OBJECT,
        5: NAVI_SWITCHBOARD,
      },
      pure: { 6: toBase64(bcs.Address.serialize(NAVI_USDC_FEED).toBytes()) },
    },
  ],
])

export const NAVI_EXIT_POLICY = pinnedPolicy('NAVI', PINS)

export function assertNaviSafe(payload: SigningPayload, account: string): void {
  assertPtbSafe(payload, account, NAVI_EXIT_POLICY)
  assertCallsPinned(payload, PINS, 'NAVI')
}

export interface NaviHoldings {
  collaterals: readonly number[]
  loans: readonly number[]
}

const UserInfo = bcs.struct('UserInfo', {
  collaterals: bcs.vector(bcs.u8()),
  loans: bcs.vector(bcs.u8()),
})

/** The assets a wallet holds on NAVI, read from the chain. Nothing when it has never used NAVI. */
export async function readNaviHoldings(account: string): Promise<NaviHoldings | undefined> {
  try {
    const { dynamicField } = await suiClient().core.getDynamicField({
      parentId: NAVI_USER_INFO,
      name: { type: 'address', bcs: fromHex(normalizeSuiAddress(account)) },
    })
    return UserInfo.parse(dynamicField.value.bcs)
  } catch (e) {
    if (e instanceof ObjectError && e.code === 'notExists') return undefined
    throw e
  }
}

/**
 * Refuses what this can't withdraw. NAVI aborts a withdrawal unless every asset the
 * person holds has a price set in the same transaction, and only USDC's feed is pinned
 * here, so anyone holding more is sent to NAVI's own app.
 */
export function assertWithdrawableHoldings(holdings: NaviHoldings | undefined): void {
  if (holdings === undefined || !holdings.collaterals.includes(NAVI_USDC_ASSET_ID)) {
    throw new ChainActionRefused('This wallet has no USDC in NAVI. Nothing was signed or sent.')
  }
  if (holdings.loans.length > 0 || holdings.collaterals.length > 1) {
    throw new ChainActionRefused(
      'You hold other assets or a loan on NAVI, and I can only withdraw from a USDC-only position. Withdraw at app.naviprotocol.io. Nothing was signed or sent.'
    )
  }
}

export async function prepareNaviWithdraw(
  request: ChainActionRequest,
  account: string,
  readHoldings: typeof readNaviHoldings = readNaviHoldings
): Promise<PreparedAction> {
  assertSuiAccount(account)
  const token = tokenBySymbol(SUI_TOKENS, request.tokenIn)
  if (token?.symbol !== 'USDC') {
    throw new ChainActionRefused(
      `NAVI takes USDC here, not ${request.tokenIn}. Nothing was signed or sent. Try "withdraw 10 USDC from NAVI".`
    )
  }
  const amount = toBaseUnits(request.amount, token.decimals)
  assertWithdrawableHoldings(await readHoldings(account))

  const tx = new Transaction()
  tx.setSender(account)
  tx.moveCall({
    target: UPDATE_PRICE,
    arguments: [
      tx.object(CLOCK),
      tx.object(NAVI_ORACLE_CONFIG),
      tx.object(NAVI_PRICE_ORACLE),
      tx.object(NAVI_SUPRA_HOLDER),
      tx.object(NAVI_USDC_PYTH_OBJECT),
      tx.object(NAVI_SWITCHBOARD),
      tx.pure.address(NAVI_USDC_FEED),
    ],
  })
  tx.moveCall({
    target: ENTRY_WITHDRAW,
    typeArguments: [USDC_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(NAVI_PRICE_ORACLE),
      tx.object(NAVI_STORAGE),
      tx.object(NAVI_USDC_POOL),
      tx.pure.u8(NAVI_USDC_ASSET_ID),
      tx.pure.u64(amount),
      tx.object(NAVI_INCENTIVE_V2),
      tx.object(NAVI_INCENTIVE_V3),
    ],
  })

  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const received = await dryRunChange(transaction, token.id, account, 'Checking the withdrawal')
  if (received === undefined || received <= BigInt(0)) {
    throw new ChainActionRefused(
      "I couldn't confirm this withdrawal would return anything, so I stopped. Nothing was signed or sent. Try again shortly."
    )
  }
  const receive = displayAmount(received.toString(), token.decimals)
  // The contract pays the smaller of the amount and what the person holds.
  if (!gaveWhatWasAsked(received, BigInt(amount))) {
    throw new ChainActionRefused(
      `You have about ${receive} USDC in NAVI, which is less than ${request.amount}. Nothing was signed or sent. Try ${receive}.`
    )
  }

  return {
    venueId: 'navi',
    venueName: 'NAVI',
    kind: 'withdraw',
    summary: `Withdraw about ${receive} USDC from NAVI's main lending market to your wallet.`,
    pay: { amount: request.amount, symbol: token.symbol },
    receive: { amount: receive, symbol: token.symbol, approximate: true },
    notes: [
      'If most of the pool is lent out, this can fail until borrowers repay.',
      "NAVI needs a current USDC price to let money out, and this reads one that others publish on chain. If that price has gone stale, this stops until it's fresh again.",
    ],
    signing: { family: 'sui', transaction },
  }
}
