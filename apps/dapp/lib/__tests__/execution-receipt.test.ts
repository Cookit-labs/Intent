import { describe, expect, it } from 'vitest'

import { loggedAction, withReceipt } from '../chains/receipt'
import type { ChainModule, PreparedAction } from '../chains/types'

const env = { AUTH_SECRET: 'x'.repeat(40) }
const ACCOUNT = '11111111111111111111111111111111'

const solana = {
  chain: 'solana',
  tokens: [
    { symbol: 'SOL', id: 'So11111111111111111111111111111111111111112', decimals: 9 },
    { symbol: 'USDC', id: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  ],
  priceUsd: async (token: { symbol: string }) => (token.symbol === 'SOL' ? 150 : 1),
} as unknown as ChainModule

const swap: PreparedAction = {
  venueId: 'jupiter',
  venueName: 'Jupiter',
  kind: 'swap',
  summary: 'Swap 0.5 SOL for USDC.',
  pay: { amount: '0.5', symbol: 'SOL' },
  receive: { amount: '75', symbol: 'USDC', approximate: true },
  notes: [],
  signing: { family: 'solana', transaction: 'AAAA' },
}

describe('the receipt a prepared action carries to submit', () => {
  it('records what the action sold, at its dollar value when it was built', async () => {
    const prepared = await withReceipt(solana, ACCOUNT, swap, env)
    expect(loggedAction('solana', ACCOUNT, 'jupiter', prepared.receipt, env)).toEqual({
      kind: 'swap',
      action: 'swap',
      flow: { assetIn: 'SOL', amountIn: '0.5', assetOut: 'USDC', volumeUsd: 75 },
    })
  })

  it('counts each action as the same type on every chain', async () => {
    const kinds: [PreparedAction['kind'], string][] = [
      ['send', 'send'],
      ['limit', 'offer'],
      ['supply', 'lend'],
      ['withdraw', 'withdraw'],
    ]
    for (const [kind, logged] of kinds) {
      const prepared = await withReceipt(solana, ACCOUNT, { ...swap, kind }, env)
      expect(loggedAction('solana', ACCOUNT, 'jupiter', prepared.receipt, env).kind).toBe(logged)
    }
  })

  it('counts a setup step before an order as setup, so the order is not counted twice', async () => {
    const prepared = await withReceipt(
      solana,
      ACCOUNT,
      { ...swap, kind: 'limit', thenPrepareAgain: true },
      env
    )
    expect(loggedAction('solana', ACCOUNT, 'jupiter', prepared.receipt, env).kind).toBe('setup')
  })

  it('believes no receipt that was changed, or issued for another wallet, venue or chain', async () => {
    const { receipt } = await withReceipt(solana, ACCOUNT, swap, env)
    const [body, proof] = (receipt ?? '').split('.')
    const inflated = Buffer.from(
      JSON.stringify({
        kind: 'swap',
        assetIn: 'SOL',
        amountIn: '500',
        assetOut: 'USDC',
        volumeUsd: 75000,
      })
    ).toString('base64url')
    const unknown = { kind: 'unknown' }
    expect(loggedAction('solana', ACCOUNT, 'jupiter', `${inflated}.${proof}`, env)).toEqual(unknown)
    expect(loggedAction('solana', `${ACCOUNT}2`, 'jupiter', receipt, env)).toEqual(unknown)
    expect(loggedAction('solana', ACCOUNT, 'raydium', receipt, env)).toEqual(unknown)
    expect(loggedAction('sui', ACCOUNT, 'jupiter', receipt, env)).toEqual(unknown)
    expect(loggedAction('solana', ACCOUNT, 'jupiter', `${body}.${proof}.x`, env)).toEqual(unknown)
    expect(loggedAction('solana', ACCOUNT, 'jupiter', undefined, env)).toEqual(unknown)
    expect(
      loggedAction('solana', ACCOUNT, 'jupiter', receipt, { AUTH_SECRET: 'y'.repeat(40) })
    ).toEqual(unknown)
  })

  it('leaves the value out, never guessed, when the token has no price', async () => {
    const unpriced = { ...solana, priceUsd: async () => undefined } as unknown as ChainModule
    const prepared = await withReceipt(unpriced, ACCOUNT, swap, env)
    expect(loggedAction('solana', ACCOUNT, 'jupiter', prepared.receipt, env).flow?.volumeUsd).toBe(
      null
    )
    const failing = {
      ...solana,
      priceUsd: async () => {
        throw new Error('price feed down')
      },
    } as unknown as ChainModule
    const stillBuilt = await withReceipt(failing, ACCOUNT, swap, env)
    expect(stillBuilt.receipt).toBeDefined()
  })

  it('adds nothing where the deployment has no key to sign with', async () => {
    const prepared = await withReceipt(solana, ACCOUNT, swap, {})
    expect(prepared).toEqual(swap)
    expect(loggedAction('solana', ACCOUNT, 'jupiter', 'a.b', {})).toEqual({ kind: 'unknown' })
  })
})
