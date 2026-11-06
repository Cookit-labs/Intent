import {
  getAddressDecoder,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  type Address,
} from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAccount,
  decodeSolanaTransaction,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from '../chains/solana/assert-safe'
import {
  createStreamflowVenue,
  STREAMFLOW_FEE_ORACLE,
  STREAMFLOW_PROGRAM,
  STREAMFLOW_TREASURY,
  STREAMFLOW_WITHDRAWOR,
  type SolanaRpc,
} from '../chains/solana/streamflow'
import { streamflowVenue } from '../chains/solana/streamflow-listing'
import { SOLANA_TOKENS } from '../chains/solana/tokens'
import {
  ChainActionRefused,
  type ChainActionRequest,
  type PreparedAction,
  type SigningPayload,
} from '../chains/types'

const ACCOUNT = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
const RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const ATTACKER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const USDC = SOLANA_TOKENS.find((t) => t.symbol === 'USDC')?.id as string
const USDT = SOLANA_TOKENS.find((t) => t.symbol === 'USDT')?.id as string
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const BLOCKHASH = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn'
const SECRET = 'a-secret-long-enough-to-sign-with-here'

const ASK: ChainActionRequest = {
  kind: 'stream',
  amount: '100',
  tokenIn: 'USDC',
  recipient: RECIPIENT,
  durationDays: '30',
}

interface Message {
  version: number | 'legacy'
  header: {
    numSignerAccounts: number
    numReadonlySignerAccounts: number
    numReadonlyNonSignerAccounts: number
  }
  staticAccounts: readonly Address[]
  lifetimeToken: string
  instructions: readonly {
    programAddressIndex: number
    accountIndices?: readonly number[]
    data?: Uint8Array
  }[]
  addressTableLookups?: readonly unknown[]
}

function open(base64: string): Message {
  const { messageBytes } = getTransactionDecoder().decode(Buffer.from(base64, 'base64'))
  return getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as Message
}

function close(message: Message, signatureCount = message.header.numSignerAccounts): string {
  const bytes = getCompiledTransactionMessageEncoder().encode(
    message as unknown as Parameters<
      ReturnType<typeof getCompiledTransactionMessageEncoder>['encode']
    >[0]
  )
  return Buffer.concat([
    Buffer.from([signatureCount]),
    Buffer.alloc(64 * signatureCount),
    Buffer.from(bytes),
  ]).toString('base64')
}

function address(bytes: Uint8Array, offset: number): string {
  return getAddressDecoder().decode(bytes.subarray(offset, offset + 32))
}

/** What the program writes to a stream's account, at the offsets of the SDK's `streamLayout`. */
function metadataFor(
  overrides: Partial<{
    sender: string
    recipient: string
    treasury: string
    partner: string
    mint: string
    net: bigint
    partnerFee: bigint
  }> = {}
): string {
  const buffer = Buffer.alloc(1104)
  const put = (at: number, value: string): void => {
    buffer.set(getAddressEncoder().encode(value as Address), at)
  }
  put(49, overrides.sender ?? ACCOUNT)
  put(113, overrides.recipient ?? RECIPIENT)
  put(177, overrides.mint ?? USDC)
  put(241, overrides.treasury ?? STREAMFLOW_TREASURY)
  buffer.writeBigUInt64LE(BigInt(190_000), 305)
  put(325, overrides.partner ?? overrides.sender ?? ACCOUNT)
  buffer.writeBigUInt64LE(overrides.partnerFee ?? BigInt(0), 389)
  buffer.writeBigUInt64LE(overrides.net ?? BigInt(100_000_000), 417)
  buffer.writeUInt32LE(160_000_000, 704)
  return buffer.toString('base64')
}

interface FakeChain {
  recipientAccount?: { owner: string; executable: boolean } | null
  simulationError?: unknown
  metadata?: string
  unreadable?: readonly string[]
}

function fakeRpc(chain: FakeChain = {}): SolanaRpc {
  return async (method) => {
    if (chain.unreadable?.includes(method) === true) return undefined
    switch (method) {
      case 'getAccountInfo':
        return { result: { value: chain.recipientAccount ?? null } }
      case 'getLatestBlockhash':
        return { result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 400 } } }
      case 'simulateTransaction':
        return {
          result: {
            value: {
              err: chain.simulationError ?? null,
              accounts: [{ data: [chain.metadata ?? metadataFor(), 'base64'] }],
            },
          },
        }
      default:
        throw new Error(`Unexpected ${method}`)
    }
  }
}

async function prepared(chain?: FakeChain, ask: ChainActionRequest = ASK): Promise<PreparedAction> {
  return createStreamflowVenue({ rpc: fakeRpc(chain) }).prepare(ask, ACCOUNT)
}

const venue = createStreamflowVenue({ rpc: fakeRpc() })

function solana(transaction: string): SigningPayload {
  return { family: 'solana', transaction }
}

function transactionOf(action: PreparedAction): string {
  if (action.signing.family !== 'solana') throw new Error('Expected a Solana payload.')
  return action.signing.transaction
}

/** Runs the check on a changed copy of what was built, with what the server issued for it. */
async function checkTampered(change: (message: Message) => Message): Promise<void> {
  const action = await prepared()
  venue.assertSafe(solana(close(change(open(transactionOf(action))))), ACCOUNT, action.context)
}

function swapAccount(message: Message, from: string, to: string): Message {
  expect(message.staticAccounts).toContain(from)
  return {
    ...message,
    staticAccounts: message.staticAccounts.map((a) => (a === from ? (to as Address) : a)),
  }
}

function lastData(message: Message): Uint8Array {
  return message.instructions[message.instructions.length - 1]?.data as Uint8Array
}

function withLastData(message: Message, data: Uint8Array): Message {
  return {
    ...message,
    instructions: message.instructions.map((ix, i) =>
      i === message.instructions.length - 1 ? { ...ix, data } : ix
    ),
  }
}

function changedByte(message: Message, offset: number, value: number): Message {
  const data = Uint8Array.from(lastData(message))
  data[offset] = value
  return withLastData(message, data)
}

function withStatic(message: Message, ...addresses: string[]): Message {
  return {
    ...message,
    header: {
      ...message.header,
      numReadonlyNonSignerAccounts: message.header.numReadonlyNonSignerAccounts + addresses.length,
    },
    staticAccounts: [...message.staticAccounts, ...(addresses as Address[])],
  }
}

/** Puts an instruction first, calling a program by address, with accounts by address. */
function withExtra(message: Message, program: string, accounts: string[], data: number[]): Message {
  const missing = [program, ...accounts].filter(
    (a) => !message.staticAccounts.includes(a as Address)
  )
  const grown = withStatic(message, ...new Set(missing))
  const index = (a: string): number => grown.staticAccounts.indexOf(a as Address)
  return {
    ...grown,
    instructions: [
      {
        programAddressIndex: index(program),
        accountIndices: accounts.map(index),
        data: Uint8Array.from(data),
      },
      ...grown.instructions,
    ],
  }
}

function le(value: bigint, bytes: number): number[] {
  return Array.from({ length: bytes }, (_, i) => Number((value >> BigInt(8 * i)) & BigInt(255)))
}

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', SECRET)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Streamflow stream', () => {
  it('builds one create_v2 from the person to the address they typed', async () => {
    const action = await prepared()
    const decoded = decodeSolanaTransaction(transactionOf(action))
    const message = open(transactionOf(action))
    expect(decoded.feePayer).toBe(ACCOUNT)
    expect(decoded.feePayerSignature).toBeNull()
    expect(decoded.signerCount).toBe(1)
    expect(decoded.readonlySignerCount).toBe(0)
    expect(message.version).toBe('legacy')

    const programs = message.instructions.map(
      (ix) => message.staticAccounts[ix.programAddressIndex]
    )
    expect(programs).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, STREAMFLOW_PROGRAM])

    const call = message.instructions[2]
    const accounts = (call?.accountIndices ?? []).map((i) => message.staticAccounts[i])
    expect(accounts).toHaveLength(18)
    expect(accounts[0]).toBe(ACCOUNT)
    expect(accounts[1]).toBe(associatedTokenAccount(ACCOUNT, USDC))
    expect(accounts[2]).toBe(RECIPIENT)
    expect(accounts[5]).toBe(associatedTokenAccount(RECIPIENT, USDC))
    expect(accounts[6]).toBe(STREAMFLOW_TREASURY)
    expect(accounts[7]).toBe(associatedTokenAccount(STREAMFLOW_TREASURY, USDC))
    expect(accounts[8]).toBe(STREAMFLOW_WITHDRAWOR)
    expect(accounts[9]).toBe(ACCOUNT)
    expect(accounts[10]).toBe(associatedTokenAccount(ACCOUNT, USDC))
    expect(accounts[11]).toBe(USDC)
    expect(accounts[12]).toBe(STREAMFLOW_FEE_ORACLE)
    expect(accounts[14]).toBe(STREAMFLOW_PROGRAM)
    expect(accounts[15]).toBe(TOKEN_PROGRAM)
    expect(accounts[16]).toBe(ASSOCIATED_TOKEN_PROGRAM)
    expect(accounts[17]).toBe(SYSTEM_PROGRAM)
  })

  it('writes the schedule the person asked for, hour by hour, with every power off but cancel', async () => {
    const data = Buffer.from(lastData(open(transactionOf(await prepared()))))
    expect(data).toHaveLength(150)
    expect(data.subarray(0, 8).toString('hex')).toBe('d6904cec5f8b31b4')
    expect(data.readBigUInt64LE(8)).toBe(BigInt(0))
    expect(data.readBigUInt64LE(16)).toBe(BigInt(100_000_000))
    expect(data.readBigUInt64LE(24)).toBe(BigInt(3600))
    // 720 hours of 138,888 units, and the 640 units division leaves at the start.
    expect(data.readBigUInt64LE(32)).toBe(BigInt(138_888))
    expect(data.readBigUInt64LE(40)).toBe(BigInt(0))
    expect(data.readBigUInt64LE(48)).toBe(BigInt(640))
    expect(BigInt(138_888) * BigInt(720) + BigInt(640)).toBe(BigInt(100_000_000))
    expect([...data.subarray(56, 62)]).toEqual([1, 0, 0, 0, 0, 0])
    expect(data.readBigUInt64LE(126)).toBe(BigInt(3600))
    expect([...data.subarray(134, 136)]).toEqual([0, 0])
    expect([...data.subarray(140)]).toEqual(Array.from({ length: 10 }, () => 0))
  })

  it('gets a different stream address each time, so two streams do not collide', async () => {
    const one = lastData(open(transactionOf(await prepared())))
    const two = lastData(open(transactionOf(await prepared())))
    expect(Buffer.from(one.subarray(136, 140))).not.toEqual(Buffer.from(two.subarray(136, 140)))
  })

  it('says what it does, and the fees it read', async () => {
    const action = await prepared()
    expect(action.venueId).toBe('streamflow')
    expect(action.kind).toBe('stream')
    expect(action.pay).toEqual({ amount: '100', symbol: 'USDC' })
    expect(action.summary).toContain(RECIPIENT)
    expect(action.summary).toContain('30 days')
    const notes = action.notes.join(' ')
    expect(notes).toContain('0.19 USDC')
    expect(notes).toContain('0.16 SOL')
    expect(notes).toMatch(/withdraw/i)
    expect(notes).toMatch(/cancel/i)
    expect(notes).toMatch(/upgrade/i)
    expect(notes).toContain('Neodyme')
    expect(notes).not.toContain('—')
  })

  it('passes its own check, unsigned and with a signature in the slot', async () => {
    const action = await prepared()
    const transaction = transactionOf(action)
    expect(() => venue.assertSafe(solana(transaction), ACCOUNT, action.context)).not.toThrow()
    const signed = Buffer.from(transaction, 'base64')
    signed.fill(7, 1, 65)
    expect(() =>
      venue.assertSafe(solana(signed.toString('base64')), ACCOUNT, action.context)
    ).not.toThrow()
  })

  it('takes USDT too', async () => {
    const metadata = metadataFor({ mint: USDT })
    const action = await prepared({ metadata }, { ...ASK, tokenIn: 'USDT' })
    expect(action.pay.symbol).toBe('USDT')
    const message = open(transactionOf(action))
    expect(message.staticAccounts).toContain(USDT)
    expect(() => venue.assertSafe(action.signing, ACCOUNT, action.context)).not.toThrow()
  })
})

describe('Streamflow refuses to build', () => {
  it.each<[string, Partial<ChainActionRequest>, RegExp]>([
    ['another kind', { kind: 'send' }, /stream/i],
    ['SOL', { tokenIn: 'SOL' }, /USDC or USDT/],
    ['a token with its own risks', { tokenIn: 'JitoSOL' }, /USDC or USDT/],
    ['an unknown token', { tokenIn: 'NOPE' }, /USDC or USDT/],
    ['no recipient', { recipient: undefined }, /address/],
    ['a malformed recipient', { recipient: 'not-an-address' }, /address/],
    ['the person as recipient', { recipient: ACCOUNT }, /your own wallet/],
    ['a token mint as recipient', { recipient: USDC }, /address/],
    ['an address with no key', { recipient: associatedTokenAccount(ACCOUNT, USDC) }, /sign/],
    ['no length', { durationDays: undefined }, /days/],
    ['a length of zero', { durationDays: '0' }, /days/],
    ['a part of a day', { durationDays: '1.5' }, /days/],
    ['too long a length', { durationDays: '3651' }, /days/],
    ['an amount of nothing', { amount: '0' }, /more than zero/],
    ['more than the token has places for', { amount: '1.0000001' }, /decimal/],
    ['more than a u64 holds', { amount: '99999999999999999999' }, /too large/],
    ['an amount too small to spread evenly', { amount: '0.001', durationDays: '365' }, /too small/],
    [
      'an amount that would mostly unlock at the start',
      { amount: '0.000025', durationDays: '1' },
      /too small/,
    ],
  ])('%s', async (_name, change, wanted) => {
    await expect(prepared({}, { ...ASK, ...change })).rejects.toThrow(wanted)
    await expect(prepared({}, { ...ASK, ...change })).rejects.toBeInstanceOf(ChainActionRefused)
  })

  it('a wallet that is not a Solana address', async () => {
    await expect(venue.prepare(ASK, '0x1234')).rejects.toThrow(/Solana wallet/)
  })

  it('a recipient that is a program', async () => {
    await expect(
      prepared({
        recipientAccount: {
          owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
          executable: true,
        },
      })
    ).rejects.toThrow(/plain wallet/)
  })

  it('a recipient that is a token account', async () => {
    await expect(
      prepared({ recipientAccount: { owner: TOKEN_PROGRAM, executable: false } })
    ).rejects.toThrow(/plain wallet/)
  })

  it('a wallet that already holds SOL is fine as a recipient', async () => {
    await expect(
      prepared({ recipientAccount: { owner: SYSTEM_PROGRAM, executable: false } })
    ).resolves.toBeDefined()
  })

  it('when the recipient cannot be read', async () => {
    await expect(prepared({ unreadable: ['getAccountInfo'] })).rejects.toThrow(/could not be read/)
  })

  it('when no recent blockhash can be read', async () => {
    await expect(prepared({ unreadable: ['getLatestBlockhash'] })).rejects.toThrow(
      /could not be read/
    )
  })

  it('when it can not be tried on the chain', async () => {
    await expect(prepared({ unreadable: ['simulateTransaction'] })).rejects.toThrow(
      /could not be read/
    )
  })

  it('what would fail on the chain', async () => {
    await expect(prepared({ simulationError: { InstructionError: [2, 'x'] } })).rejects.toThrow(
      /would fail/
    )
  })

  it('without a secret to prove what it issued', async () => {
    vi.stubEnv('AUTH_SECRET', '')
    await expect(prepared()).rejects.toThrow(/isn.t available/)
  })

  it.each<[string, Parameters<typeof metadataFor>[0]]>([
    ['pays another recipient', { recipient: ATTACKER }],
    ['pays another treasury', { treasury: ATTACKER }],
    ['names another partner', { partner: ATTACKER }],
    ['holds another token', { mint: USDT }],
    ['holds another amount', { net: BigInt(1) }],
    ['pays a partner fee', { partnerFee: BigInt(1) }],
  ])('a stream the program would write that %s', async (_name, overrides) => {
    await expect(prepared({ metadata: metadataFor(overrides) })).rejects.toThrow(/not the stream/)
  })

  it('when the program would write something unreadable', async () => {
    await expect(prepared({ metadata: 'AAAA' })).rejects.toThrow(/could not be read/)
  })
})

describe('Streamflow assertSafe refuses', () => {
  it('another wallet', async () => {
    const action = await prepared()
    expect(() => venue.assertSafe(action.signing, RECIPIENT, action.context)).toThrow(
      ChainActionRefused
    )
  })

  it('a wrong fee payer, even with a true proof for the person', async () => {
    const other = await createStreamflowVenue({
      rpc: fakeRpc({ metadata: metadataFor({ sender: RECIPIENT, recipient: ATTACKER }) }),
    }).prepare({ ...ASK, recipient: ATTACKER }, RECIPIENT)
    const mine = await prepared()
    expect(() => venue.assertSafe(other.signing, ACCOUNT, mine.context)).toThrow(/your wallet/)
  })

  it('anything that is not a Solana transaction', async () => {
    const action = await prepared()
    expect(() =>
      venue.assertSafe({ family: 'sui', transaction: 'AAAA' }, ACCOUNT, action.context)
    ).toThrow(ChainActionRefused)
  })

  it('no proof, or a proof for other terms', async () => {
    const action = await prepared()
    const context = action.context as Record<string, string>
    const check = (changed: Record<string, string> | undefined): void =>
      venue.assertSafe(action.signing, ACCOUNT, changed)
    expect(() => check(undefined)).toThrow(/not what this app issued/)
    expect(() => check({ ...context, recipient: ATTACKER })).toThrow(/not what this app issued/)
    expect(() => check({ ...context, token: USDT })).toThrow(/not what this app issued/)
    expect(() => check({ ...context, amount: '1' })).toThrow(/not what this app issued/)
    expect(() => check({ ...context, days: '1' })).toThrow(/not what this app issued/)
    expect(() => check({ ...context, proof: 'forged' })).toThrow(/not what this app issued/)
  })

  it('a proof from another secret', async () => {
    const action = await prepared()
    vi.stubEnv('AUTH_SECRET', 'another-secret-long-enough-to-sign-with')
    expect(() => venue.assertSafe(action.signing, ACCOUNT, action.context)).toThrow(
      /not what this app issued/
    )
  })

  it('an unknown program', async () => {
    await expect(
      checkTampered((m) =>
        swapAccount(m, STREAMFLOW_PROGRAM, 'strmdbLr6w7QNmsiEXyFwWg3VSfg1GiELgU27P8aCGw')
      )
    ).rejects.toThrow(/should not need/)
  })

  it('another of the program’s instructions', async () => {
    await expect(
      checkTampered((m) => {
        const data = Uint8Array.from(lastData(m))
        // Anchor's discriminator for `create`, whose stream address needs a second signer.
        data.set(Buffer.from('181ec828051c0777', 'hex'), 0)
        return withLastData(m, data)
      })
    ).rejects.toThrow(/didn.t expect/)
  })

  it('extra instruction data', async () => {
    await expect(
      checkTampered((m) => withLastData(m, Uint8Array.from([...lastData(m), 1])))
    ).rejects.toThrow(/not the stream/)
  })

  it('short instruction data', async () => {
    await expect(
      checkTampered((m) => withLastData(m, lastData(m).subarray(0, 140)))
    ).rejects.toThrow(/not the stream/)
  })

  it('an extra account on the call', async () => {
    await expect(
      checkTampered((m) => {
        const grown = withStatic(m, ATTACKER)
        const last = grown.instructions.length - 1
        return {
          ...grown,
          instructions: grown.instructions.map((ix, i) =>
            i === last
              ? {
                  ...ix,
                  accountIndices: [...(ix.accountIndices ?? []), grown.staticAccounts.length - 1],
                }
              : ix
          ),
        }
      })
    ).rejects.toThrow(/not the stream/)
  })

  it.each<[string, string]>([
    ['the recipient', RECIPIENT],
    ['the treasury', STREAMFLOW_TREASURY],
    ['the withdrawor', STREAMFLOW_WITHDRAWOR],
    ['the fee oracle', STREAMFLOW_FEE_ORACLE],
    ['the mint', USDC],
    ['the token program', TOKEN_PROGRAM],
  ])('%s swapped for another address', async (_name, from) => {
    await expect(checkTampered((m) => swapAccount(m, from, ATTACKER))).rejects.toThrow(
      /not the stream/
    )
  })

  it.each<[string, () => string]>([
    ['the person’s token account', () => associatedTokenAccount(ACCOUNT, USDC)],
    ['the recipient’s token account', () => associatedTokenAccount(RECIPIENT, USDC)],
    ['the treasury’s token account', () => associatedTokenAccount(STREAMFLOW_TREASURY, USDC)],
  ])('%s swapped for an attacker’s', async (_name, from) => {
    await expect(
      checkTampered((m) => swapAccount(m, from(), associatedTokenAccount(ATTACKER, USDC)))
    ).rejects.toThrow(/not the stream/)
  })

  it('a partner who is not the person', async () => {
    await expect(
      checkTampered((m) => {
        const grown = withStatic(m, ATTACKER)
        const attacker = grown.staticAccounts.length - 1
        const last = grown.instructions.length - 1
        return {
          ...grown,
          instructions: grown.instructions.map((ix, i) =>
            i === last
              ? {
                  ...ix,
                  accountIndices: (ix.accountIndices ?? []).map((a, p) => (p === 9 ? attacker : a)),
                }
              : ix
          ),
        }
      })
    ).rejects.toThrow(/not the stream/)
  })

  it.each<[string, number, number]>([
    ['a start time', 8, 9],
    ['another amount', 16, 1],
    ['another period', 24, 1],
    ['another rate', 32, 1],
    ['a cliff time', 40, 1],
    ['another amount at the start', 48, 1],
    ['no cancel for the person', 56, 0],
    ['a cancel for the recipient', 57, 1],
    ['automatic withdrawals, which charge a fee', 58, 1],
    ['a transfer by the sender', 59, 1],
    ['a transfer by the recipient', 60, 1],
    ['a top up', 61, 1],
    ['another name', 62, 65],
    ['another withdrawal frequency', 126, 1],
    ['a pause', 134, 1],
    ['a rate change', 135, 1],
    ['bytes after the nonce', 140, 1],
  ])('%s', async (_name, offset, value) => {
    await expect(checkTampered((m) => changedByte(m, offset, value))).rejects.toThrow(
      /not the stream/
    )
  })

  it('a stream address that is not the one its nonce makes', async () => {
    await expect(
      checkTampered((m) => {
        const data = Uint8Array.from(lastData(m))
        data[136] = ((data[136] ?? 0) + 1) % 256
        return withLastData(m, data)
      })
    ).rejects.toThrow(/not the stream/)
  })

  it('a second signer', async () => {
    await expect(
      checkTampered((m) => ({
        ...m,
        header: { ...m.header, numSignerAccounts: 2 },
      }))
    ).rejects.toThrow(/someone other than you/)
  })

  it('an extra SOL transfer', async () => {
    await expect(
      checkTampered((m) =>
        withExtra(m, SYSTEM_PROGRAM, [ACCOUNT, ATTACKER], [2, 0, 0, 0, ...le(BigInt(5000), 8)])
      )
    ).rejects.toThrow(/SOL transfer/)
  })

  it('an extra token transfer', async () => {
    await expect(
      checkTampered((m) =>
        withExtra(
          m,
          TOKEN_PROGRAM,
          [associatedTokenAccount(ACCOUNT, USDC), associatedTokenAccount(ATTACKER, USDC), ACCOUNT],
          [3, ...le(BigInt(1), 8)]
        )
      )
    ).rejects.toThrow(/moves tokens/)
  })

  it('an unlimited approval', async () => {
    await expect(
      checkTampered((m) =>
        withExtra(
          m,
          TOKEN_PROGRAM,
          [associatedTokenAccount(ACCOUNT, USDC), ATTACKER, ACCOUNT],
          [4, ...le(BigInt('18446744073709551615'), 8)]
        )
      )
    ).rejects.toThrow(/moves tokens/)
  })

  it('an extra token account, even one of the person’s own', async () => {
    await expect(
      checkTampered((m) =>
        withExtra(
          m,
          ASSOCIATED_TOKEN_PROGRAM,
          [
            ACCOUNT,
            associatedTokenAccount(ACCOUNT, USDT),
            ACCOUNT,
            USDT,
            SYSTEM_PROGRAM,
            TOKEN_PROGRAM,
          ],
          [1]
        )
      )
    ).rejects.toThrow(/not the stream/)
  })

  it('a second stream in the same transaction', async () => {
    await expect(
      checkTampered((m) => {
        const call = m.instructions[m.instructions.length - 1]
        return { ...m, instructions: [...m.instructions, call as Message['instructions'][number]] }
      })
    ).rejects.toThrow(/not the stream/)
  })

  it('a compute budget instruction after the call', async () => {
    await expect(
      checkTampered((m) => {
        const [first, second, call] = m.instructions
        return {
          ...m,
          instructions: [first, call, second] as unknown as Message['instructions'],
        }
      })
    ).rejects.toThrow(/not the stream/)
  })

  it('a huge priority fee', async () => {
    await expect(
      checkTampered((m) => ({
        ...m,
        instructions: m.instructions.map((ix, i) =>
          i === 1 ? { ...ix, data: Uint8Array.from([3, ...le(BigInt(1_000_000_000_000), 8)]) } : ix
        ),
      }))
    ).rejects.toThrow(/priority fee/)
  })

  it('accounts behind a lookup table', async () => {
    await expect(
      checkTampered((m) => ({
        ...m,
        version: 0,
        addressTableLookups: [
          {
            lookupTableAddress: ATTACKER as Address,
            writableIndexes: [0],
            readonlyIndexes: [],
          },
        ],
      }))
    ).rejects.toThrow(/lookup table/)
  })
})

describe('the Streamflow listing', () => {
  it('makes no claim the browser can’t know, since running depends on a server secret', () => {
    expect(streamflowVenue).toMatchObject({
      id: 'streamflow',
      family: 'solana',
      chains: ['Solana'],
      category: 'payments',
    })
    expect(streamflowVenue.integration).toBeUndefined()
    expect(streamflowVenue.capability).toBeUndefined()
    expect(streamflowVenue.bestFor).toMatch(/fee in SOL/)
  })
})
