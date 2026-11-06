import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getBase58Decoder, type Address } from '@solana/kit'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { decodeSolanaTransaction } from '../chains/solana/assert-safe'
import { rpc as rawRpc } from '../chains/solana/balances'
import { createKaminoLimitVenue, limoBook } from '../chains/solana/limo'
import {
  decodeGlobalConfig,
  decodeOrder,
  inputVault,
  pdaAuthority,
} from '../chains/solana/limo-rules'
import { LIMO_GLOBAL_CONFIG, LIMO_PROGRAM } from '../chains/solana/programs'
import type { PreparedAction } from '../chains/types'

/**
 * Against mainnet, reading and simulating only. Nothing here signs for any account: a simulation
 * runs with `sigVerify: false`, and the only key involved is the throwaway order key, which owns
 * nothing. Run by this exact file name. The account named is a public exchange wallet.
 *
 * The first test writes `limo-order.json` if it is missing, or if `CAPTURE_LIMO_FIXTURE=1`.
 */

const FUNDED = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SYSTEM = '11111111111111111111111111111111'
const FIXTURE = join(__dirname, '../chains/solana/__fixtures__/limo-order.json')
const SLOW_MS = 180_000

const signal = (): AbortSignal => AbortSignal.timeout(120_000)
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const pause = (): Promise<void> => wait(4_000)

/** The public endpoint rate limits by address, so a refusal for that alone waits and goes again. */
async function patient<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (e) {
      if (attempt === 4 || !/answered 429|couldn’t read/.test(String(e))) throw e
      await wait(12_000)
    }
  }
}

const rpc = (method: string, params: unknown[], given: AbortSignal): Promise<unknown> =>
  patient(() => rawRpc(method, params, given))

interface Listed {
  pubkey: string
  account: { data: [string, string]; lamports: number; owner: string }
}

/** Order addresses for a status, read by filter so the whole book isn't fetched. */
async function ordersWithStatus(status: number): Promise<string[]> {
  const statusByte = getBase58Decoder().decode(Uint8Array.of(status))
  const listed = (await rpc(
    'getProgramAccounts',
    [
      LIMO_PROGRAM,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        dataSlice: { offset: 0, length: 0 },
        filters: [
          { dataSize: 424 },
          { memcmp: { offset: 8, bytes: LIMO_GLOBAL_CONFIG, encoding: 'base58' } },
          { memcmp: { offset: 72, bytes: SOL, encoding: 'base58' } },
          { memcmp: { offset: 136, bytes: USDC, encoding: 'base58' } },
          { memcmp: { offset: 249, bytes: statusByte, encoding: 'base58' } },
        ],
      },
    ],
    signal()
  )) as Listed[]
  if (listed.length === 0) throw new Error(`No order with status ${status}.`)
  // Most lamports first, so a newer order that holds its fee is the one tried.
  return [...listed]
    .sort((a, b) => b.account.lamports - a.account.lamports)
    .map((order) => order.pubkey)
}

/** An order whose maker can pay a fee, since a simulation fails for a fee payer with no SOL. */
async function orderOfFundedMaker(status: number): Promise<{ order: string; maker: string }> {
  const addresses = (await ordersWithStatus(status)).slice(0, 60)
  await pause()
  const orders = (await rpc(
    'getMultipleAccounts',
    [addresses, { encoding: 'base64', commitment: 'confirmed' }],
    signal()
  )) as { value: ({ data: [string, string] } | null)[] }
  const makers = orders.value.map((account) =>
    account === null ? undefined : decodeOrder(Buffer.from(account.data[0], 'base64'))?.maker
  )
  await pause()
  const known = makers.filter((maker): maker is string => maker !== undefined)
  const wallets = (await rpc(
    'getMultipleAccounts',
    [known, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }],
    signal()
  )) as { value: ({ lamports: number; owner: string } | null)[] }
  const index = wallets.value.findIndex(
    (wallet) => wallet !== null && wallet.lamports > 10_000_000 && wallet.owner === SYSTEM
  )
  const maker = known[index]
  if (maker === undefined) throw new Error('No funded maker among these orders.')
  return { order: addresses[makers.indexOf(maker)] as string, maker }
}

/** A closed account reads back empty and owned by the System Program, if it reads back at all. */
function expectClosed(account: { lamports: number } | null | undefined): void {
  expect(account?.lamports ?? 0).toBe(0)
}

async function readAccount(
  address: string
): Promise<{ lamports: number; owner: string; data: string }> {
  const { value } = (await rpc(
    'getAccountInfo',
    [address, { encoding: 'base64', commitment: 'confirmed' }],
    signal()
  )) as { value: { lamports: number; owner: string; data: [string, string] } | null }
  if (value === null) throw new Error(`${address} is not there.`)
  return { lamports: value.lamports, owner: value.owner, data: value.data[0] }
}

interface Simulated {
  value: {
    err: unknown
    logs: string[] | null
    unitsConsumed?: number
    accounts?: ({ lamports: number; data: [string, string] } | null)[]
  }
}

async function simulate(prepared: PreparedAction, read: readonly string[]): Promise<Simulated> {
  if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
  const result = (await rpc(
    'simulateTransaction',
    [
      prepared.signing.transaction,
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: read },
      },
    ],
    signal()
  )) as Simulated
  return result
}

describe.skipIf(process.env['SKIP_LIVE'] === '1')('kamino limit orders on mainnet', () => {
  beforeAll(() => {
    // The public endpoint is the one the fallback question is about, whatever this machine sets.
    vi.stubEnv('SOLANA_RPC_URL', '')
  })

  let filled: string

  it(
    'captures one real filled order to the fixture, and reads it',
    async () => {
      filled = (await ordersWithStatus(1))[0] as string
      const account = await readAccount(filled)
      expect(account.owner).toBe(LIMO_PROGRAM)
      const order = decodeOrder(Buffer.from(account.data, 'base64'))
      expect(order?.status).toBe(1)
      expect(order?.globalConfig).toBe(LIMO_GLOBAL_CONFIG)
      expect(order?.inputMint).toBe(SOL)
      expect(order?.outputMint).toBe(USDC)
      expect(order?.remainingInput).toBe(BigInt(0))
      expect(order?.filledOutput).toBeGreaterThanOrEqual(order?.expectedOutput ?? BigInt(1))
      if (process.env['CAPTURE_LIMO_FIXTURE'] === '1' || !existsSync(FIXTURE)) {
        writeFileSync(FIXTURE, `${JSON.stringify({ address: filled, ...account }, null, 2)}\n`)
      }
    },
    SLOW_MS
  )

  it(
    'reads the pinned config, which derives the same authority and takes new orders',
    async () => {
      await pause()
      const account = await readAccount(LIMO_GLOBAL_CONFIG)
      expect(account.owner).toBe(LIMO_PROGRAM)
      const config = decodeGlobalConfig(Buffer.from(account.data, 'base64'))
      console.log('config', config)
      expect(config?.pdaAuthority).toBe(pdaAuthority())
      expect(config?.newOrdersBlocked).toBe(false)
      expect(config?.cost).toBeLessThanOrEqual(BigInt(10_000_000))
    },
    SLOW_MS
  )

  it(
    'finds a vault at the address it derives for each offered mint',
    async () => {
      await pause()
      for (const mint of [SOL, USDC, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']) {
        const vault = await readAccount(inputVault(mint))
        expect(vault.owner).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
      }
    },
    SLOW_MS
  )

  it(
    'answers getProgramAccounts filtered by maker on api.mainnet-beta.solana.com',
    async () => {
      await pause()
      const { maker } = decodeOrder(
        Buffer.from((await readAccount(filled)).data, 'base64')
      ) as NonNullable<ReturnType<typeof decodeOrder>>
      await pause()
      const orders = await patient(() => limoBook().openOrders(maker, signal()))
      console.log('orders for maker', maker, orders.length)
      expect(orders.map((o) => o.id)).toContain(filled)
    },
    SLOW_MS
  )

  it.each([
    ['SOL', 'USDC', '0.01', '100000'],
    ['USDC', 'SOL', '1', '0.01'],
  ])(
    'simulates creating %s to %s for a funded wallet, and it passes its own check',
    async (tokenIn, tokenOut, amount, limitPrice) => {
      await pause()
      const venue = createKaminoLimitVenue()
      const prepared = await patient(() =>
        venue.prepare({ kind: 'limit', amount, tokenIn, tokenOut, limitPrice }, FUNDED)
      )
      venue.assertSafe(prepared.signing, FUNDED, prepared.context)
      if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
      const decoded = decodeSolanaTransaction(prepared.signing.transaction)
      expect(decoded.feePayerSignature).toBeNull()
      const order = decoded.staticAccounts[1] as Address

      await pause()
      const configBefore = await readAccount(LIMO_GLOBAL_CONFIG)
      await pause()
      const simulated = await simulate(prepared, [order, LIMO_GLOBAL_CONFIG])
      console.log(`${tokenIn} to ${tokenOut}`, {
        err: simulated.value.err,
        units: simulated.value.unitsConsumed,
        orderLamports: simulated.value.accounts?.[0]?.lamports,
        configLamportsChange:
          (simulated.value.accounts?.[1]?.lamports ?? 0) - configBefore.lamports,
      })
      expect(simulated.value.err).toBeNull()
      expect(simulated.value.logs?.join('\n')).toContain(`${LIMO_PROGRAM} success`)

      const created = simulated.value.accounts?.[0]
      const read = decodeOrder(Buffer.from(created?.data[0] ?? '', 'base64'))
      expect(read?.maker).toBe(FUNDED)
      expect(read?.globalConfig).toBe(LIMO_GLOBAL_CONFIG)
      expect(read?.status).toBe(0)
      expect(read?.initialInput.toString()).toBe(prepared.context?.['inputAmount'])
      expect(read?.expectedOutput.toString()).toBe(prepared.context?.['outputAmount'])
    },
    SLOW_MS
  )

  it(
    'simulates collecting a real filled order, as its own maker',
    async () => {
      await pause()
      const { order, maker } = await orderOfFundedMaker(1)
      const venue = createKaminoLimitVenue()
      await pause()
      const prepared = await patient(() => limoBook().prepareExit(maker, order, 'collect'))
      venue.assertSafe(prepared.signing, maker, prepared.context)
      await pause()
      const before = await readAccount(maker)
      await pause()
      const simulated = await simulate(prepared, [order, maker])
      const makerChange = (simulated.value.accounts?.[1]?.lamports ?? 0) - before.lamports
      console.log('collect', {
        order,
        maker,
        err: simulated.value.err,
        units: simulated.value.unitsConsumed,
        summary: prepared.summary,
        makerChange,
      })
      expect(simulated.value.err).toBeNull()
      expectClosed(simulated.value.accounts?.[0])
      // What the card says comes back, less a network fee far under this margin.
      const promised = Number(prepared.receive?.amount) * 1_000_000_000
      expect(Math.abs(makerChange - promised)).toBeLessThan(100_000)
    },
    SLOW_MS
  )

  it(
    'simulates cancelling a real open order, as its own maker',
    async () => {
      await pause()
      const { order, maker } = await orderOfFundedMaker(0)
      const venue = createKaminoLimitVenue()
      await pause()
      const prepared = await patient(() => limoBook().prepareExit(maker, order, 'cancel'))
      venue.assertSafe(prepared.signing, maker, prepared.context)
      await pause()
      const before = await readAccount(order)
      await pause()
      const makerBefore = await readAccount(maker)
      await pause()
      const simulated = await simulate(prepared, [order, maker])
      console.log('cancel', {
        order,
        maker,
        err: simulated.value.err,
        units: simulated.value.unitsConsumed,
        summary: prepared.summary,
        orderLamports: before.lamports,
        makerChange: (simulated.value.accounts?.[1]?.lamports ?? 0) - makerBefore.lamports,
      })
      expect(simulated.value.err).toBeNull()
      expectClosed(simulated.value.accounts?.[0])
    },
    SLOW_MS
  )
})
