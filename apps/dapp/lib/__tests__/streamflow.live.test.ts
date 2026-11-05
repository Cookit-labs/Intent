import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { decodeSolanaTransaction, TOKEN_PROGRAM } from '../chains/solana/assert-safe'
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
