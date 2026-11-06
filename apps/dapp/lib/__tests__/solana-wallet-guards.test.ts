import { describe, expect, it } from 'vitest'

import {
  CAPTURE_ACCOUNT,
  JUPITER_SOL_TO_USDC,
  KAMINO_USDC_DEPOSIT,
} from '../chains/solana/__fixtures__/captured-transactions'
import { solanaAssertSafe } from '../chains/solana/assert-safe'
import { JUPITER_SWAP_POLICY, KAMINO_POLICY } from '../chains/solana/programs'
import { LIGHTHOUSE_PROGRAM, withoutWalletGuards } from '../chains/solana/wallet-guards'

import { guarded as added } from './solana-wallet-guards.fixture'

const FOREIGN_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'
const solana = (transaction: string) => ({ family: 'solana' as const, transaction })
const swapSafe = solanaAssertSafe(JUPITER_SWAP_POLICY)
const kaminoSafe = solanaAssertSafe(KAMINO_POLICY)

describe('a wallet’s Lighthouse guards', () => {
  it('are what the check refused before, on a real Jupiter swap', () => {
    const guarded = added(JUPITER_SOL_TO_USDC, LIGHTHOUSE_PROGRAM, [5, 0, 1])
    expect(() => swapSafe(solana(guarded), CAPTURE_ACCOUNT)).toThrow(/Jupiter should not need/)
  })

  it('are left out of what the check sees, so the swap passes it', () => {
    const guarded = added(JUPITER_SOL_TO_USDC, LIGHTHOUSE_PROGRAM, [5, 0, 1])
    expect(() => swapSafe(solana(withoutWalletGuards(guarded)), CAPTURE_ACCOUNT)).not.toThrow()
    const deposit = added(KAMINO_USDC_DEPOSIT, LIGHTHOUSE_PROGRAM, [5])
    expect(() => kaminoSafe(solana(withoutWalletGuards(deposit)), CAPTURE_ACCOUNT)).not.toThrow()
  })

  it('do not cover any other program added beside them', () => {
    const both = added(added(JUPITER_SOL_TO_USDC, LIGHTHOUSE_PROGRAM, [5]), FOREIGN_PROGRAM, [1])
    expect(() => swapSafe(solana(withoutWalletGuards(both)), CAPTURE_ACCOUNT)).toThrow(
      /should not need/
    )
  })

  it('change nothing in a transaction that has none, or one that cannot be read', () => {
    expect(withoutWalletGuards(JUPITER_SOL_TO_USDC)).toBe(JUPITER_SOL_TO_USDC)
    expect(withoutWalletGuards('not a transaction')).toBe('not a transaction')
  })

  it('leave smuggled bytes after the message for the check to refuse', () => {
    const guarded = added(JUPITER_SOL_TO_USDC, LIGHTHOUSE_PROGRAM, [5])
    const smuggled = Buffer.concat([Buffer.from(guarded, 'base64'), Buffer.from([1, 2, 3])])
    const base64 = smuggled.toString('base64')
    expect(withoutWalletGuards(base64)).toBe(base64)
    expect(() => swapSafe(solana(withoutWalletGuards(base64)), CAPTURE_ACCOUNT)).toThrow()
  })
})
