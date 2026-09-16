import { stellarTestnet } from '@intent/config'
import {
  Account,
  Asset,
  BASE_FEE,
  Memo,
  Operation,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk'

import type { ClassicAsset } from './assets'
import { fromBaseUnits, isNative } from './assets'
import { resolveVerifiedAsset } from './asset-registry'
import { resolveTradableAsset } from './testnet-assets'
import type { PriceFraction } from './limit-price'
import { assertSelfPlan, describePlan, MAX_PLAN_STEPS, type PlanStep } from './plan-validator'

/**
 * Composing several actions into one signature.
 *
 * This is the capability that makes the agent competition worth having. Until
 * now an intent produced exactly one transaction, so four agents proposing
 * four strategies all signed the same thing — the reasoning differed and the
 * outcome did not. A plan is where they can genuinely diverge: swap everything
 * now, or swap half and rest the remainder, or take a trustline first and buy
 * an asset the account cannot currently hold.
 *
 * **Atomic by construction.** Stellar executes a transaction's operations all
 * or none, so there is no half-finished plan leaving a user holding an asset
 * they were mid-way through trading. That is a property of the network rather
 * than something this code arranges, and it is why multi-step here is
 * genuinely different from firing several transactions in sequence.
 *
 * Every plan is re-read and validated before it is returned. The inputs are
 * already known to be right; what matters is that the bytes about to be signed
 * say the same thing.
 */

/** Marks a plan this app produced. Stellar text memos cap at 28 bytes. */
export const PLAN_MEMO = 'intent:plan:v1'

const TIMEOUT_SECONDS = 180

/** Swap one asset for another, delivering to the signer. */
export interface SwapAction {
  kind: 'swap'
  from: ClassicAsset
  to: ClassicAsset
  /** Base units. */
  sendAmount: string
  /** Base units. The floor the network enforces. */
  minReceive: string
}

/** Rest an order on the book rather than trading now. */
export interface RestAction {
  kind: 'rest'
  selling: ClassicAsset
  buying: ClassicAsset
  /** Display units. */
  amount: string
  price: PriceFraction
}

/** Allow the account to hold an asset it currently cannot. */
export interface TrustAction {
  kind: 'trust'
  asset: ClassicAsset
}

/** Contribute both sides of a pair to a liquidity pool. */
export interface PoolAction {
  kind: 'pool'
  poolId: string
  maxAmountA: string
  maxAmountB: string
  minPrice: PriceFraction
  maxPrice: PriceFraction
}

/**
 * Supply an asset to a lending pool.
 *
 * Unlike every other action here, this one **cannot share a transaction**.
 * Soroban permits exactly one operation per transaction — verified on testnet
 * twice — so a lend is built as its own envelope by `buildBlendSupply` and
 * signed separately. It appears in this union so a plan can *describe* a
 * sequence containing one; `buildPlan` refuses to fold it into a shared
 * envelope rather than building something the network would reject.
 */
export interface LendAction {
  kind: 'lend'
  /** The reserve's asset, as a contract id. Read from the pool, never derived. */
  asset: string
  /** Base units. */
  amount: string
  venue: 'blend'
}

export type PlanAction = SwapAction | RestAction | TrustAction | PoolAction | LendAction

/**
 * Actions that must be signed on their own.
 *
 * Kept as a set rather than a check at the point of use, so adding another
 * Soroban action later cannot forget the constraint.
 */
const NEEDS_OWN_TRANSACTION = new Set<PlanAction['kind']>(['lend'])

/** Whether an action has to be signed by itself. */
export function needsOwnTransaction(action: PlanAction): boolean {
  return NEEDS_OWN_TRANSACTION.has(action.kind)
}

export interface BuildPlanOptions {
  account: string
  actions: PlanAction[]
  horizonUrl?: string
  fetchImpl?: typeof fetch
}

export interface BuiltPlan {
  xdr: string
  /** Each step, as read back out of the encoded transaction. */
  steps: PlanStep[]
  /** Numbered, human-readable, for the confirmation screen. */
  description: string[]
  networkPassphrase: string
}

function toSdkAsset(asset: ClassicAsset): Asset {
  if (isNative(asset)) return Asset.native()
  if (asset.issuer === undefined) throw new Error(`asset ${asset.code} needs an issuer`)
  return new Asset(asset.code, asset.issuer)
}

/**
 * Refuses an asset the app has not admitted through either tier.
 *
 * Checked per action rather than once, because a squatted asset in step three
 * is exactly as dangerous as one in step one — and a plan is precisely where a
 * bad asset could hide behind good ones.
 */
function requireTradable(asset: ClassicAsset): void {
  if (resolveVerifiedAsset(asset.code) !== undefined) return
  const known = resolveTradableAsset(asset.code)
  if (known === undefined || known.issuer !== asset.issuer) {
    throw new Error(`${asset.code} is not a verified asset`)
  }
}

function operationFor(action: PlanAction, account: string): xdr.Operation {
  switch (action.kind) {
    case 'swap': {
      requireTradable(action.from)
      requireTradable(action.to)
      if (BigInt(action.sendAmount) <= BigInt(0)) {
        throw new Error('a swap needs a positive amount')
      }
      return Operation.pathPaymentStrictSend({
        sendAsset: toSdkAsset(action.from),
        sendAmount: fromBaseUnits(action.sendAmount),
        // Never a parameter. The destination is the signer, stated here and
        // asserted again when the plan is re-read.
        destination: account,
        destAsset: toSdkAsset(action.to),
        destMin: fromBaseUnits(action.minReceive),
        path: [],
      })
    }

    case 'rest': {
      requireTradable(action.selling)
      requireTradable(action.buying)
      if (Number(action.amount) <= 0) {
        throw new Error('an order needs a positive amount')
      }
      return Operation.manageSellOffer({
        selling: toSdkAsset(action.selling),
        buying: toSdkAsset(action.buying),
        amount: action.amount,
        price: action.price,
        // Zero creates a new offer rather than editing one.
        offerId: '0',
      })
    }

    case 'trust': {
      requireTradable(action.asset)
      return Operation.changeTrust({ asset: toSdkAsset(action.asset) })
    }

    case 'pool': {
      if (Number(action.maxAmountA) <= 0 || Number(action.maxAmountB) <= 0) {
        throw new Error('a deposit needs a positive amount on both sides')
      }
      return Operation.liquidityPoolDeposit({
        liquidityPoolId: action.poolId,
        maxAmountA: action.maxAmountA,
        maxAmountB: action.maxAmountB,
        minPrice: action.minPrice,
        maxPrice: action.maxPrice,
      })
    }

    case 'lend': {
      // Unreachable: `buildPlan` rejects a lend before it gets here. Kept
      // explicit rather than left to the exhaustiveness check, because the
      // failure it prevents — a Soroban operation quietly folded into a classic
      // envelope — would be rejected by the network with a message that names
      // none of this.
      throw new Error(
        'a lend cannot share a transaction: Soroban permits one operation per transaction, ' +
          'so it is built and signed on its own'
      )
    }
  }
}

async function loadSequence(
  account: string,
  horizonUrl: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const res = await fetchImpl(`${horizonUrl}/accounts/${account}`, {
    headers: { Accept: 'application/json' },
  })
  if (res.status === 404) {
    throw new Error('This account is not funded yet, so it cannot execute a plan.')
  }
  if (!res.ok) throw new Error(`Horizon ${res.status}`)
  const body = (await res.json()) as { sequence?: string }
  if (body.sequence === undefined) throw new Error('Horizon returned no sequence number')
  return body.sequence
}

export async function buildPlan(options: BuildPlanOptions): Promise<BuiltPlan> {
  const { account, actions } = options
  const horizonUrl = options.horizonUrl ?? stellarTestnet.horizonUrl
  const fetchImpl = options.fetchImpl ?? fetch

  if (actions.length === 0) {
    throw new Error('a plan needs at least one action')
  }

  // Checked before anything else, and by name, so the caller learns *which*
  // action cannot be folded in. A sequence containing a lend is legitimate —
  // it is simply signed a step at a time rather than all at once.
  const soloAction = actions.find(needsOwnTransaction)
  if (soloAction !== undefined) {
    throw new Error(
      `a ${soloAction.kind} action must be signed on its own, not folded into a plan. ` +
        'Soroban permits exactly one operation per transaction.'
    )
  }
  // Checked before building rather than after, so an over-long plan fails
  // without a pointless Horizon round trip.
  if (actions.length > MAX_PLAN_STEPS) {
    throw new Error(
      `too many steps (${actions.length}): a plan longer than ${MAX_PLAN_STEPS} cannot be reviewed before signing`
    )
  }

  const operations = actions.map((action) => operationFor(action, account))
  const sequence = await loadSequence(account, horizonUrl, fetchImpl)

  const builder = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarTestnet.networkPassphrase,
  })
  for (const op of operations) builder.addOperation(op)

  const tx = builder.addMemo(Memo.text(PLAN_MEMO)).setTimeout(TIMEOUT_SECONDS).build()
  const xdrString = tx.toXDR()

  // Re-read rather than trusted. Every step is checked against the allowlist,
  // every delivery against the signer, and the whole envelope against the
  // account — the same discipline the single-operation builders apply, now
  // covering a plan of any length.
  const steps = assertSelfPlan(xdrString, account)

  return {
    xdr: xdrString,
    steps,
    description: describePlan(steps),
    networkPassphrase: stellarTestnet.networkPassphrase,
  }
}
