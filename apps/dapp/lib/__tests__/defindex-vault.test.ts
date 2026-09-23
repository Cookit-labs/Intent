import { Address, xdr, type rpc } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { readVaultAssets } from '../lend/defindex/vault'

/**
 * Reading what a vault holds, from the chain rather than from the API.
 *
 * The API also reports a vault's assets, and the market context trusts it
 * for the menu. The build path does not: before anything is signed, the
 * vault's own `get_assets` is simulated and its asset compared to the one
 * the swap delivers. Measured on 2026-09-23 why this matters: DeFindex's
 * testnet USDC vault holds `CAQCFV…`, a different USDC from the Circle-issued
 * one this app trades (`CBIELT…`), and a deposit of the wrong one would be
 * refused by the contract after the swap had settled.
 */

const VAULT = 'CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6'
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const STRATEGY = 'CDVLOSPJPQOTB6ZCWO5VSGTOLGMKTXSFWYTUP572GTPNOWX4F76X3HPM'

function entry(key: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
}

/** `get_assets` as the live vault returned it: a Vec of AssetStrategySet. */
function assetsRetval(): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      entry('address', new Address(XLM_SAC).toScVal()),
      entry(
        'strategies',
        xdr.ScVal.scvVec([
          xdr.ScVal.scvMap([
            entry('address', new Address(STRATEGY).toScVal()),
            entry('name', xdr.ScVal.scvString('XLM Blend Strategy')),
            entry('paused', xdr.ScVal.scvBool(false)),
          ]),
        ])
      ),
    ]),
  ])
}

function serverReturning(
  retval: xdr.ScVal,
  onCall?: (fn: string, contract: string) => void
): Pick<rpc.Server, 'simulateTransaction'> {
  return {
    simulateTransaction: (tx) => {
      const op = (tx as unknown as { operations: { func: { invokeContract: unknown } }[] })
        .operations[0]
      const call = op?.func.invokeContract as {
        functionName: unknown
        contractAddress: xdr.ScAddress
      }
      onCall?.(String(call.functionName), Address.fromScAddress(call.contractAddress).toString())
      return Promise.resolve({
        result: { retval, auth: [] },
        latestLedger: 1,
        events: [],
        minResourceFee: '0',
        transactionData: undefined,
      } as unknown as rpc.Api.SimulateTransactionSuccessResponse)
    },
  }
}

describe('reading a vault’s assets', () => {
  it('simulates get_assets on the vault named', async () => {
    const calls: string[] = []
    await readVaultAssets(VAULT, {
      serverImpl: serverReturning(assetsRetval(), (fn, contract) =>
        calls.push(`${fn}@${contract}`)
      ),
    })
    expect(calls).toEqual([`get_assets@${VAULT}`])
  })

  it('returns each asset with its strategies', async () => {
    const assets = await readVaultAssets(VAULT, { serverImpl: serverReturning(assetsRetval()) })

    expect(assets).toEqual([
      {
        address: XLM_SAC,
        strategies: [{ address: STRATEGY, name: 'XLM Blend Strategy', paused: false }],
      },
    ])
  })

  it('throws when the vault answers with something else', async () => {
    await expect(
      readVaultAssets(VAULT, { serverImpl: serverReturning(xdr.ScVal.scvU32(7)) })
    ).rejects.toThrow(/unreadable/)
  })

  it('surfaces a simulation error, which is what a deleted contract looks like', async () => {
    const failing: Pick<rpc.Server, 'simulateTransaction'> = {
      simulateTransaction: () =>
        Promise.resolve({
          error: 'HostError: Error(Storage, MissingValue)',
          latestLedger: 1,
          events: [],
        } as unknown as rpc.Api.SimulateTransactionErrorResponse),
    }
    await expect(readVaultAssets(VAULT, { serverImpl: failing })).rejects.toThrow(/MissingValue/)
  })
})
