import { activeNetwork, stellarNetwork } from '@intent/config'
import {
  Account,
  Address,
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { readFlow, summariseFlow } from '../server/execution-flow'
import { knownAssetsFor } from '../swap/asset-registry'
import { soroswapRouter } from '../swap/contract-registry'
import type { MarketPrice } from '../swap/price-types'

const PASSPHRASE = stellarNetwork.networkPassphrase
const SOURCE = Keypair.random()

function envelope(...ops: xdr.Operation[]): string {
  const builder = new TransactionBuilder(new Account(SOURCE.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
  for (const op of ops) builder.addOperation(op)
  return builder.setTimeout(0).build().toXDR()
}

const verifiedUsdc = (): Asset => {
  const usdc = knownAssetsFor(activeNetwork())['USDC']
  if (usdc?.issuer === undefined) throw new Error('the registry has no USDC for this network')
  return new Asset('USDC', usdc.issuer)
}

const prices: Record<string, MarketPrice> = {
  XLM: { symbol: 'XLM', usd: 0.2, source: 'stellar-mainnet', asOf: '2026-10-09T00:00:00Z' },
  USDC: { symbol: 'USDC', usd: 1, source: 'stellar-mainnet', asOf: '2026-10-09T00:00:00Z' },
}

describe('reading what a signed transaction moves', () => {
  it('reads the amount a path payment sells and what it buys', () => {
    const tx = envelope(
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: '10',
        destination: SOURCE.publicKey(),
        destAsset: verifiedUsdc(),
        destMin: '1',
        path: [],
      })
    )
    const legs = readFlow(tx)
    expect(legs).toEqual([{ asset: 'XLM', amount: '10.0000000', verified: true, into: 'USDC' }])
    expect(summariseFlow(legs, prices)).toEqual({
      assetIn: 'XLM',
      amountIn: '10.0000000',
      assetOut: 'USDC',
      volumeUsd: 2,
    })
  })

  it('counts a strict-receive payment by what is delivered, not by its ceiling', () => {
    const tx = envelope(
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: '500',
        destination: SOURCE.publicKey(),
        destAsset: verifiedUsdc(),
        destAmount: '3',
        path: [],
      })
    )
    const [leg] = readFlow(tx)
    expect(leg).toMatchObject({ asset: 'USDC', amount: '3.0000000', into: 'XLM' })
    expect(summariseFlow([leg as NonNullable<typeof leg>], prices)?.volumeUsd).toBe(3)
  })

  it('reads an offer by what it sells', () => {
    const tx = envelope(
      Operation.manageSellOffer({
        selling: Asset.native(),
        buying: verifiedUsdc(),
        amount: '100',
        price: '0.2',
      })
    )
    expect(summariseFlow(readFlow(tx), prices)).toMatchObject({
      assetIn: 'XLM',
      assetOut: 'USDC',
      volumeUsd: 20,
    })
  })

  it('reads a payment', () => {
    const tx = envelope(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '5',
      })
    )
    expect(summariseFlow(readFlow(tx), prices)).toMatchObject({ assetIn: 'XLM', volumeUsd: 1 })
  })

  it('adds up every leg of a plan', () => {
    const tx = envelope(
      Operation.manageSellOffer({
        selling: Asset.native(),
        buying: verifiedUsdc(),
        amount: '10',
        price: '0.2',
      }),
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '5',
      })
    )
    expect(summariseFlow(readFlow(tx), prices)?.volumeUsd).toBe(3)
  })

  it('never prices an asset the registry does not vouch for', () => {
    const lookalike = new Asset('USDC', Keypair.random().publicKey())
    const tx = envelope(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: lookalike,
        amount: '1000',
      })
    )
    const legs = readFlow(tx)
    expect(legs[0]).toMatchObject({ verified: false })
    expect(legs[0]?.asset.startsWith('USDC:G')).toBe(true)
    expect(summariseFlow(legs, prices)?.volumeUsd).toBeNull()
  })

  it('leaves the dollars empty when there is no price', () => {
    const tx = envelope(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '5',
      })
    )
    expect(summariseFlow(readFlow(tx), {})?.volumeUsd).toBeNull()
  })

  it('reads through a fee bump to the transaction inside', () => {
    const inner = new TransactionBuilder(new Account(SOURCE.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: '5',
        })
      )
      .setTimeout(0)
      .build()
    const bumped = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      '200',
      inner,
      PASSPHRASE
    )
    expect(readFlow(bumped.toXDR())).toHaveLength(1)
  })

  it.skipIf(soroswapRouter() === undefined)(
    'reads the amount and the path of a Soroswap router swap',
    () => {
      const router = soroswapRouter()
      if (router === undefined) throw new Error('no router')
      const sac = (a: Asset): xdr.ScVal => new Address(a.contractId(PASSPHRASE)).toScVal()
      const tx = envelope(
        Operation.invokeContractFunction({
          contract: router,
          function: 'swap_exact_tokens_for_tokens',
          args: [
            nativeToScVal(BigInt('200000000'), { type: 'i128' }),
            nativeToScVal(BigInt('1'), { type: 'i128' }),
            xdr.ScVal.scvVec([sac(Asset.native()), sac(verifiedUsdc())]),
            new Address(SOURCE.publicKey()).toScVal(),
            nativeToScVal(BigInt('9999999999'), { type: 'u64' }),
          ],
        })
      )
      expect(summariseFlow(readFlow(tx), prices)).toEqual({
        assetIn: 'XLM',
        amountIn: '20.0000000',
        assetOut: 'USDC',
        volumeUsd: 4,
      })
    }
  )

  it('does not read a call to any other contract as a swap', () => {
    const tx = envelope(
      Operation.invokeContractFunction({
        contract: Asset.native().contractId(PASSPHRASE),
        function: 'swap_exact_tokens_for_tokens',
        args: [nativeToScVal(BigInt('1'), { type: 'i128' })],
      })
    )
    expect(readFlow(tx)).toEqual([])
  })

  it('reads nothing from bytes that are not a transaction', () => {
    expect(readFlow('not xdr')).toEqual([])
    expect(summariseFlow([], prices)).toBeUndefined()
  })

  it('ignores operations that move nothing out of the account', () => {
    const tx = envelope(Operation.changeTrust({ asset: verifiedUsdc() }))
    expect(readFlow(tx)).toEqual([])
  })
})
