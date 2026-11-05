import { getAddressDecoder } from '@solana/kit'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  associatedTokenAccount,
  decodeSolanaTransaction,
  TOKEN_PROGRAM,
} from '../chains/solana/assert-safe'
import {
  createStreamflowVenue,
  STREAMFLOW_FEE_ORACLE,
  STREAMFLOW_PROGRAM,
  STREAMFLOW_TREASURY,
  STREAMFLOW_WITHDRAWOR,
} from '../chains/solana/streamflow'
import { SOLANA_TOKENS } from '../chains/solana/tokens'

/**
 * Read-only: nothing here signs or sends. Checks that each pinned id still holds on chain, and
 * that a real build passes the program in a dry run with no signature. The account is the public
 * exchange wallet the other Solana live tests use, which holds USDC and SOL.
 *
 * A failure on the upgrade pins means Streamflow changed its program or who can change it, so the
 * card's note and this venue need another look before anything else ships.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const RPC = process.env['SOLANA_RPC_URL']?.trim() || 'https://solana-rpc.publicnode.com'
const FUNDED = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
const RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const SLOW_MS = 60_000

const PROGRAM_DATA = '796tZf2QrH1ebZTQC1mDHYP6weDqSKuqbeyaXd64Prs'
/** 21 September 2026, the date the card's note names. */
const LAST_DEPLOYED_SLOT = 449063805
const UPGRADE_AUTHORITY = '5u7o2WGgHckh18opTfPsqKb8E3nhDKcReBrbzUeXg2n7'
const PARTNER_ORACLE_PROGRAM = 'pardpVtPjC8nLj1Dwncew62mUzfChdCX1EaoZe8oCAa'
const SYSTEM_PROGRAM = '11111111111111111111111111111111'

interface Account {
  owner: string
  executable: boolean
  data: { parsed?: { info?: Record<string, unknown> } } | unknown
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return ((await response.json()) as { result: unknown }).result
}

async function account(address: string): Promise<Account> {
  const { value } = (await rpc('getAccountInfo', [address, { encoding: 'jsonParsed' }])) as {
    value: Account
  }
  return value
}

function parsedInfo(value: Account): Record<string, unknown> {
  return (value.data as { parsed: { info: Record<string, unknown> } }).parsed.info
}

describe.skipIf(SKIP)('Streamflow on chain', () => {
  beforeAll(() => {
    vi.stubEnv('AUTH_SECRET', 'a-secret-long-enough-to-sign-with-here')
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it(
    'the program still lives where the docs say, with the same code and upgrade key',
    async () => {
      const program = await account(STREAMFLOW_PROGRAM)
      expect(program.executable).toBe(true)
      expect(parsedInfo(program)['programData']).toBe(PROGRAM_DATA)

      const data = parsedInfo(await account(PROGRAM_DATA))
      expect(data['slot']).toBe(LAST_DEPLOYED_SLOT)
      expect(data['authority']).toBe(UPGRADE_AUTHORITY)
    },
    SLOW_MS
  )

  it(
    'the fee accounts are what the SDK says',
    async () => {
      expect((await account(STREAMFLOW_TREASURY)).owner).toBe(SYSTEM_PROGRAM)
      expect((await account(STREAMFLOW_WITHDRAWOR)).owner).toBe(SYSTEM_PROGRAM)
      expect((await account(STREAMFLOW_FEE_ORACLE)).owner).toBe(PARTNER_ORACLE_PROGRAM)
    },
    SLOW_MS
  )

  it(
    'USDC and USDT are on the Token Program this builds for',
    async () => {
      for (const symbol of ['USDC', 'USDT']) {
        const mint = SOLANA_TOKENS.find((t) => t.symbol === symbol)?.id as string
        expect((await account(mint)).owner).toBe(TOKEN_PROGRAM)
      }
    },
    SLOW_MS
  )

  it(
    'a real build passes the program in a dry run, and reads its fees',
    async () => {
      const venue = createStreamflowVenue()
      const action = await venue.prepare(
        {
          kind: 'stream',
          amount: '10',
          tokenIn: 'USDC',
          recipient: RECIPIENT,
          durationDays: '30',
        },
        FUNDED
      )
      if (action.signing.family !== 'solana') throw new Error('Expected a Solana payload.')
      const decoded = decodeSolanaTransaction(action.signing.transaction)
      expect(decoded.feePayer).toBe(FUNDED)
      expect(decoded.feePayerSignature).toBeNull()
      expect(decoded.signerCount).toBe(1)
      expect(() => venue.assertSafe(action.signing, FUNDED, action.context)).not.toThrow()
      expect(action.notes[1]).toMatch(/takes [\d.]+ USDC and [\d.]+ SOL/)
    },
    SLOW_MS
  )
})

/** The public node that takes the program-wide search, so these find real, running streams. */
const INDEXED = 'https://api.mainnet-beta.solana.com'
const USDC = SOLANA_TOKENS.find((t) => t.symbol === 'USDC')?.id as string
const CANCEL_SLOW_MS = 240_000

async function indexed(method: string, params: unknown[]): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 800))
  const response = await fetch(INDEXED, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return ((await response.json()) as { result: unknown }).result
}

interface RunningStream {
  id: string
  sender: string
  recipient: string
  mint: string
  escrow: string
}

/** Streams still running that their sender may cancel, with senders who are plain wallets. */
async function runningStreams(): Promise<RunningStream[]> {
  const listed = (await indexed('getProgramAccounts', [
    STREAMFLOW_PROGRAM,
    {
      encoding: 'base64',
      filters: [
        { dataSize: 1104 },
        { memcmp: { offset: 177, bytes: USDC } },
        { memcmp: { offset: 671, bytes: '1' } },
        { memcmp: { offset: 457, bytes: '2' } },
      ],
    },
  ])) as { pubkey: string; account: { data: [string, string] } }[]
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  const decoder = getAddressDecoder()
  return listed.flatMap(({ pubkey, account: held }) => {
    const bytes = Buffer.from(held.data[0], 'base64')
    const at = (offset: number): string => decoder.decode(bytes.subarray(offset, offset + 32))
    return bytes.readBigUInt64LE(33) > nowSeconds + BigInt(86_400)
      ? [{ id: pubkey, sender: at(49), recipient: at(113), mint: at(177), escrow: at(209) }]
      : []
  })
}

interface SimulatedToken {
  data: [string, string]
}

const tokenAmountOf = (data: string | undefined): bigint => {
  const bytes = Buffer.from(data ?? '', 'base64')
  return bytes.length < 72 ? BigInt(0) : bytes.readBigUInt64LE(64)
}

describe.skipIf(SKIP)('cancelling a real Streamflow stream', () => {
  beforeAll(() => {
    vi.stubEnv('AUTH_SECRET', 'a-secret-long-enough-to-sign-with-here')
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it(
    'builds a cancel the program accepts, refunds the sender, and pays only who the stream names',
    async () => {
      const streams = await runningStreams()
      expect(streams.length).toBeGreaterThan(0)
      const venue = createStreamflowVenue()
      let built = 0
      for (const stream of streams.slice(0, 20)) {
        if (built >= 3) break
        const sender = await account(stream.sender).catch(() => undefined)
        if (sender === undefined || sender?.owner !== SYSTEM_PROGRAM) continue
        await new Promise((resolve) => setTimeout(resolve, 800))
        const action = await venue
          .prepare(
            { kind: 'cancel', amount: 'all', tokenIn: 'STREAM', streamId: stream.id },
            stream.sender
          )
          .catch((e: Error) => {
            console.info(stream.id, 'refused:', e.message)
            return undefined
          })
        if (action === undefined) continue
        built += 1
        expect(() => venue.assertSafe(action.signing, stream.sender, action.context)).not.toThrow()
        if (action.signing.family !== 'solana') throw new Error('Expected a Solana payload.')
        expect(decodeSolanaTransaction(action.signing.transaction).feePayerSignature).toBeNull()

        const senderTokens = associatedTokenAccount(stream.sender, stream.mint)
        const recipientTokens = associatedTokenAccount(stream.recipient, stream.mint)
        const treasuryTokens = associatedTokenAccount(STREAMFLOW_TREASURY, stream.mint)
        const addresses = [senderTokens, recipientTokens, treasuryTokens, stream.escrow, stream.id]
        const before = (await indexed('getMultipleAccounts', [
          addresses,
          { encoding: 'base64', commitment: 'confirmed' },
        ])) as { value: (SimulatedToken | null)[] }
        const simulated = (await indexed('simulateTransaction', [
          action.signing.transaction,
          {
            encoding: 'base64',
            sigVerify: false,
            replaceRecentBlockhash: true,
            commitment: 'confirmed',
            accounts: { encoding: 'base64', addresses },
          },
        ])) as {
          value: { err: unknown; unitsConsumed: number; accounts: (SimulatedToken | null)[] }
        }
        expect(simulated.value.err).toBeNull()
        const delta = (position: number): string =>
          (
            tokenAmountOf(simulated.value.accounts[position]?.data[0]) -
            tokenAmountOf(before.value[position]?.data[0])
          ).toString()
        console.info(stream.id, action.summary, {
          units: simulated.value.unitsConsumed,
          sender: delta(0),
          recipient: delta(1),
          treasury: delta(2),
          escrow: delta(3),
          escrowAfterExists: simulated.value.accounts[3] !== null,
          streamAfterExists: simulated.value.accounts[4] !== null,
        })
        const gained = BigInt(delta(0))
        expect(gained).toBeGreaterThan(BigInt(0))
        expect(BigInt(delta(1)) >= BigInt(0)).toBe(true)
      }
      expect(built).toBeGreaterThan(0)
    },
    CANCEL_SLOW_MS
  )

  it(
    'lists a real sender’s running streams through the default node’s refusal',
    async () => {
      const streams = await runningStreams()
      const stream = streams[0] as RunningStream
      const positions = await createStreamflowVenue().positions?.(stream.sender)
      console.info(stream.sender, positions?.length)
      expect(positions?.map((p) => p.id)).toContain(stream.id)
    },
    CANCEL_SLOW_MS
  )
})
