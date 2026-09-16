import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { BLEND_POOL, SOROSWAP_ROUTER } from '../swap/contract-registry'
import { assertSelfPlan, describePlan } from '../swap/plan-validator'

/**
 * Validating a transaction that does several things at once.
 *
 * Every builder until now asserted **exactly one operation**, and that
 * assertion was the thing standing between a user and an agent-composed
 * transaction that quietly paid someone else. Multi-step plans require
 * relaxing it, which means the guarantee has to be rebuilt rather than
 * dropped: each operation is checked individually, and anything the app has no
 * business signing fails the whole envelope.
 *
 * The threat is specific and worth naming. An agent proposes "swap half, supply
 * the rest". If the composer can be talked into adding a payment, the user
 * signs one transaction and approves two very different things — and the
 * dangerous one is invisible next to the one they asked for.
 */

const ME = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'
const STRANGER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const USDC = new Asset('USDC', STRANGER)

function envelope(ops: unknown[], source = ME): string {
  const account = {
    accountId: () => source,
    sequenceNumber: () => '1',
    incrementSequenceNumber: () => undefined,
  }
  const b = new TransactionBuilder(account as never, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
  for (const op of ops) b.addOperation(op as never)
  return b.setTimeout(180).build().toXDR()
}

const selfSwap = () =>
  Operation.pathPaymentStrictSend({
    sendAsset: USDC,
    sendAmount: '10',
    destination: ME,
    destAsset: Asset.native(),
    destMin: '1',
    path: [],
  })

const restingOffer = () =>
  Operation.manageSellOffer({
    selling: Asset.native(),
    buying: USDC,
    amount: '10',
    price: { n: 1, d: 10 },
    offerId: '0',
  })

const trustline = () => Operation.changeTrust({ asset: USDC })

/** A contract this app does not integrate. Well-formed, and not on the list. */
const UNKNOWN_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

const routerSwap = (contractId = SOROSWAP_ROUTER) =>
  new Contract(contractId).call(
    'swap_exact_tokens_for_tokens',
    nativeToScVal(BigInt(10), { type: 'i128' }),
    nativeToScVal(BigInt(1), { type: 'i128' }),
    nativeToScVal([]),
    new Address(ME).toScVal(),
    nativeToScVal(BigInt(9_999_999_999), { type: 'u64' })
  )

const blendSupply = (fn = 'submit') =>
  new Contract(BLEND_POOL).call(
    fn,
    new Address(ME).toScVal(),
    new Address(ME).toScVal(),
    new Address(ME).toScVal(),
    nativeToScVal([])
  )

describe('a plan may do several things', () => {
  it('accepts a swap followed by a resting order', () => {
    // The headline capability: one signature, two steps, atomic.
    expect(() => assertSelfPlan(envelope([selfSwap(), restingOffer()]), ME)).not.toThrow()
  })

  it('accepts a trustline before the swap that needs it', () => {
    // Buying an asset you cannot yet hold requires both, and splitting them
    // into two signatures is the thing multi-step exists to avoid.
    expect(() => assertSelfPlan(envelope([trustline(), selfSwap()]), ME)).not.toThrow()
  })

  it('accepts a single operation, as before', () => {
    // The old behaviour is a special case of the new one, not a separate path.
    expect(() => assertSelfPlan(envelope([selfSwap()]), ME)).not.toThrow()
  })

  it('accepts a plan of several steps', () => {
    expect(() =>
      assertSelfPlan(envelope([trustline(), selfSwap(), restingOffer()]), ME)
    ).not.toThrow()
  })
})

describe('every operation is checked, not just the first', () => {
  it('refuses a payment hidden after a legitimate swap', () => {
    // The attack this file exists for. The swap is exactly what the user
    // asked for; the payment beside it is not, and one signature covers both.
    const payment = Operation.payment({
      destination: STRANGER,
      asset: Asset.native(),
      amount: '1000',
    })
    expect(() => assertSelfPlan(envelope([selfSwap(), payment]), ME)).toThrow(/payment/)
  })

  it('refuses a payment hidden before one', () => {
    // Position must not matter. Checking only the last operation would be as
    // wrong as checking only the first.
    const payment = Operation.payment({
      destination: STRANGER,
      asset: Asset.native(),
      amount: '1000',
    })
    expect(() => assertSelfPlan(envelope([payment, selfSwap()]), ME)).toThrow(/payment/)
  })

  it('refuses a path payment that delivers to somebody else', () => {
    // The subtle version: the right operation type, pointed elsewhere.
    const away = Operation.pathPaymentStrictSend({
      sendAsset: USDC,
      sendAmount: '10',
      destination: STRANGER,
      destAsset: Asset.native(),
      destMin: '1',
      path: [],
    })
    expect(() => assertSelfPlan(envelope([selfSwap(), away]), ME)).toThrow(
      /not the signing account/
    )
  })

  it('refuses an operation that hands control of the account away', () => {
    // Set-options can add a signer or raise thresholds. Nothing in a trading
    // plan needs it, and its consequence outlives every trade.
    const takeover = Operation.setOptions({
      signer: { ed25519PublicKey: STRANGER, weight: 255 },
    })
    expect(() => assertSelfPlan(envelope([selfSwap(), takeover]), ME)).toThrow(/setOptions/)
  })

  it('refuses merging the account away', () => {
    const merge = Operation.accountMerge({ destination: STRANGER })
    expect(() => assertSelfPlan(envelope([merge]), ME)).toThrow(/accountMerge/)
  })

  it('refuses an operation sourced from another account', () => {
    // Stellar lets each operation name its own source. An operation attributed
    // to somebody else in the user's transaction is never something the app
    // should build.
    const foreign = Operation.pathPaymentStrictSend({
      sendAsset: USDC,
      sendAmount: '10',
      destination: STRANGER,
      destAsset: Asset.native(),
      destMin: '1',
      path: [],
      source: STRANGER,
    })
    expect(() => assertSelfPlan(envelope([foreign]), ME)).toThrow()
  })
})

describe('a contract call is checked by contract, not by operation type', () => {
  it('accepts a call to a contract the app integrates', () => {
    expect(() => assertSelfPlan(envelope([routerSwap()]), ME)).not.toThrow()
  })

  it('refuses a call to a contract the app does not integrate', () => {
    // The gap this closes. Before, *any* contract on the network passed here,
    // because only the operation type was checked. A user reviewing the plan
    // would have read "Swap via router" over a call to a stranger's contract.
    expect(() => assertSelfPlan(envelope([routerSwap(UNKNOWN_CONTRACT)]), ME)).toThrow(
      /not a contract this app calls/
    )
  })

  it('refuses a function the contract is not integrated for', () => {
    // Allowing the contract but not the function matters because a lending
    // pool that supplies also borrows. "Supply to Blend" over a `borrow` call
    // would be the safety mechanism itself telling the lie.
    expect(() => assertSelfPlan(envelope([blendSupply('borrow')]), ME)).toThrow(
      /does not accept borrow/
    )
  })

  it('refuses an unknown contract hidden behind a legitimate one', () => {
    // Position must not matter here either.
    expect(() =>
      assertSelfPlan(envelope([routerSwap(), routerSwap(UNKNOWN_CONTRACT)]), ME)
    ).toThrow(/step 2/)
  })

  it('names the contract in review rather than the operation type', () => {
    const steps = assertSelfPlan(envelope([routerSwap(), blendSupply()]), ME)
    expect(describePlan(steps)).toEqual(['1. Swap via Soroswap', '2. Supply to Blend'])
  })

  it('still describes classic operations by type', () => {
    const steps = assertSelfPlan(envelope([trustline(), selfSwap()]), ME)
    expect(describePlan(steps)).toEqual(['1. Allow asset', '2. Swap'])
  })
})

describe('envelope-level rules still hold', () => {
  it('refuses a transaction sourced from another account', () => {
    expect(() => assertSelfPlan(envelope([selfSwap()], STRANGER), ME)).toThrow(/is not the account/)
  })

  it('refuses an empty plan', () => {
    // A transaction that does nothing is not a plan, and signing one is a fee
    // for no reason.
    expect(() => assertSelfPlan(envelope([]), ME)).toThrow(/no operations/)
  })

  it('refuses a plan longer than a person can review', () => {
    // Stellar permits 100 operations. A plan nobody can read before signing is
    // not reviewed, whatever the network allows.
    const many = Array.from({ length: 12 }, () => selfSwap())
    expect(() => assertSelfPlan(envelope(many), ME)).toThrow(/too many steps/)
  })
})
