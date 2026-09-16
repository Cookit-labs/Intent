import { Networks, TransactionBuilder } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { USDC, XLM } from '../swap/assets'
import { buildPlan, type PlanAction } from '../swap/build-plan'

/**
 * Composing several actions into one signature.
 *
 * The capability that makes agents worth having. Until now an intent produced
 * one transaction, so four agents proposing four strategies all signed the
 * same thing and the competition was decoration. A plan is where they can
 * genuinely differ: swap everything now, or swap half and rest the remainder,
 * or take a trustline first and then buy.
 *
 * Atomic by construction, which is the part that would be hard to build
 * without Stellar. Either every step happens or none does — no half-executed
 * plan leaving a user holding an asset they were about to trade away.
 */

const ACCOUNT = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'

function stubAccount(): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ id: ACCOUNT, sequence: '4578890000000001' }),
    }) as Response) as unknown as typeof fetch
}

const swapHalf: PlanAction = {
  kind: 'swap',
  from: USDC,
  to: XLM,
  sendAmount: '250000000',
  minReceive: '1',
}

const restRemainder: PlanAction = {
  kind: 'rest',
  selling: USDC,
  buying: XLM,
  amount: '25',
  price: { n: 9, d: 100 },
}

const allowAsset: PlanAction = { kind: 'trust', asset: USDC }

async function plan(actions: PlanAction[]) {
  return buildPlan({ account: ACCOUNT, actions, fetchImpl: stubAccount() })
}

describe('a plan carries several actions', () => {
  it('builds swap-then-rest as one transaction', async () => {
    const built = await plan([swapHalf, restRemainder])
    const tx = TransactionBuilder.fromXDR(built.xdr, Networks.TESTNET)
    expect((tx as { operations: unknown[] }).operations).toHaveLength(2)
  })

  it('preserves the order the agent proposed', async () => {
    // Order is meaning: resting the remainder before swapping would commit
    // funds the swap still needs.
    const built = await plan([allowAsset, swapHalf, restRemainder])
    expect(built.steps.map((s) => s.type)).toEqual([
      'changeTrust',
      'pathPaymentStrictSend',
      'manageSellOffer',
    ])
  })

  it('describes each step for the confirmation screen', async () => {
    // A plan the user cannot read is a plan they cannot refuse.
    const built = await plan([swapHalf, restRemainder])
    expect(built.description).toEqual(['1. Swap', '2. Place order'])
  })

  it('still builds a single action', async () => {
    // The old behaviour as a plan of length one, so there is not a separate
    // path to keep in step.
    const built = await plan([swapHalf])
    expect(built.steps).toHaveLength(1)
  })
})

describe('a plan is refused when it cannot be honoured', () => {
  it('refuses an empty plan', async () => {
    await expect(plan([])).rejects.toThrow(/at least one/)
  })

  it('refuses more steps than can be reviewed', async () => {
    const many = Array.from({ length: 12 }, () => swapHalf)
    await expect(plan(many)).rejects.toThrow(/too many steps/)
  })

  it('refuses an unverified asset anywhere in the plan', async () => {
    // Checked per action rather than on the first: a squatted asset in step
    // three is exactly as dangerous as one in step one.
    const bad: PlanAction = {
      kind: 'swap',
      from: USDC,
      to: {
        kind: 'classic',
        code: 'SCAMCOIN',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      },
      sendAmount: '1000',
      minReceive: '1',
    }
    await expect(plan([swapHalf, bad])).rejects.toThrow(/not a verified asset/)
  })

  it('refuses a zero-amount step', async () => {
    await expect(plan([{ ...swapHalf, sendAmount: '0' }])).rejects.toThrow(/positive/)
  })
})

describe('the plan is atomic and self-directed', () => {
  it('passes its own validator', async () => {
    // Built and then re-read: the bytes about to be signed are what is
    // checked, not the inputs that produced them.
    const built = await plan([swapHalf, restRemainder])
    expect(built.steps).toHaveLength(2)
  })

  it('sends every swap back to the signer', async () => {
    const built = await plan([swapHalf, restRemainder])
    const tx = TransactionBuilder.fromXDR(built.xdr, Networks.TESTNET)
    const ops = (tx as { operations: { type: string; destination?: string }[] }).operations
    for (const op of ops) {
      if (op.destination !== undefined) expect(op.destination).toBe(ACCOUNT)
    }
  })
})

describe('a lend cannot share a signature', () => {
  const supply: PlanAction = {
    kind: 'lend',
    asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    amount: '10000000',
    venue: 'blend',
  }

  it('refuses a lend folded into a plan', async () => {
    // Soroban permits exactly one operation per transaction, verified on
    // testnet twice. Building this anyway would produce an envelope the
    // network rejects with a message naming none of the above.
    await expect(plan([swapHalf, supply])).rejects.toThrow(/must be signed on its own/)
  })

  it('refuses a lend even on its own, through this builder', async () => {
    // Not a plan of one: `buildBlendSupply` owns this shape, and letting it
    // through here would mean two builders producing the same transaction with
    // only one of them asserting the recipient.
    await expect(plan([supply])).rejects.toThrow(/must be signed on its own/)
  })

  it('names the action that cannot be folded in', async () => {
    // The caller has to know *which* step to sequence separately.
    await expect(plan([swapHalf, supply])).rejects.toThrow(/lend/)
  })

  it('still builds a plan of foldable steps', async () => {
    // The guard must not have made ordinary multi-step harder.
    const built = await plan([swapHalf, restRemainder])
    expect(built.steps).toHaveLength(2)
  })
})
