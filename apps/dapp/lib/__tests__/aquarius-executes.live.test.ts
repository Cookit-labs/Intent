import { stellarTestnet } from '@intent/config'
import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { USDC, XLM, applySlippage, toBaseUnits } from '../swap/assets'
import { buildAquariusSwap } from '../swap/build-aquarius'
import { prepareSorobanSwap } from '../swap/build-soroban'
import { createAquariusQuoter } from '../swap/sources/aquarius-quoter'
import { submitSignedSwap } from '../swap/submit'
import { assertSelfSubmission } from '../swap/venue-routing'

/**
 * An Aquarius swap taken all the way: signed, broadcast, and filled.
 *
 * Every other Aquarius test stops at simulation, and simulation is where the
 * venue sat for a week marked "listed" — accepted by the router in a dry run
 * and never once settled on a ledger. This is the evidence the `executes`
 * claim rests on. It runs the exact path the app runs, with the one step the
 * app cannot do in a test done by a throwaway key: fund an account, open the
 * trustline the router needs to pay it, quote, build against the quoted
 * pool, simulate, sign, re-assert the signed bytes as the submit route does,
 * and post to Horizon.
 *
 * Testnet only. Friendbot funds the account, so nothing here can be run
 * against a network where XLM costs money.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const HORIZON = stellarTestnet.horizonUrl
const PASSPHRASE = stellarTestnet.networkPassphrase

/** 10 XLM: small enough not to move a synthetic pool, large enough to fill. */
const SEND = '100000000'

async function sequenceOf(account: string): Promise<string> {
  const res = await fetch(`${HORIZON}/accounts/${account}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Horizon ${res.status} reading ${account}`)
  const body = (await res.json()) as { sequence?: string }
  if (body.sequence === undefined) throw new Error('Horizon returned no sequence')
  return body.sequence
}

async function usdcBalance(account: string): Promise<bigint> {
  const res = await fetch(`${HORIZON}/accounts/${account}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Horizon ${res.status} reading ${account}`)
  const body = (await res.json()) as {
    balances?: { asset_code?: string; asset_issuer?: string; balance: string }[]
  }
  const line = body.balances?.find(
    (b) => b.asset_code === USDC.code && b.asset_issuer === USDC.issuer
  )
  return line === undefined ? BigInt(0) : BigInt(toBaseUnits(line.balance))
}

/** A fresh account, funded by friendbot, holding a USDC trustline. */
async function throwawayAccount(): Promise<Keypair> {
  const kp = Keypair.random()
  const funded = await fetch(`${stellarTestnet.friendbotUrl}?addr=${kp.publicKey()}`)
  if (!funded.ok) throw new Error(`friendbot ${funded.status}: cannot fund a test account`)

  // The router pays USDC through its Stellar Asset Contract, and a SAC
  // transfer to a classic account needs the trustline like any payment does.
  const trust = new TransactionBuilder(
    new Account(kp.publicKey(), await sequenceOf(kp.publicKey())),
    {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    }
  )
    .addOperation(Operation.changeTrust({ asset: new Asset(USDC.code, USDC.issuer as string) }))
    .setTimeout(60)
    .build()
  trust.sign(kp)
  const result = await submitSignedSwap(trust.toXDR())
  if (!result.ok) throw new Error(`trustline refused: ${result.reason} ${result.detail ?? ''}`)
  return kp
}

describe.skipIf(SKIP)('an Aquarius swap, signed and settled on testnet', () => {
  it('fills XLM for USDC through the quoted pool and pays the signer', async () => {
    const kp = await throwawayAccount()
    const me = kp.publicKey()

    // The quote is also the liveness check on the router: a testnet reset
    // that removed it would fail `get_pools` here, before anything is built.
    const quoted = await createAquariusQuoter().quote({
      kind: 'strict_send',
      from: XLM,
      to: USDC,
      sendAmount: SEND,
    })
    if (!quoted.ok) throw new Error(`Aquarius did not quote: ${quoted.failure.reason}`)
    if (quoted.quote.poolIndex === undefined) throw new Error('quote carried no pool index')

    // The same floor the build route applies, so this proves the app's own
    // numbers fill rather than a floor loosened for the test.
    const minReceive = applySlippage(quoted.quote.destAmount, 50)

    const built = await buildAquariusSwap({
      account: me,
      from: XLM,
      to: USDC,
      sendAmount: SEND,
      minReceive,
      poolIndex: quoted.quote.poolIndex,
    })

    const prepared = await prepareSorobanSwap(built.xdr)
    if (!prepared.ok) throw new Error(`router refused in simulation: ${prepared.reason}`)

    const tx = TransactionBuilder.fromXDR(prepared.xdr, PASSPHRASE)
    if (tx instanceof FeeBumpTransaction) throw new Error('unexpected fee bump')
    tx.sign(kp)
    const signed = tx.toXDR()

    // What the submit route runs on the bytes it is handed. Passing here is
    // what makes the route's acceptance of a real signature a checked claim.
    expect(() => assertSelfSubmission(signed, me)).not.toThrow()

    const before = await usdcBalance(me)
    const result = await submitSignedSwap(signed)
    expect(result.ok, result.ok ? '' : `${result.reason}: ${result.detail ?? ''}`).toBe(true)
    if (!result.ok) return

    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)

    // Read from the ledger, not from the result: a Soroban result carries no
    // path-payment claim atoms, so the balance is the only honest figure.
    const after = await usdcBalance(me)
    const delivered = after - before
    expect(delivered).toBeGreaterThanOrEqual(BigInt(minReceive))
  }, 180_000)
})
