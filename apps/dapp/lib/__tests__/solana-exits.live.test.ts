import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'

import {
  KAMINO_HOLDER,
  LULO_HOLDER,
  RESERVE_HOLDER,
} from '../chains/solana/__fixtures__/captured-exits'
import { associatedTokenAccount, decodeSolanaTransaction } from '../chains/solana/assert-safe'
import { createJupiterLendVenue } from '../chains/solana/jupiter-lend'
import { createKaminoVenue } from '../chains/solana/kamino'
import { createLuloVenue } from '../chains/solana/lulo'
import { JUPITER_LEND_PROGRAM } from '../chains/solana/programs'
import type { ChainVenue } from '../chains/types'

/**
 * Builds each exit for a real wallet holding the position, runs the venue's check on it, and
 * simulates it on mainnet to see what would land. Read-only: nothing here signs or sends, and the
 * holders are public wallets found on chain. A holder who has since left skips with a warning.
 *
 * Lulo's docs require a key, but on 5 November 2026 its API answered without one, so this runs with
 * `LULO_API_KEY` if set and with an empty key if not. It fails if Lulo starts enforcing that.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const SLOW_MS = 90_000
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const JUPITER_HOLDER = 'HFqp6ErWHY6Uzhj8rFyjYuDya2mXUpYEk8VW75K9PSiY'

const RPCS = [
  process.env['SOLANA_RPC_URL']?.trim() || 'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
]

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  let last = ''
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const url = RPCS[attempt % RPCS.length] as string
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = (await response.json()) as { result?: unknown; error?: unknown }
      if (body.error === undefined && body.result !== undefined) return body.result
      last = JSON.stringify(body.error)
    } catch (e) {
      last = String(e)
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`${method} failed: ${last}`)
}

const amountIn = (base64: string | undefined): bigint =>
  base64 === undefined ? BigInt(0) : Buffer.from(base64, 'base64').readBigUInt64LE(64)

/** What a transaction would pay into the wallet's USDC account, simulated on mainnet. */
async function simulatedPayout(transaction: string, holder: string): Promise<bigint> {
  const recipient = associatedTokenAccount(holder, USDC)
  const before = (await rpc('getMultipleAccounts', [
    [recipient],
    { encoding: 'base64', commitment: 'confirmed' },
  ])) as { value: ({ data: [string, string] } | null)[] }
  const simulated = (await rpc('simulateTransaction', [
    transaction,
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses: [recipient] },
    },
  ])) as {
    value: {
      err: unknown
      logs?: string[]
      accounts?: ({ data: [string, string] } | null)[]
    }
  }
  expect(simulated.value.err, (simulated.value.logs ?? []).slice(-6).join('\n')).toBeNull()
  return amountIn(simulated.value.accounts?.[0]?.data[0]) - amountIn(before.value[0]?.data[0])
}

async function held(venue: ChainVenue, holder: string): Promise<string | undefined> {
  const [position] = (await venue.positions?.(holder)) ?? []
  if (position === undefined) console.warn(`${holder} no longer holds this position; skipping.`)
  return position?.amount
}

const toUnits = (display: string): number => Math.round(Number(display) * 1_000_000)

describe.skipIf(SKIP)('jupiter lend exit on mainnet', () => {
  const venue = createJupiterLendVenue()

  it(
    'reads the position at the rate Jupiter reports',
    async () => {
      const amount = await held(venue, JUPITER_HOLDER)
      if (amount === undefined) return
      const response = await fetch(
        `https://api.jup.ag/lend/v1/earn/positions?users=${JUPITER_HOLDER}`
      )
      const list = (await response.json()) as {
        token?: { assetAddress?: string }
        underlyingAssets?: string
      }[]
      const theirs = list.find((p) => p.token?.assetAddress === USDC)?.underlyingAssets
      expect(Number(theirs)).toBeGreaterThan(0)
      expect(toUnits(amount) / Number(theirs)).toBeCloseTo(1, 3)
    },
    SLOW_MS
  )

  it(
    'builds a withdrawal with exactly the accounts Jupiter’s own API uses, from the chain alone',
    async () => {
      const amount = await held(venue, JUPITER_HOLDER)
      if (amount === undefined) return
      const prepared = await venue.prepare(
        { kind: 'withdraw', amount: '0.5', tokenIn: 'USDC' },
        JUPITER_HOLDER
      )
      venue.assertSafe(prepared.signing, JUPITER_HOLDER)
      if (prepared.signing.family !== 'solana') throw new Error('Expected a Solana payload.')

      const response = await fetch('https://api.jup.ag/lend/v1/earn/withdraw', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ asset: USDC, signer: JUPITER_HOLDER, amount: '500000' }),
      })
      const { transaction } = (await response.json()) as { transaction: string }
      const accountsOf = (base64: string): readonly string[] => {
        const decoded = decodeSolanaTransaction(base64)
        const instruction = decoded.instructions.find(
          (i) => decoded.staticAccounts[i.programIndex] === JUPITER_LEND_PROGRAM
        )
        return (instruction?.accounts ?? []).map((i) => decoded.staticAccounts[i] as string)
      }
      expect(accountsOf(prepared.signing.transaction)).toEqual(accountsOf(transaction))
      const message = getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(Buffer.from(prepared.signing.transaction, 'base64'))
          .messageBytes
      )
      expect(message.version).toBe('legacy')

      expect(await simulatedPayout(prepared.signing.transaction, JUPITER_HOLDER)).toBe(
        BigInt(500_000)
      )
    },
    SLOW_MS
  )

  it(
    'empties the whole position in simulation',
    async () => {
      const amount = await held(venue, JUPITER_HOLDER)
      if (amount === undefined) return
      const prepared = await venue.prepare(
        { kind: 'withdraw', amount, tokenIn: 'USDC', wholePosition: true },
        JUPITER_HOLDER
      )
      venue.assertSafe(prepared.signing, JUPITER_HOLDER)
      if (prepared.signing.family !== 'solana') throw new Error('Expected a Solana payload.')
      const paid = await simulatedPayout(prepared.signing.transaction, JUPITER_HOLDER)
      expect(Number(paid) / toUnits(amount)).toBeCloseTo(1, 3)
    },
    SLOW_MS
  )
})

describe.skipIf(SKIP)('kamino exit on mainnet', () => {
  const venue = createKaminoVenue()

  it.each([
    ['a vault with cash free', KAMINO_HOLDER],
    ['a vault drawing on its lending markets', RESERVE_HOLDER],
  ])(
    'builds part of a position from %s, and pays what the card says',
    async (_, holder) => {
      const amount = await held(venue, holder)
      if (amount === undefined) return
      const prepared = await venue.prepare(
        { kind: 'withdraw', amount: '2', tokenIn: 'USDC' },
        holder
      )
      venue.assertSafe(prepared.signing, holder)
      if (prepared.signing.family !== 'solana') throw new Error('Expected a Solana payload.')
      const paid = await simulatedPayout(prepared.signing.transaction, holder)
      expect(paid).toBeGreaterThanOrEqual(BigInt(2_000_000))
      expect(paid).toBeLessThan(BigInt(2_001_000))
    },
    SLOW_MS
  )

  it.each([
    ['a vault with cash free', KAMINO_HOLDER],
    ['a vault drawing on its lending markets', RESERVE_HOLDER],
  ])(
    'empties the whole position from %s in simulation',
    async (_, holder) => {
      const amount = await held(venue, holder)
      if (amount === undefined) return
      const prepared = await venue.prepare(
        { kind: 'withdraw', amount, tokenIn: 'USDC', wholePosition: true },
        holder
      )
      venue.assertSafe(prepared.signing, holder)
      if (prepared.signing.family !== 'solana') throw new Error('Expected a Solana payload.')
      const paid = await simulatedPayout(prepared.signing.transaction, holder)
      expect(Number(paid) / toUnits(amount)).toBeCloseTo(1, 3)
    },
    SLOW_MS
  )
})

describe.skipIf(SKIP)('lulo exit on mainnet', () => {
  const venue = createLuloVenue({ apiKey: process.env['LULO_API_KEY'] ?? '' })

  it(
    'builds part and all of a position, and each pays the holder in simulation',
    async () => {
      const amount = await held(venue, LULO_HOLDER)
      if (amount === undefined) return
      const part = await venue.prepare(
        { kind: 'withdraw', amount: '1', tokenIn: 'USDC' },
        LULO_HOLDER
      )
      venue.assertSafe(part.signing, LULO_HOLDER)
      if (part.signing.family !== 'solana') throw new Error('Expected a Solana payload.')
      expect(await simulatedPayout(part.signing.transaction, LULO_HOLDER)).toBe(BigInt(1_000_000))

      const whole = await venue.prepare(
        { kind: 'withdraw', amount, tokenIn: 'USDC', wholePosition: true },
        LULO_HOLDER
      )
      venue.assertSafe(whole.signing, LULO_HOLDER)
      if (whole.signing.family !== 'solana') throw new Error('Expected a Solana payload.')
      const paid = await simulatedPayout(whole.signing.transaction, LULO_HOLDER)
      expect(Number(paid) / toUnits(amount)).toBeCloseTo(1, 3)
    },
    SLOW_MS
  )
})
