import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { bytesFromBase64 } from '../chains/base64'
import { associatedTokenAccount, decodeSolanaTransaction } from '../chains/solana/assert-safe'
import { createKaminoLendVenue } from '../chains/solana/kamino-lend'
import {
  decodeObligation,
  decodeReserve,
  KAMINO_LEND_RESERVES,
  KAMINO_MAIN_MARKET,
  KLEND_PROGRAM,
  obligationAddress,
  reserveListing,
} from '../chains/solana/kamino-lend-rules'
import { readOnlyRpc, readU64 } from '../chains/solana/stake-pool'
import type { ChainActionRequest, PreparedAction } from '../chains/types'

/**
 * Read-only checks that the pins hold on chain, and that what this venue builds runs, by the
 * network's simulation against real positions. `simulateTransaction` here has signature checks off,
 * and nothing is ever signed or sent. The wallets are public and were found on chain just now.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const SLOW_MS = 300_000
const FUNDED = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
const NOTHING = '11111111111111111111111111111111'
const USDC = reserveListing('USDC')
const SOL = reserveListing('SOL')
const env = {
  ...process.env,
  SOLANA_RPC_URL: process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
}
const baseRpc = readOnlyRpc(env)

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The public node allows only so much, and a refused read proves nothing about what's pinned. */
const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await wait(400)
      return await baseRpc(method, params)
    } catch (e) {
      if (attempt >= 4) throw e
      await wait(6_000)
    }
  }
}

const venue = createKaminoLendVenue({ rpc })

const Simulated = z.object({
  value: z.object({
    err: z.unknown().nullable(),
    logs: z.array(z.string()).nullable(),
    unitsConsumed: z.number().optional(),
    accounts: z
      .array(z.object({ lamports: z.number(), data: z.tuple([z.string(), z.string()]) }).nullable())
      .nullable()
      .optional(),
  }),
})

async function simulate(prepared: PreparedAction, addresses: string[]) {
  if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
  expect(decodeSolanaTransaction(prepared.signing.transaction).feePayerSignature).toBeNull()
  const reply = await rpc('simulateTransaction', [
    prepared.signing.transaction,
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      accounts: { addresses, encoding: 'base64' },
    },
  ])
  const { value } = Simulated.parse(reply)
  console.info(
    prepared.kind,
    prepared.pay.amount,
    prepared.pay.symbol,
    'units',
    value.unitsConsumed,
    'bytes',
    bytesFromBase64(prepared.signing.transaction).length
  )
  if (value.err !== null) console.error(JSON.stringify(value.logs?.slice(-14), null, 1))
  expect(value.err).toBeNull()
  return value
}

const tokenAmountAfter = (account: { data: [string, string] } | null | undefined): bigint =>
  account === null || account === undefined
    ? BigInt(0)
    : readU64(bytesFromBase64(account.data[0]), 64)

const Listed = z.array(
  z.object({
    pubkey: z.string(),
    account: z.object({ data: z.tuple([z.string(), z.string()]) }),
  })
)

const Accounts = z.object({
  value: z.array(
    z.object({ data: z.tuple([z.string(), z.string()]), lamports: z.number() }).nullable()
  ),
})

interface Found {
  owner: string
  usdcInWallet: bigint
  lamports: bigint
}

/**
 * Real positions in this market, by their first deposit and first borrow slots, with what each
 * owner's wallet holds. Only the plain position Kamino's app opens, which is the one this venue reads.
 */
async function positionsWith(deposit: string, firstBorrow: string): Promise<Found[]> {
  const listed = Listed.parse(
    await rpc('getProgramAccounts', [
      KLEND_PROGRAM,
      {
        encoding: 'base64',
        dataSlice: { offset: 64, length: 32 },
        filters: [
          { dataSize: 3344 },
          { memcmp: { offset: 32, bytes: KAMINO_MAIN_MARKET } },
          { memcmp: { offset: 96, bytes: deposit } },
          { memcmp: { offset: 1208, bytes: firstBorrow } },
        ],
      },
    ])
  )
  const found: Found[] = []
  const owners = listed
    .map(({ pubkey, account }) => ({
      pubkey,
      owner: getAddress(bytesFromBase64(account.data[0])),
    }))
    .filter(({ pubkey, owner }) => obligationAddress(owner) === pubkey)
    .slice(0, 900)
  for (let i = 0; i < owners.length; i += 90) {
    const page = owners.slice(i, i + 90)
    const wallets = Accounts.parse(
      await rpc('getMultipleAccounts', [
        page.map(({ owner }) => owner),
        { encoding: 'base64', dataSlice: { offset: 0, length: 0 } },
      ])
    )
    const tokens = Accounts.parse(
      await rpc('getMultipleAccounts', [
        page.map(({ owner }) => associatedTokenAccount(owner, USDC.mint)),
        { encoding: 'base64', dataSlice: { offset: 64, length: 8 } },
      ])
    )
    page.forEach(({ owner }, at) => {
      const token = tokens.value[at]
      const wallet = wallets.value[at]
      if (wallet === null || wallet === undefined) return
      found.push({
        owner,
        lamports: BigInt(wallet.lamports),
        usdcInWallet:
          token === null || token === undefined
            ? BigInt(0)
            : readU64(bytesFromBase64(token.data[0]), 0),
      })
    })
  }
  return found
}

function getAddress(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = BigInt(0)
  for (const byte of bytes) value = value * BigInt(256) + BigInt(byte)
  let text = ''
  while (value > BigInt(0)) {
    text = alphabet[Number(value % BigInt(58))] + text
    value /= BigInt(58)
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    text = `1${text}`
  }
  return text
}

/** The first of these owners a request prepares for, trying others when a position can't. */
async function firstThatPrepares(
  owners: readonly Found[],
  request: (owner: Found) => Promise<ChainActionRequest | undefined>
): Promise<{ owner: string; prepared: PreparedAction }> {
  const reasons: string[] = []
  for (const owner of owners.slice(0, 40)) {
    const asked = await request(owner)
    if (asked === undefined) continue
    try {
      return { owner: owner.owner, prepared: await venue.prepare(asked, owner.owner) }
    } catch (e) {
      reasons.push(e instanceof Error ? e.message : String(e))
    }
  }
  throw new Error(`Nothing prepared. ${[...new Set(reasons)].slice(0, 6).join(' | ')}`)
}

describe.skipIf(SKIP)('Kamino Lend pins on chain', () => {
  it(
    'the market and every reserve are the program’s, for the token pinned',
    async () => {
      const market = Accounts.parse(
        await rpc('getMultipleAccounts', [
          [KAMINO_MAIN_MARKET, ...KAMINO_LEND_RESERVES.map((r) => r.reserve)],
          { encoding: 'base64' },
        ])
      )
      expect(market.value.every((account) => account !== null)).toBe(true)
      for (const [i, listing] of KAMINO_LEND_RESERVES.entries()) {
        const reserve = decodeReserve(bytesFromBase64(market.value[i + 1]?.data[0] as string))
        expect(reserve?.market).toBe(KAMINO_MAIN_MARKET)
        expect(reserve?.mint).toBe(listing.mint)
        expect(reserve?.decimals).toBe(listing.decimals)
        expect(reserve?.status).toBe(0)
        console.info(listing.symbol, {
          ltv: reserve?.ltvPct,
          liquidation: reserve?.liquidationPct,
          weight: reserve?.borrowFactorPct,
          borrowLimit: reserve?.borrowLimit,
        })
      }
    },
    SLOW_MS
  )
})

describe.skipIf(SKIP)('what Kamino Lend builds runs on chain', () => {
  it(
    'a first SOL deposit opens the position and lands in it',
    async () => {
      const prepared = await venue.prepare(
        { kind: 'supply', amount: '0.05', tokenIn: 'SOL' },
        FUNDED
      )
      expect(() => venue.assertSafe(prepared.signing, FUNDED)).not.toThrow()
      const obligation = obligationAddress(FUNDED)
      const result = await simulate(prepared, [obligation])
      const after = decodeObligation(bytesFromBase64(result.accounts?.[0]?.data[0] as string))
      expect(after?.owner).toBe(FUNDED)
      expect(after?.deposits[0]?.reserve).toBe(SOL.reserve)
      expect(after?.deposits[0]?.cTokens).toBeGreaterThan(BigInt(0))
    },
    SLOW_MS
  )

  it(
    'a deposit by a real USDC holder leaves their wallet for their position',
    async () => {
      const owners = await positionsWith(USDC.reserve, NOTHING)
      const { owner, prepared } = await firstThatPrepares(
        owners.filter(
          (o) => o.usdcInWallet >= BigInt(2_000_000) && o.lamports > BigInt(10_000_000)
        ),
        async () => ({ kind: 'supply', amount: '1', tokenIn: 'USDC' })
      )
      expect(() => venue.assertSafe(prepared.signing, owner)).not.toThrow()
      const own = associatedTokenAccount(owner, USDC.mint)
      const before = Accounts.parse(
        await rpc('getMultipleAccounts', [[own], { encoding: 'base64' }])
      ).value[0]
      const result = await simulate(prepared, [own])
      expect(tokenAmountAfter(before)! - tokenAmountAfter(result.accounts?.[0])).toBe(
        BigInt(1_000_000)
      )
    },
    SLOW_MS
  )

  it(
    'a real position borrows into its own wallet, and is told no past its limit',
    async () => {
      const owners = await positionsWith(SOL.reserve, USDC.reserve)
      const { owner, prepared } = await firstThatPrepares(
        owners.filter((o) => o.lamports > BigInt(10_000_000)),
        async () => ({ kind: 'borrow', amount: '1', tokenIn: 'USDC' })
      )
      expect(() => venue.assertSafe(prepared.signing, owner)).not.toThrow()
      console.info(prepared.notes.slice(0, 2))
      const own = associatedTokenAccount(owner, USDC.mint)
      const before = Accounts.parse(
        await rpc('getMultipleAccounts', [[own], { encoding: 'base64' }])
      ).value[0]
      const result = await simulate(prepared, [own])
      expect(tokenAmountAfter(result.accounts?.[0]) - tokenAmountAfter(before)).toBe(
        BigInt(1_000_000)
      )
      await expect(
        venue.prepare({ kind: 'borrow', amount: '500000000', tokenIn: 'USDC' }, owner)
      ).rejects.toThrow(/can support|ready to lend/)
    },
    SLOW_MS
  )

  it(
    'a real debt is paid down from its owner’s wallet',
    async () => {
      const owners = await positionsWith(SOL.reserve, USDC.reserve)
      const { owner, prepared } = await firstThatPrepares(
        owners.filter((o) => o.usdcInWallet >= BigInt(1_000_000) && o.lamports > BigInt(5_000_000)),
        async () => ({ kind: 'repay', amount: '0.5', tokenIn: 'USDC' })
      )
      expect(() => venue.assertSafe(prepared.signing, owner)).not.toThrow()
      const obligation = obligationAddress(owner)
      const before = await venue.positions?.(owner)
      const result = await simulate(prepared, [obligation])
      const after = decodeObligation(bytesFromBase64(result.accounts?.[0]?.data[0] as string))
      const owedBefore = Number(
        before?.find((p) => p.slot === 'borrowed' && p.symbol === 'USDC')?.amount
      )
      const afterDebt = Number((after?.borrows[0]?.borrowedSf ?? BigInt(0)) >> BigInt(60)) / 1e6
      expect(owedBefore - afterDebt).toBeGreaterThan(0.49)
      expect(owedBefore - afterDebt).toBeLessThan(0.51)
    },
    SLOW_MS
  )

  it(
    'a whole repay leaves no debt at all, interest included',
    async () => {
      const owners = await positionsWith(SOL.reserve, USDC.reserve)
      const reader = createKaminoLendVenue({ rpc })
      const { owner, prepared } = await firstThatPrepares(
        owners.filter((o) => o.usdcInWallet > BigInt(0) && o.lamports > BigInt(5_000_000)),
        async (candidate) => {
          const positions = await reader.positions?.(candidate.owner)
          const owed = positions?.find((p) => p.slot === 'borrowed' && p.symbol === 'USDC')?.amount
          const debt = BigInt(Math.ceil(Number(owed ?? '0') * 1_000_000))
          return debt > BigInt(0) && candidate.usdcInWallet > debt
            ? { kind: 'repay', amount: owed as string, tokenIn: 'USDC', wholePosition: true }
            : undefined
        }
      )
      expect(() => venue.assertSafe(prepared.signing, owner)).not.toThrow()
      const result = await simulate(prepared, [obligationAddress(owner)])
      const after = decodeObligation(bytesFromBase64(result.accounts?.[0]?.data[0] as string))
      expect(after?.borrows.filter((b) => b.reserve === USDC.reserve)).toEqual([])
    },
    SLOW_MS
  )

  it(
    'a real position with a loan takes a little out, into its own wallet',
    async () => {
      const owners = await positionsWith(SOL.reserve, USDC.reserve)
      const { owner, prepared } = await firstThatPrepares(
        owners.filter((o) => o.lamports > BigInt(5_000_000)),
        async () => ({ kind: 'withdraw', amount: '0.001', tokenIn: 'SOL' })
      )
      expect(() => venue.assertSafe(prepared.signing, owner)).not.toThrow()
      const result = await simulate(prepared, [owner])
      // Wrapped and unwrapped in one go, so it shows as SOL in the wallet.
      expect(result.accounts?.[0]?.lamports).toBeDefined()
    },
    SLOW_MS
  )

  it(
    'a whole withdraw with no loan empties and closes the position',
    async () => {
      const owners = await positionsWith(USDC.reserve, NOTHING)
      const reader = createKaminoLendVenue({ rpc })
      const { owner, prepared } = await firstThatPrepares(
        owners.filter((o) => o.lamports > BigInt(5_000_000)),
        async (candidate) => {
          const positions = await reader.positions?.(candidate.owner)
          const usdc = positions?.filter((p) => p.slot === 'supplied')
          return usdc?.length === 1 && usdc[0]?.symbol === 'USDC' && Number(usdc[0].amount) > 0
            ? {
                kind: 'withdraw',
                amount: usdc[0].amount,
                tokenIn: 'USDC',
                wholePosition: true,
              }
            : undefined
        }
      )
      expect(() => venue.assertSafe(prepared.signing, owner)).not.toThrow()
      const result = await simulate(prepared, [obligationAddress(owner)])
      // Closed: no data, no rent left in it. Simulation reports that as an empty account.
      expect(result.accounts?.[0]?.lamports ?? 0).toBe(0)
      expect(result.accounts?.[0]?.data[0] ?? '').toBe('')
    },
    SLOW_MS
  )

  it(
    'positions reads a real one the way the chain’s own figures do',
    async () => {
      const [first] = await positionsWith(SOL.reserve, USDC.reserve)
      const positions = await venue.positions?.(first?.owner as string)
      expect(positions?.some((p) => p.slot === 'supplied' && p.symbol === 'SOL')).toBe(true)
      expect(positions?.some((p) => p.slot === 'borrowed' && p.symbol === 'USDC')).toBe(true)
    },
    SLOW_MS
  )
})
