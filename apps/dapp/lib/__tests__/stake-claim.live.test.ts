import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { bytesFromBase64 } from '../chains/base64'
import { associatedTokenAccount, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../chains/solana/assert-safe'
import { createSolayerVenue, SOLAYER_STAKE_POOL, SSOL_MINT } from '../chains/solana/solayer'
import { createJitoVenue } from '../chains/solana/jito'
import { createMarinadeVenue } from '../chains/solana/marinade'
import {
  compileForSigning,
  computeBudget,
  readAccount,
  readAccounts,
  readAddress,
  readU64,
  readOnlyRpc,
  stakeExitAddress,
  STAKE_HISTORY_SYSVAR,
  STAKE_POOL_PROGRAM,
  STAKE_PROGRAM,
  type SolanaRpc,
} from '../chains/solana/stake-pool'
import {
  decodeStakeAccount,
  decodeStakeHistory,
  stakeStillCooling,
  withdrawStakeAccount,
} from '../chains/solana/stake-claim'

/**
 * Read-only. Runs the claim's Withdraw against real stake accounts that real Solayer exits left on
 * mainnet, with signature checks off. Nothing is signed or sent. The owners are whoever last left
 * the pool, so which accounts turn up changes with each run.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const SLOW_MS = 300_000
const FUNDED = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'

const baseRpc = readOnlyRpc({
  ...process.env,
  SOLANA_RPC_URL: process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
})
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const rpc: SolanaRpc = async (method, params) => {
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

const Signatures = z.array(z.object({ signature: z.string(), err: z.unknown().nullable() }))
const Transaction = z.object({
  transaction: z.object({
    message: z.object({
      accountKeys: z.array(z.object({ pubkey: z.string() })),
      instructions: z.array(
        z.object({
          programId: z.string(),
          accounts: z.array(z.string()).optional(),
          data: z.string().optional(),
        })
      ),
    }),
  }),
})
const Epoch = z.object({ epoch: z.number() })
const Simulated = z.object({
  value: z.object({
    err: z.unknown().nullable(),
    unitsConsumed: z.number().optional(),
    accounts: z
      .array(z.object({ lamports: z.number() }).nullable())
      .nullable()
      .optional(),
  }),
})

/** Stake accounts that recent withdrawals from Solayer's pool sent somewhere. */
async function stakeAccountsLeftByExits(limit: number): Promise<string[]> {
  const signatures = Signatures.parse(
    await rpc('getSignaturesForAddress', [SOLAYER_STAKE_POOL, { limit }])
  )
  const found = new Set<string>()
  for (const { signature, err } of signatures) {
    if (err !== null) continue
    const transaction = Transaction.safeParse(
      await rpc('getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 },
      ])
    )
    if (!transaction.success) continue
    for (const instruction of transaction.data.transaction.message.instructions) {
      if (instruction.programId !== STAKE_POOL_PROGRAM || instruction.accounts === undefined) {
        continue
      }
      const stake = instruction.accounts[4]
      if (stake !== undefined && instruction.accounts.length === 13) found.add(stake)
    }
  }
  return [...found]
}

const SimulatedStake = z.object({
  value: z.object({
    err: z.unknown().nullable(),
    unitsConsumed: z.number().optional(),
    accounts: z
      .array(z.object({ data: z.tuple([z.string(), z.string()]) }).nullable())
      .nullable()
      .optional(),
  }),
})

const TokenAccounts = z.array(
  z.object({
    pubkey: z.string(),
    account: z.object({ data: z.tuple([z.string(), z.string()]) }),
  })
)

/**
 * Wallets holding at least this much of the token in their own account, with SOL for the fee. The
 * public nodes refuse the largest-holders call, and one answered this search on 5 November 2026.
 */
async function holdersOf(mint: string, atLeast: bigint): Promise<string[]> {
  const listed = TokenAccounts.parse(
    await rpc('getProgramAccounts', [
      TOKEN_PROGRAM,
      {
        encoding: 'base64',
        dataSlice: { offset: 32, length: 40 },
        filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
      },
    ])
  )
  const holders: string[] = []
  for (const { pubkey, account } of listed) {
    if (holders.length >= 3) break
    const data = bytesFromBase64(account.data[0])
    const owner = readAddress(data, 0)
    if (readU64(data, 32) < atLeast || pubkey !== associatedTokenAccount(owner, mint)) continue
    const wallet = await readAccount(rpc, owner).catch(() => undefined)
    if (wallet?.owner === SYSTEM_PROGRAM && wallet.lamports > BigInt(50_000_000)) {
      holders.push(owner)
    }
  }
  return holders
}

describe.skipIf(SKIP)('an unstake the claim can find later', () => {
  it(
    'lands at the first slot, under the person alone, already cooling',
    async () => {
      const holders = await holdersOf(SSOL_MINT, BigInt(2_000_000_000))
      console.info('holders', holders.length)
      expect(holders.length).toBeGreaterThan(0)
      const venue = createSolayerVenue({ rpc })
      let ran = 0
      for (const holder of holders.slice(0, 3)) {
        const prepared = await venue.prepare(
          { kind: 'unstake', amount: '1.5', tokenIn: 'sSOL' },
          holder
        )
        expect(() => venue.assertSafe(prepared.signing, holder)).not.toThrow()
        if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
        const stakeAccount = stakeExitAddress(holder, 0)
        expect(prepared.notes[0]).toContain(stakeAccount)
        const { value } = SimulatedStake.parse(
          await rpc('simulateTransaction', [
            prepared.signing.transaction,
            {
              encoding: 'base64',
              sigVerify: false,
              replaceRecentBlockhash: true,
              commitment: 'confirmed',
              accounts: { encoding: 'base64', addresses: [stakeAccount] },
            },
          ])
        )
        console.info(holder, 'err', JSON.stringify(value.err), 'units', value.unitsConsumed)
        if (value.err !== null) continue
        ran += 1
        const state = decodeStakeAccount(bytesFromBase64(value.accounts?.[0]?.data[0] as string))
        expect(state?.withdrawer).toBe(holder)
        expect(state?.lockedUp).toBe(false)
        const { epoch } = Epoch.parse(await rpc('getEpochInfo', [{ commitment: 'confirmed' }]))
        expect(state?.deactivationEpoch).toBe(BigInt(epoch))
      }
      expect(ran).toBeGreaterThan(0)
    },
    SLOW_MS
  )
})

describe.skipIf(SKIP)('claiming a cooled stake account', () => {
  it(
    'the chain agrees with what this reads as ready or cooling, and pays the whole balance',
    async () => {
      const { epoch } = Epoch.parse(await rpc('getEpochInfo', [{ commitment: 'confirmed' }]))
      const history = decodeStakeHistory((await readAccount(rpc, STAKE_HISTORY_SYSVAR)).data)
      expect(history?.size).toBeGreaterThan(100)
      const addresses = await stakeAccountsLeftByExits(200)
      expect(addresses.length).toBeGreaterThan(0)
      const held = await readAccounts(rpc, addresses)

      const seen = { ready: 0, cooling: 0 }
      for (const [i, account] of held.entries()) {
        const address = addresses[i] as string
        if (account === undefined || account.owner !== STAKE_PROGRAM) continue
        const state = decodeStakeAccount(account.data)
        if (state === undefined || state.lockedUp || history === undefined) continue
        const NOT_DEACTIVATED = BigInt('18446744073709551615')
        if (state.deactivationEpoch === NOT_DEACTIVATED) continue
        const left = stakeStillCooling(state.stake, state.deactivationEpoch, BigInt(epoch), history)
        const owner = state.withdrawer
        const transaction = await compileForSigning(rpc, owner, [
          ...computeBudget(20_000),
          withdrawStakeAccount(owner, address, account.lamports),
        ])
        const wallet = await readAccount(rpc, owner).catch(() => undefined)
        if (wallet === undefined || wallet.lamports < BigInt(100_000)) continue
        const { value } = Simulated.parse(
          await rpc('simulateTransaction', [
            transaction,
            {
              encoding: 'base64',
              sigVerify: false,
              replaceRecentBlockhash: true,
              commitment: 'confirmed',
              accounts: { encoding: 'base64', addresses: [owner, address] },
            },
          ])
        )
        console.info(
          address,
          'deactivated',
          state.deactivationEpoch,
          'epoch',
          epoch,
          'left',
          left,
          'err',
          JSON.stringify(value.err),
          'units',
          value.unitsConsumed
        )
        if (left === BigInt(0)) {
          seen.ready += 1
          expect(value.err).toBeNull()
          expect(value.unitsConsumed ?? 0).toBeLessThan(20_000)
          // The account closes, and the wallet gains its whole balance less the network fee.
          const [after, closed] = value.accounts ?? []
          expect(closed?.lamports ?? 0).toBe(0)
          const gained = BigInt(after?.lamports ?? 0) - wallet.lamports
          expect(gained).toBeGreaterThan(account.lamports - BigInt(100_000))
          expect(gained).toBeLessThanOrEqual(account.lamports)
        } else {
          seen.cooling += 1
          expect(value.err).not.toBeNull()
        }
      }
      console.info('seen', seen, 'of', addresses.length)
      expect(seen.ready + seen.cooling).toBeGreaterThan(0)
    },
    SLOW_MS
  )

  it(
    'finds no waiting exits for a wallet with none, without an account index',
    async () => {
      // The default public node, which refuses getProgramAccounts.
      const publicNode = readOnlyRpc({ SOLANA_RPC_URL: 'https://solana-rpc.publicnode.com' })
      const positions = await createSolayerVenue({ rpc: publicNode }).positions?.(FUNDED)
      expect(positions?.filter((p) => p.slot === 'claimable' || p.slot === 'cooling')).toEqual([])
    },
    SLOW_MS
  )

  it(
    'reads a real wallet’s staking tokens without failing',
    async () => {
      const publicNode = readOnlyRpc({ SOLANA_RPC_URL: 'https://solana-rpc.publicnode.com' })
      for (const venue of [
        createJitoVenue({ rpc: publicNode }),
        createMarinadeVenue({ rpc: publicNode }),
      ]) {
        const positions = await venue.positions?.(FUNDED)
        console.info(venue.id, positions)
        expect(Array.isArray(positions)).toBe(true)
      }
    },
    SLOW_MS
  )
})
