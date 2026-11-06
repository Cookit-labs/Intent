import { describe, expect, it } from 'vitest'

import { prepareChainAction } from '../chains/prepare'
import { createJupiterLendVenue } from '../chains/solana/jupiter-lend'
import { createJupiterSwapVenue } from '../chains/solana/jupiter-swap'
import { createKaminoVenue } from '../chains/solana/kamino'
import { createLuloVenue } from '../chains/solana/lulo'
import { createPriceSource } from '../chains/solana/price'
import { SOLANA_TOKENS } from '../chains/solana/tokens'
import { decodeSolanaTransaction } from '../chains/solana/assert-safe'
import type { ChainModule, ChainVenue, PreparedAction } from '../chains/types'

/**
 * Builds an unsigned transaction per venue against the live APIs and runs each
 * venue's safety check on it. Read-only: nothing here signs or sends, and Lulo runs
 * only when `LULO_API_KEY` is set. This is the check that catches an API changing a program id
 * or a response field, which a captured fixture never would.
 *
 * The account is a public exchange wallet with USDC and SOL, so a venue that checks
 * balances still builds. A keyless caller gets one Jupiter request per two seconds,
 * so these run one after another with a pause.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const FUNDED = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
const SLOW_MS = 60_000

const priceUsd = createPriceSource()

function moduleWith(venue: ChainVenue): ChainModule {
  return {
    chain: 'solana',
    tokens: SOLANA_TOKENS,
    venues: [venue],
    defaultVenue: { swap: venue.id, supply: venue.id },
    priceUsd,
    submit: async () => {
      throw new Error('This test must never send anything.')
    },
    balances: async () => ({ tokens: [], complete: true }),
  }
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2_500))

function expectUnsignedFromFunded(prepared: PreparedAction): void {
  if (prepared.signing.family !== 'solana') throw new Error('Expected a Solana payload.')
  const decoded = decodeSolanaTransaction(prepared.signing.transaction)
  expect(decoded.feePayer).toBe(FUNDED)
  expect(decoded.feePayerSignature).toBeNull()
  expect(prepared.notes.length).toBeGreaterThan(0)
}

describe.skipIf(SKIP || !process.env['LULO_API_KEY'])('lulo against its live API', () => {
  it(
    'lulo builds a USDC deposit with the configured key',
    async () => {
      const prepared = await prepareChainAction(
        moduleWith(createLuloVenue({ apiKey: process.env['LULO_API_KEY'] as string })),
        { kind: 'supply', amount: '1', tokenIn: 'USDC' },
        FUNDED
      )
      expectUnsignedFromFunded(prepared)
    },
    SLOW_MS
  )
})

describe.skipIf(SKIP)('solana venues against live APIs', () => {
  const swap = createJupiterSwapVenue({ priceUsd })

  it.each([
    ['USDC', 'SOL', '1'],
    ['SOL', 'USDC', '0.01'],
    ['USDC', 'USDT', '1'],
    ['USDC', 'JitoSOL', '1'],
    ['USDC', 'ONyc', '10'],
  ])(
    'jupiter builds %s to %s',
    async (tokenIn, tokenOut, amount) => {
      await pause()
      const prepared = await prepareChainAction(
        moduleWith(swap),
        { kind: 'swap', amount, tokenIn, tokenOut },
        FUNDED
      )
      expectUnsignedFromFunded(prepared)
      expect(prepared.context?.['requestId']).toBeTruthy()
      expect(Number(prepared.receive?.amount)).toBeGreaterThan(0)
    },
    SLOW_MS
  )

  it(
    'jupiter lend builds a USDC deposit and shows a plausible rate',
    async () => {
      await pause()
      const prepared = await prepareChainAction(
        moduleWith(createJupiterLendVenue()),
        { kind: 'supply', amount: '1', tokenIn: 'USDC' },
        FUNDED
      )
      expectUnsignedFromFunded(prepared)
      expect(prepared.apy?.basePercent).toBeGreaterThan(0)
      expect(prepared.apy?.basePercent).toBeLessThan(50)
    },
    SLOW_MS
  )

  it(
    'kamino builds a USDC deposit into the vault it names',
    async () => {
      await pause()
      const prepared = await prepareChainAction(
        moduleWith(createKaminoVenue()),
        { kind: 'supply', amount: '1', tokenIn: 'USDC' },
        FUNDED
      )
      expectUnsignedFromFunded(prepared)
      expect(prepared.summary).toMatch(/vault/)
      expect(prepared.apy?.basePercent).toBeGreaterThan(0)
      expect(prepared.apy?.basePercent).toBeLessThan(50)
    },
    SLOW_MS
  )
})
