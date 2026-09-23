import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { derivePreview, simulatedPreview } from '../swap/preview'

/**
 * What the user's wallet will look like after signing, stated before signing.
 *
 * An agent's reasoning describes a plan; the transaction is the plan. For a
 * classic transaction every operation carries its amounts and the network
 * enforces the floors (`destMin`) and ceilings (`sendMax`), so the preview is
 * derived from the operations and is a guarantee, not an estimate. For a
 * Soroban invocation the amounts are inside a contract, so the preview comes
 * from the network's own simulation of the call: the ledger entries it says
 * will change, read for the user's balances.
 */

const USER = Keypair.random().publicKey()
const ISSUER = Keypair.random().publicKey()
const USDC = new Asset('USDC', ISSUER)

function classic(ops: xdr.Operation[]): string {
  const builder = new TransactionBuilder(new Account(USER, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
  for (const op of ops) builder.addOperation(op)
  return builder.setTimeout(60).build().toXDR()
}

describe('derivePreview from classic operations', () => {
  it('states a fixed-send path payment as an exact debit and a guaranteed floor', () => {
    const preview = derivePreview(
      classic([
        Operation.pathPaymentStrictSend({
          sendAsset: USDC,
          sendAmount: '20',
          destination: USER,
          destAsset: Asset.native(),
          destMin: '108.3',
          path: [],
        }),
      ]),
      USER,
      Networks.TESTNET
    )
    expect(preview.basis).toBe('derived')
    expect(preview.changes).toEqual([
      { code: 'USDC', delta: '-20', bound: 'exact' },
      { code: 'XLM', delta: '+108.3', bound: 'at_least' },
    ])
  })

  it('states a fixed-receive path payment as an exact credit and a spending ceiling', () => {
    const preview = derivePreview(
      classic([
        Operation.pathPaymentStrictReceive({
          sendAsset: Asset.native(),
          sendMax: '112',
          destination: USER,
          destAsset: USDC,
          destAmount: '20',
          path: [],
        }),
      ]),
      USER,
      Networks.TESTNET
    )
    expect(preview.changes).toEqual([
      { code: 'XLM', delta: '-112', bound: 'at_most' },
      { code: 'USDC', delta: '+20', bound: 'exact' },
    ])
  })

  it('says what an open order commits, since nothing leaves until it fills', () => {
    const preview = derivePreview(
      classic([
        Operation.manageSellOffer({
          selling: Asset.native(),
          buying: USDC,
          amount: '500',
          price: '0.18',
          offerId: '0',
        }),
      ]),
      USER,
      Networks.TESTNET
    )
    expect(preview.changes).toEqual([
      {
        code: 'XLM',
        delta: '-500',
        bound: 'at_most',
        note: 'committed to an open order until it fills or is cancelled',
      },
    ])
  })

  it('says a new trustline raises the reserve', () => {
    const preview = derivePreview(
      classic([Operation.changeTrust({ asset: USDC })]),
      USER,
      Networks.TESTNET
    )
    expect(preview.changes).toEqual([
      {
        code: 'XLM',
        delta: '-0.5',
        bound: 'exact',
        note: 'held as reserve for the USDC trustline',
      },
    ])
  })

  it('merges exact changes to the same asset across operations', () => {
    const preview = derivePreview(
      classic([
        Operation.payment({ destination: ISSUER, asset: Asset.native(), amount: '10' }),
        Operation.payment({ destination: ISSUER, asset: Asset.native(), amount: '5' }),
      ]),
      USER,
      Networks.TESTNET
    )
    expect(preview.changes).toEqual([{ code: 'XLM', delta: '-15', bound: 'exact' }])
  })

  it('reports the fee in XLM', () => {
    const preview = derivePreview(
      classic([Operation.payment({ destination: ISSUER, asset: Asset.native(), amount: '1' })]),
      USER,
      Networks.TESTNET
    )
    expect(preview.feeXlm).toBe('0.00001')
  })

  it('counts an operation it cannot derive rather than guessing', () => {
    const preview = derivePreview(
      classic([
        Operation.invokeContractFunction({
          contract: Asset.native().contractId(Networks.TESTNET),
          function: 'swap',
          args: [],
        }),
      ]),
      USER,
      Networks.TESTNET
    )
    expect(preview.changes).toEqual([])
    expect(preview.unresolved).toBe(1)
  })
})

/** A simulated ledger entry for a token balance, as the RPC reports it. */
function balanceEntry(contract: string, holder: string, amount: bigint): xdr.LedgerEntry {
  const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Balance'), new Address(holder).toScVal()])
  return new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 1,
    data: xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: xdr.ExtensionPoint.v0(),
        contract: new Address(contract).toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent,
        val: nativeToScVal(
          { amount, authorized: true, clawback: false },
          {
            type: {
              amount: ['symbol', 'i128'],
              authorized: ['symbol', 'bool'],
              clawback: ['symbol', 'bool'],
            },
          }
        ),
      })
    ),
    ext: xdr.LedgerEntryExt.v0(),
  })
}

function balanceKey(contract: string, holder: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Balance'), new Address(holder).toScVal()]),
      durability: xdr.ContractDataDurability.persistent,
    })
  )
}

describe('simulatedPreview from the network', () => {
  const usdcSac = USDC.contractId(Networks.TESTNET)
  const xlmSac = Asset.native().contractId(Networks.TESTNET)
  const known = [
    { code: 'USDC', contract: usdcSac },
    { code: 'XLM', contract: xlmSac },
  ]

  function sim(changes: rpc.Api.LedgerEntryChange[]): rpc.Api.SimulateTransactionSuccessResponse {
    return {
      id: '1',
      latestLedger: 1,
      events: [],
      minResourceFee: '12345',
      transactionData: undefined as unknown as never,
      result: undefined,
      stateChanges: changes,
      _parsed: true,
    } as unknown as rpc.Api.SimulateTransactionSuccessResponse
  }

  it('reads the user balance deltas out of the simulated ledger changes', () => {
    const preview = simulatedPreview(
      sim([
        {
          type: 2,
          key: balanceKey(usdcSac, USER),
          before: balanceEntry(usdcSac, USER, BigInt('5000000000')),
          after: balanceEntry(usdcSac, USER, BigInt('4800000000')),
        },
        {
          type: 2,
          key: balanceKey(xlmSac, USER),
          before: balanceEntry(xlmSac, USER, BigInt('10000000000')),
          after: balanceEntry(xlmSac, USER, BigInt('11083000000')),
        },
      ]),
      USER,
      known,
      '0.0012345'
    )
    expect(preview.basis).toBe('simulated')
    expect(preview.changes).toEqual([
      { code: 'USDC', delta: '-20', bound: 'exact' },
      { code: 'XLM', delta: '+108.3', bound: 'exact' },
    ])
    expect(preview.feeXlm).toBe('0.0012345')
  })

  it('ignores balances that belong to someone else', () => {
    const other = Keypair.random().publicKey()
    const preview = simulatedPreview(
      sim([
        {
          type: 2,
          key: balanceKey(usdcSac, other),
          before: balanceEntry(usdcSac, other, BigInt(1)),
          after: balanceEntry(usdcSac, other, BigInt(2)),
        },
      ]),
      USER,
      known,
      '0'
    )
    expect(preview.changes).toEqual([])
  })

  it('names an unknown token by its contract rather than guessing a code', () => {
    const asContract = StrKey.encodeContract(Buffer.alloc(32, 7))
    const preview = simulatedPreview(
      sim([
        {
          type: 2,
          key: balanceKey(asContract, USER),
          before: balanceEntry(asContract, USER, BigInt(0)),
          after: balanceEntry(asContract, USER, BigInt(70000000)),
        },
      ]),
      USER,
      known,
      '0'
    )
    expect(preview.changes[0]?.code).toBe(asContract)
    expect(preview.changes[0]?.delta).toBe('+7')
  })
})
