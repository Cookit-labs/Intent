import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  type xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { createContractsRegistry } from '../lend/defindex/contracts'
import { assertDefindexDeposit, buildDefindexDeposit } from '../lend/defindex/deposit'

/**
 * Admitting a deposit somebody else built.
 *
 * This is the one place in the app where the envelope to sign comes from a
 * third party's server rather than from this code. Blend's supply is built
 * here and re-read as a formality; DeFindex's is built by its API and re-read
 * because that is the only check there is. So the assertion is the feature:
 * the transaction must be sourced by the signer, contain exactly one call, to
 * the vault the plan resolved, named `deposit`, funded `from` the signer, of
 * exactly the planned amount, with a floor no higher than that amount. A
 * well-formed envelope pointed anywhere else is refused by the field that
 * differs.
 *
 * The argument order `(amounts_desired, amounts_min, from, invest)` was
 * verified by simulating a deposit against the live testnet vault on
 * 2026-09-23: 1 XLM returned `[[10000000], 5996, [null]]`.
 */

const ME = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'
const STRANGER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const VAULT = 'CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6'
const OTHER_VAULT = 'CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN'
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
/** What the USDC vault actually holds: not the USDC this app trades. */
const VAULT_USDC = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'

const AMOUNT = '10000000'
const PLAN = { vault: VAULT, amount: AMOUNT }

interface DepositShape {
  vault?: string
  fn?: string
  desired?: string[]
  min?: string[]
  from?: string
}

function depositOp(shape: DepositShape = {}): xdr.Operation {
  return new Contract(shape.vault ?? VAULT).call(
    shape.fn ?? 'deposit',
    nativeToScVal((shape.desired ?? [AMOUNT]).map(BigInt), { type: 'i128' }),
    nativeToScVal((shape.min ?? [AMOUNT]).map(BigInt), { type: 'i128' }),
    new Address(shape.from ?? ME).toScVal(),
    nativeToScVal(true)
  )
}

function envelope(ops: xdr.Operation[], source = ME): string {
  const builder = new TransactionBuilder(new Account(source, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
  for (const op of ops) builder.addOperation(op)
  return builder.setTimeout(180).build().toXDR()
}

describe('admitting a deposit the API built', () => {
  it('accepts a lone deposit of the planned amount, from the signer, into the planned vault', () => {
    expect(() => assertDefindexDeposit(envelope([depositOp()]), ME, PLAN)).not.toThrow()
  })

  it('refuses a transaction sourced from another account', () => {
    expect(() => assertDefindexDeposit(envelope([depositOp()], STRANGER), ME, PLAN)).toThrow(
      /source/
    )
  })

  it('refuses a second operation riding along', () => {
    // The relay sponsors fees, so an extra payment would cost the signer
    // nothing at submission and everything at settlement.
    const payment = Operation.payment({
      destination: STRANGER,
      asset: Asset.native(),
      amount: '1',
    })
    expect(() => assertDefindexDeposit(envelope([depositOp(), payment]), ME, PLAN)).toThrow(
      /exactly one/
    )
  })

  it('refuses an operation that is not a contract call', () => {
    const payment = Operation.payment({
      destination: STRANGER,
      asset: Asset.native(),
      amount: '1',
    })
    expect(() => assertDefindexDeposit(envelope([payment]), ME, PLAN)).toThrow(
      /not a contract invocation/
    )
  })

  it('refuses a call to a different contract', () => {
    // Same function, same arguments, different vault: a deposit into a
    // contract nobody checked.
    expect(() =>
      assertDefindexDeposit(envelope([depositOp({ vault: OTHER_VAULT })]), ME, PLAN)
    ).toThrow(/not the vault/)
  })

  it('refuses a call that is not deposit', () => {
    expect(() =>
      assertDefindexDeposit(envelope([depositOp({ fn: 'withdraw' })]), ME, PLAN)
    ).toThrow(/withdraw is not a deposit/)
  })

  it('refuses a deposit funded from somebody else', () => {
    expect(() =>
      assertDefindexDeposit(envelope([depositOp({ from: STRANGER })]), ME, PLAN)
    ).toThrow(/as from/)
  })

  it('refuses an amount other than the plan', () => {
    expect(() =>
      assertDefindexDeposit(
        envelope([depositOp({ desired: ['20000000'], min: ['20000000'] })]),
        ME,
        PLAN
      )
    ).toThrow(/20000000 is not the 10000000/)
  })

  it('refuses more than one asset amount', () => {
    // The vaults this app uses hold one asset. A second amount is a deposit
    // of something the plan never named.
    expect(() =>
      assertDefindexDeposit(
        envelope([depositOp({ desired: [AMOUNT, '1'], min: [AMOUNT, '1'] })]),
        ME,
        PLAN
      )
    ).toThrow(/one asset/)
  })

  it('refuses a minimum above the amount', () => {
    // A floor the contract can never meet is a deposit that always reverts,
    // and a floor at all is a sign the envelope is not the one requested.
    expect(() =>
      assertDefindexDeposit(envelope([depositOp({ min: ['20000000'] })]), ME, PLAN)
    ).toThrow(/minimum/)
  })

  it('refuses a fee-bump envelope', () => {
    const inner = TransactionBuilder.fromXDR(envelope([depositOp()]), Networks.TESTNET)
    const bumped = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.fromPublicKey(STRANGER),
      '1000',
      inner as Parameters<typeof TransactionBuilder.buildFeeBumpTransaction>[2],
      Networks.TESTNET
    ).toXDR()
    expect(() => assertDefindexDeposit(bumped, ME, PLAN)).toThrow(/fee-bump/)
  })
})

/** A registry that serves the XLM vault, and an API that answers with `reply`. */
function wiring(reply: unknown, ids: Record<string, string> = { xlm_paltalabs_vault: VAULT }) {
  const registry = createContractsRegistry({
    fetchImpl: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ids, hashes: {} }), { status: 200 })
      )) as unknown as typeof fetch,
  })
  const posted: unknown[] = []
  const fetchImpl = ((_url: string, init: RequestInit = {}) => {
    if (typeof init.body === 'string') posted.push(JSON.parse(init.body))
    return Promise.resolve(
      new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }) as unknown as typeof fetch
  return { registry, fetchImpl, posted }
}

const holdsXlm = () => Promise.resolve([{ address: XLM_SAC, strategies: [] }])
const holdsOtherUsdc = () => Promise.resolve([{ address: VAULT_USDC, strategies: [] }])

describe('building a deposit', () => {
  it('resolves the vault, checks its asset on-chain, and returns the API envelope once checked', async () => {
    const { registry, fetchImpl, posted } = wiring({ xdr: envelope([depositOp()]) })

    const built = await buildDefindexDeposit({
      account: ME,
      symbol: 'XLM',
      amount: AMOUNT,
      apiKey: 'sk_test',
      registry,
      fetchImpl,
      readAssets: holdsXlm,
    })

    expect(built.vault).toBe(VAULT)
    expect(built.asset).toBe('XLM')
    expect(built.assetContract).toBe(XLM_SAC)
    expect(built.amount).toBe(AMOUNT)
    expect(built.recipient).toBe(ME)
    expect(posted[0]).toMatchObject({ amounts: [10000000], caller: ME })
    expect(() => assertDefindexDeposit(built.xdr, ME, PLAN)).not.toThrow()
  })

  it('is refused when the vault holds a different asset than the swap delivers', async () => {
    const { registry, fetchImpl, posted } = wiring({ xdr: envelope([depositOp()]) })

    await expect(
      buildDefindexDeposit({
        account: ME,
        symbol: 'XLM',
        amount: AMOUNT,
        apiKey: 'sk_test',
        registry,
        fetchImpl,
        readAssets: holdsOtherUsdc,
      })
    ).rejects.toThrow(/holds CAQCFV/)
    // Refused before the API was asked for anything.
    expect(posted).toHaveLength(0)
  })

  it('is refused when the registry has no vault for the asset', async () => {
    const { registry, fetchImpl } = wiring({ xdr: envelope([depositOp()]) }, {})

    await expect(
      buildDefindexDeposit({
        account: ME,
        symbol: 'XLM',
        amount: AMOUNT,
        apiKey: 'sk_test',
        registry,
        fetchImpl,
        readAssets: holdsXlm,
      })
    ).rejects.toThrow(/no XLM vault/)
  })

  it('refuses an envelope from the API that credits somebody else', async () => {
    // The attack the assertion exists for, arriving from the one place it
    // could: a well-formed deposit whose `from` is not the signer.
    const { registry, fetchImpl } = wiring({ xdr: envelope([depositOp({ from: STRANGER })]) })

    await expect(
      buildDefindexDeposit({
        account: ME,
        symbol: 'XLM',
        amount: AMOUNT,
        apiKey: 'sk_test',
        registry,
        fetchImpl,
        readAssets: holdsXlm,
      })
    ).rejects.toThrow(/as from/)
  })

  it('refuses an asset this app cannot trade', async () => {
    const { registry, fetchImpl } = wiring({ xdr: envelope([depositOp()]) })

    await expect(
      buildDefindexDeposit({
        account: ME,
        symbol: 'DOGE',
        amount: AMOUNT,
        apiKey: 'sk_test',
        registry,
        fetchImpl,
        readAssets: holdsXlm,
      })
    ).rejects.toThrow(/DOGE/)
  })
})
