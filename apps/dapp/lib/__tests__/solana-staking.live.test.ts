import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { bytesFromBase64 } from '../chains/base64'
import { associatedTokenAccount, decodeSolanaTransaction } from '../chains/solana/assert-safe'
import { createJitoVenue, JITO_STAKE_POOL, JITOSOL_MINT } from '../chains/solana/jito'
import {
  createMarinadeVenue,
  decodeMarinadeState,
  MARINADE_PROGRAM,
  MARINADE_STATE,
  MSOL_MINT,
} from '../chains/solana/marinade'
import {
  createSolayerVenue,
  SOLAYER_LP_MINT,
  SOLAYER_RESTAKING_POOL,
  SOLAYER_RESTAKING_PROGRAM,
  SOLAYER_STAKE_POOL,
  SSOL_MINT,
} from '../chains/solana/solayer'
import {
  decodeStakePool,
  decodeValidatorList,
  readAccount,
  readAddress,
  readOnlyRpc,
  readU64,
  STAKE_POOL_PROGRAM,
} from '../chains/solana/stake-pool'
import type { ChainVenue, PreparedAction } from '../chains/types'

/**
 * Read-only checks that the pinned ids still hold on chain, and that what the venues build runs,
 * by the network's simulation. `simulateTransaction` here has signature checks off, and nothing is
 * ever signed or sent. The wallets are public: a funded one, and a large holder of each token.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const SLOW_MS = 180_000
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const FUNDED = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
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
      await wait(5_000)
    }
  }
}

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

async function simulate(
  prepared: PreparedAction,
  addresses: string[] = []
): Promise<z.infer<typeof Simulated>['value']> {
  if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
  expect(decodeSolanaTransaction(prepared.signing.transaction).feePayerSignature).toBeNull()
  const reply = await rpc('simulateTransaction', [
    prepared.signing.transaction,
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      ...(addresses.length === 0 ? {} : { accounts: { addresses, encoding: 'base64' } }),
    },
  ])
  return Simulated.parse(reply).value
}

function expectRan(result: z.infer<typeof Simulated>['value']): void {
  if (result.err !== null) console.error(JSON.stringify(result.logs?.slice(-14), null, 1))
  expect(result.err).toBeNull()
}

/** A token account's amount as it stands now, zero if it doesn't exist yet. */
async function tokenAmount(address: string): Promise<bigint> {
  const reply = TokenBalance.safeParse(
    await rpc('getTokenAccountBalance', [address]).catch(() => undefined)
  )
  return reply.success ? BigInt(reply.data.value.amount) : BigInt(0)
}

const baseUnits = (text: string | undefined): bigint =>
  BigInt(Math.round(Number(text) * 1_000_000_000))

const Signatures = z.array(z.object({ signature: z.string(), err: z.unknown().nullable() }))
const TransactionBalances = z.object({
  meta: z.object({
    postTokenBalances: z.array(
      z.object({
        mint: z.string(),
        owner: z.string().optional(),
        uiTokenAmount: z.object({ amount: z.string() }),
      })
    ),
  }),
})
const Wallet = z.object({ value: z.object({ owner: z.string(), lamports: z.number() }) })
const TokenBalance = z.object({ value: z.object({ amount: z.string() }) })

/**
 * A plain wallet holding at least this much of a token in its own associated account, with SOL for
 * the fee, found among whoever last traded it. The public node refuses the largest-holders call.
 */
async function holderOf(mint: string, atLeast: bigint): Promise<string> {
  const signatures = Signatures.parse(await rpc('getSignaturesForAddress', [mint, { limit: 120 }]))
  for (const { signature, err } of signatures) {
    if (err !== null) continue
    const transaction = TransactionBalances.safeParse(
      await rpc('getTransaction', [
        signature,
        { encoding: 'json', maxSupportedTransactionVersion: 1 },
      ])
    )
    if (!transaction.success) continue
    for (const { mint: held, owner, uiTokenAmount } of transaction.data.meta.postTokenBalances) {
      if (held !== mint || owner === undefined || BigInt(uiTokenAmount.amount) < atLeast) continue
      const wallet = Wallet.safeParse(await rpc('getAccountInfo', [owner, { encoding: 'base64' }]))
      if (
        !wallet.success ||
        wallet.data.value.owner !== '11111111111111111111111111111111' ||
        wallet.data.value.lamports < 50_000_000
      ) {
        continue
      }
      const balance = TokenBalance.safeParse(
        await rpc('getTokenAccountBalance', [associatedTokenAccount(owner, mint)]).catch(
          () => undefined
        )
      )
      if (balance.success && BigInt(balance.data.value.amount) >= atLeast) return owner
    }
  }
  throw new Error(`No usable holder of ${mint} among its recent traders.`)
}

describe.skipIf(SKIP)('staking pins on chain', () => {
  it(
    'marinade: the program, state, mint and pool legs are what the code pins',
    async () => {
      const state = await readAccount(rpc, MARINADE_STATE)
      expect(state.owner).toBe(MARINADE_PROGRAM)
      const decoded = decodeMarinadeState(state.data)
      expect(decoded?.msolMint).toBe(MSOL_MINT)
      expect(decoded?.msolSupply).toBeGreaterThan(BigInt(0))
      expect((await readAccount(rpc, MSOL_MINT)).owner).toBe(TOKEN_PROGRAM)
    },
    SLOW_MS
  )

  it(
    'jito: the pool is the stake pool program’s and holds this mint',
    async () => {
      const pool = await readAccount(rpc, JITO_STAKE_POOL)
      expect(pool.owner).toBe(STAKE_POOL_PROGRAM)
      const decoded = decodeStakePool(pool.data)
      expect(decoded?.poolMint).toBe(JITOSOL_MINT)
      expect(decoded?.tokenProgram).toBe(TOKEN_PROGRAM)
      expect(decoded?.solDepositAuthority).toBeUndefined()
      expect(decoded?.solWithdrawAuthority).toBeUndefined()
    },
    SLOW_MS
  )

  it(
    'solayer: the restaking pool holds these mints, and the stake pool mints the LP',
    async () => {
      const restaking = await readAccount(rpc, SOLAYER_RESTAKING_POOL)
      expect(restaking.owner).toBe(SOLAYER_RESTAKING_PROGRAM)
      expect(readAddress(restaking.data, 8)).toBe(SOLAYER_LP_MINT)
      expect(readAddress(restaking.data, 40)).toBe(SSOL_MINT)
      const pool = await readAccount(rpc, SOLAYER_STAKE_POOL)
      expect(pool.owner).toBe(STAKE_POOL_PROGRAM)
      const decoded = decodeStakePool(pool.data)
      expect(decoded?.poolMint).toBe(SOLAYER_LP_MINT)
      expect(decoded?.solDepositAuthority).toBeUndefined()
      const list = await readAccount(rpc, decoded?.validatorList as string)
      expect(decodeValidatorList(list.data)?.length).toBeGreaterThan(0)
    },
    SLOW_MS
  )
})

describe.skipIf(SKIP)('what the staking venues build runs on chain', () => {
  const cases: [string, ChainVenue, string, string][] = [
    ['marinade', createMarinadeVenue({ rpc }), 'mSOL', '0.1'],
    ['jito', createJitoVenue({ rpc }), 'JitoSOL', '0.1'],
    // Under Solana's minimum for a stake account, this venue refuses, so this asks for more.
    ['solayer', createSolayerVenue({ rpc }), 'sSOL', '1'],
  ]
  const mints: Record<string, string> = { mSOL: MSOL_MINT, JitoSOL: JITOSOL_MINT, sSOL: SSOL_MINT }

  it.each(cases)(
    '%s stakes SOL',
    async (_id, venue, symbol) => {
      const prepared = await venue.prepare(
        { kind: 'stake', amount: '0.05', tokenIn: 'SOL' },
        FUNDED
      )
      expect(() => venue.assertSafe(prepared.signing, FUNDED)).not.toThrow()
      expect(prepared.receive?.symbol).toBe(symbol)
      const own = associatedTokenAccount(FUNDED, mints[symbol] as string)
      const before = await tokenAmount(own)
      const result = await simulate(prepared, [own])
      console.info(_id, 'stake units', result.unitsConsumed, prepared.receive?.amount)
      expectRan(result)
      // What the card said is what lands in the person's own account, to well inside 0.1%.
      const after = readU64(bytesFromBase64(result.accounts?.[0]?.data[0] as string), 64)
      const expected = baseUnits(prepared.receive?.amount)
      const gained = after - before
      const gap = gained > expected ? gained - expected : expected - gained
      expect(gap).toBeLessThan(expected / BigInt(1000))
    },
    SLOW_MS
  )

  it.each(cases)(
    '%s unstakes back to the person',
    async (_id, venue, symbol, amount) => {
      const atLeast = BigInt(Math.round(Number(amount) * 1_000_000_000))
      const holder = await holderOf(mints[symbol] as string, atLeast)
      const prepared = await venue.prepare({ kind: 'unstake', amount, tokenIn: symbol }, holder)
      expect(() => venue.assertSafe(prepared.signing, holder)).not.toThrow()
      const stakeAccount = /[1-9A-HJ-NP-Za-km-z]{32,44}/.exec(prepared.notes[0] ?? '')?.[0]
      const result = await simulate(prepared, [stakeAccount ?? holder])
      console.info(
        _id,
        'unstake units',
        result.unitsConsumed,
        prepared.receive?.amount,
        prepared.notes[0]
      )
      expectRan(result)
      const seen = result.accounts?.[0]
      const expected = baseUnits(prepared.receive?.amount)
      if (stakeAccount === undefined) {
        // SOL comes straight back to the wallet, less a network fee this bound more than covers.
        const wallet = Wallet.parse(await rpc('getAccountInfo', [holder, { encoding: 'base64' }]))
        const gained = BigInt(seen?.lamports as number) - BigInt(wallet.value.lamports)
        expect(gained).toBeGreaterThan(expected - BigInt(200_000))
        expect(gained).toBeLessThanOrEqual(expected + BigInt(1_000))
      } else {
        // A stake account the person alone controls, holding what the card said, already cooling.
        const data = bytesFromBase64(seen?.data[0] as string)
        expect(readAddress(data, 12)).toBe(holder)
        expect(readAddress(data, 44)).toBe(holder)
        const delegated = readU64(data, 156)
        expect(delegated).toBeGreaterThan(expected - expected / BigInt(1000))
        expect(readU64(data, 172)).not.toBe(BigInt('18446744073709551615'))
      }
    },
    SLOW_MS
  )
})
