import {
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
  STREAMFLOW_PROGRAM,
  STREAMFLOW_TREASURY,
  type SolanaRpc,
} from '../chains/solana/streamflow'
import { SOLANA_TOKENS } from '../chains/solana/tokens'
import { ChainActionRefused, type ChainActionRequest, type PreparedAction } from '../chains/types'

const ACCOUNT = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
const RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const ATTACKER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const STREAM_ID = 'CatzoSMUkTRidT5DwBxAC2pEtnwMBTpkCepHkFgZDiqb'
const OTHER_STREAM = 'SLaYv7tCwetrFGbPCRnqpHswG5qqKino78EYpbGF7xY'
const ESCROW = 'Brh9rB6npnjM1vDXyCXtzkXVGRnsh6KHqmBz26tVACg9'
const USDC = SOLANA_TOKENS.find((t) => t.symbol === 'USDC')?.id as string
const USDT = SOLANA_TOKENS.find((t) => t.symbol === 'USDT')?.id as string
const JITOSOL = SOLANA_TOKENS.find((t) => t.symbol === 'JitoSOL')?.id as string
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const BLOCKHASH = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn'
const SECRET = 'a-secret-long-enough-to-sign-with-here'
/** `sha256("global:cancel")`, first eight bytes, then the ten empty bytes the SDK sends. */
const CANCEL_DATA = `e8dbdf29dbecdcbe${'00'.repeat(10)}`

const NOW = 1_800_000_000
const HOUR = 3600
const CANCEL: ChainActionRequest = {
  kind: 'cancel',
  amount: 'all',
  tokenIn: 'STREAM',
  streamId: STREAM_ID,
}

interface StreamFields {
  sender: string
  recipient: string
  mint: string
  escrow: string
  treasury: string
  partner: string
  deposited: bigint
  period: bigint
  perPeriod: bigint
  cliff: bigint
  cliffAmount: bigint
  end: bigint
  canceledAt: bigint
  cancelableBySender: number
  closed: number
}

/** A stream's account, at the offsets of the SDK's `streamLayout` and `constants.ts`. */
function streamBytes(overrides: Partial<StreamFields> = {}): Buffer {
  const fields: StreamFields = {
    sender: ACCOUNT,
    recipient: RECIPIENT,
    mint: USDC,
    escrow: ESCROW,
    treasury: STREAMFLOW_TREASURY,
    partner: ACCOUNT,
    deposited: BigInt(100_000_000),
    period: BigInt(HOUR),
    perPeriod: BigInt(1_000_000),
    cliff: BigInt(NOW - 10 * HOUR),
    cliffAmount: BigInt(0),
    end: BigInt(NOW + 90 * HOUR),
    canceledAt: BigInt(0),
    cancelableBySender: 1,
    closed: 0,
    ...overrides,
  }
  const buffer = Buffer.alloc(1104)
  const put = (at: number, value: string): void => {
    buffer.set(getAddressEncoder().encode(value as Address), at)
  }
  buffer.writeBigUInt64LE(fields.canceledAt, 25)
  buffer.writeBigUInt64LE(fields.end, 33)
  put(49, fields.sender)
  put(113, fields.recipient)
  put(177, fields.mint)
  put(209, fields.escrow)
  put(241, fields.treasury)
  put(325, fields.partner)
  buffer.writeBigUInt64LE(fields.deposited, 417)
  buffer.writeBigUInt64LE(fields.period, 425)
  buffer.writeBigUInt64LE(fields.perPeriod, 433)
  buffer.writeBigUInt64LE(fields.cliff, 441)
  buffer.writeBigUInt64LE(fields.cliffAmount, 449)
  buffer.writeUInt8(fields.cancelableBySender, 457)
  buffer.writeUInt8(fields.closed, 671)
  return buffer
}

function tokenAccount(amount: bigint): Buffer {
  const buffer = Buffer.alloc(165)
  buffer.writeBigUInt64LE(amount, 64)
  return buffer
}

interface FakeChain {
  stream?: Buffer | null
  streamOwner?: string
  before?: bigint
  after?: bigint
  simulationError?: unknown
  unreadable?: readonly string[]
  listed?: readonly { pubkey: string; data: Buffer; owner?: string }[]
}

function fakeRpc(
  chain: FakeChain = {}
): SolanaRpc & { seen: { method: string; params: unknown[] }[] } {
  const seen: { method: string; params: unknown[] }[] = []
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    seen.push({ method, params })
    if (chain.unreadable?.includes(method) === true) return undefined
    switch (method) {
      case 'getAccountInfo': {
        const address = params[0] as string
        if (address === STREAM_ID) {
          const data = chain.stream === undefined ? streamBytes() : chain.stream
          return {
            result: {
              value:
                data === null
                  ? null
                  : {
                      owner: chain.streamOwner ?? STREAMFLOW_PROGRAM,
                      data: [data.toString('base64'), 'base64'],
                    },
            },
          }
        }
        return {
          result: {
            value: {
              owner: TOKEN_PROGRAM,
              data: [tokenAccount(chain.before ?? BigInt(5_000_000)).toString('base64'), 'base64'],
            },
          },
        }
      }
      case 'getLatestBlockhash':
        return { result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 400 } } }
      case 'simulateTransaction':
        return {
          result: {
            value: {
              err: chain.simulationError ?? null,
              accounts: [
                {
                  data: [
                    tokenAccount(chain.after ?? BigInt(95_000_000)).toString('base64'),
                    'base64',
                  ],
                },
              ],
            },
          },
        }
      case 'getProgramAccounts':
        return {
          result: (chain.listed ?? []).map(({ pubkey, data, owner }) => ({
            pubkey,
            account: {
              owner: owner ?? STREAMFLOW_PROGRAM,
              data: [data.toString('base64'), 'base64'],
            },
          })),
        }
      default:
        throw new Error(`Unexpected ${method}`)
    }
  }
  return Object.assign(rpc, { seen })
}

const venueOver = (chain?: FakeChain) =>
  createStreamflowVenue({ rpc: fakeRpc(chain), indexedRpc: fakeRpc(chain), now: () => NOW * 1000 })

const venue = venueOver()
const prepared = (chain?: FakeChain, ask: ChainActionRequest = CANCEL): Promise<PreparedAction> =>
  venueOver(chain).prepare(ask, ACCOUNT)

function transactionOf(action: PreparedAction): string {
  if (action.signing.family !== 'solana') throw new Error('Expected a Solana payload.')
  return action.signing.transaction
}

interface Message {
  header: {
    numSignerAccounts: number
    numReadonlySignerAccounts: number
    numReadonlyNonSignerAccounts: number
  }
  staticAccounts: readonly Address[]
  instructions: readonly {
    programAddressIndex: number
    accountIndices?: readonly number[]
    data?: Uint8Array
  }[]
}

function open(base64: string): Message {
  const { messageBytes } = getTransactionDecoder().decode(Buffer.from(base64, 'base64'))
  return getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as Message
}

function close(message: Message): string {
  const bytes = getCompiledTransactionMessageEncoder().encode(
    message as unknown as Parameters<
      ReturnType<typeof getCompiledTransactionMessageEncoder>['encode']
    >[0]
  )
  const count = message.header.numSignerAccounts
  return Buffer.concat([
    Buffer.from([count]),
    Buffer.alloc(64 * count),
    Buffer.from(bytes),
  ]).toString('base64')
}

async function checkTampered(change: (message: Message) => Message): Promise<void> {
  const action = await prepared()
  venue.assertSafe(
    { family: 'solana', transaction: close(change(open(transactionOf(action)))) },
    ACCOUNT,
    action.context
  )
}

function swapAccount(message: Message, from: string, to: string): Message {
  expect(message.staticAccounts).toContain(from)
  return {
    ...message,
    staticAccounts: message.staticAccounts.map((a) => (a === from ? (to as Address) : a)),
  }
}

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', SECRET)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Streamflow cancel builds', () => {
  it('one cancel from the person, with the accounts in the SDK’s order', async () => {
    const action = await prepared()
    const decoded = decodeSolanaTransaction(transactionOf(action))
    expect(decoded.feePayer).toBe(ACCOUNT)
    expect(decoded.signerCount).toBe(1)
    const programs = decoded.instructions.map((ix) => decoded.staticAccounts[ix.programIndex])
    expect(programs).toEqual([
      COMPUTE_BUDGET,
      COMPUTE_BUDGET,
      ASSOCIATED_TOKEN_PROGRAM,
      STREAMFLOW_PROGRAM,
    ])
    const call = decoded.instructions[3]
    expect(Buffer.from(call?.data ?? []).toString('hex')).toBe(CANCEL_DATA)
    expect(call?.accounts.map((i) => decoded.staticAccounts[i])).toEqual([
      ACCOUNT,
      ACCOUNT,
      associatedTokenAccount(ACCOUNT, USDC),
      RECIPIENT,
      associatedTokenAccount(RECIPIENT, USDC),
      STREAM_ID,
      ESCROW,
      STREAMFLOW_TREASURY,
      associatedTokenAccount(STREAMFLOW_TREASURY, USDC),
      ACCOUNT,
      associatedTokenAccount(ACCOUNT, USDC),
      USDC,
      TOKEN_PROGRAM,
    ])
  })

  it('reopens the person’s own token account first, since a closed one would block the refund', async () => {
    const action = await prepared()
    const decoded = decodeSolanaTransaction(transactionOf(action))
    const open = decoded.instructions[2]
    expect([...(open?.data ?? [])]).toEqual([1])
    expect(open?.accounts.map((i) => decoded.staticAccounts[i])).toEqual([
      ACCOUNT,
      associatedTokenAccount(ACCOUNT, USDC),
      ACCOUNT,
      USDC,
      SYSTEM_PROGRAM,
      TOKEN_PROGRAM,
    ])
    expect(action.notes.join(' ')).toMatch(/reopens/)
  })

  it('counts the whole refund when that account was closed', async () => {
    const rpc = fakeRpc({ after: BigInt(90_000_000) })
    const closed: SolanaRpc = async (method, params) =>
      method === 'getAccountInfo' && params[0] !== STREAM_ID
        ? { result: { value: null } }
        : rpc(method, params)
    const action = await createStreamflowVenue({ rpc: closed, now: () => NOW * 1000 }).prepare(
      CANCEL,
      ACCOUNT
    )
    expect(action.pay.amount).toBe('90')
  })

  it('names the partner the stream recorded, whose fee this is', async () => {
    const action = await prepared({ stream: streamBytes({ partner: STREAMFLOW_TREASURY }) })
    const decoded = decodeSolanaTransaction(transactionOf(action))
    const accounts = decoded.instructions[3]?.accounts.map((i) => decoded.staticAccounts[i])
    expect(accounts?.[9]).toBe(STREAMFLOW_TREASURY)
    expect(accounts?.[10]).toBe(associatedTokenAccount(STREAMFLOW_TREASURY, USDC))
    expect(() => venue.assertSafe(action.signing, ACCOUNT, action.context)).not.toThrow()
  })

  it('shows what the dry run says comes back, and says who gets the rest', async () => {
    const action = await prepared()
    expect(action.kind).toBe('cancel')
    expect(action.venueId).toBe('streamflow')
    expect(action.pay).toEqual({ amount: '90', symbol: 'USDC' })
    expect(action.receive).toEqual({ amount: '90', symbol: 'USDC', approximate: true })
    const notes = action.notes.join(' ')
    expect(notes).toContain(RECIPIENT)
    expect(notes).toContain(STREAM_ID)
    expect(notes).toMatch(/hour/)
    expect(notes).not.toContain('—')
  })

  it('passes its own check, unsigned and signed', async () => {
    const action = await prepared()
    expect(() => venue.assertSafe(action.signing, ACCOUNT, action.context)).not.toThrow()
    const signed = Buffer.from(transactionOf(action), 'base64')
    signed.fill(7, 1, 65)
    expect(() =>
      venue.assertSafe(
        { family: 'solana', transaction: signed.toString('base64') },
        ACCOUNT,
        action.context
      )
    ).not.toThrow()
  })

  it('tells the person a new stream’s id and that this app can cancel it', async () => {
    const rpc: SolanaRpc = async (method) => {
      if (method === 'getAccountInfo') return { result: { value: null } }
      if (method === 'getLatestBlockhash') {
        return { result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 400 } } }
      }
      const written = streamBytes()
      written.writeBigUInt64LE(BigInt(190_000), 305)
      written.writeUInt32LE(160_000_000, 704)
      return {
        result: {
          value: { err: null, accounts: [{ data: [written.toString('base64'), 'base64'] }] },
        },
      }
    }
    const action = await createStreamflowVenue({ rpc }).prepare(
      { kind: 'stream', amount: '100', tokenIn: 'USDC', recipient: RECIPIENT, durationDays: '30' },
      ACCOUNT
    )
    const decoded = decodeSolanaTransaction(transactionOf(action))
    const id = decoded.staticAccounts[decoded.instructions[2]?.accounts[3] as number]
    expect(action.notes.join(' ')).toContain(`"cancel stream ${id}"`)
    expect(action.notes.join(' ')).not.toMatch(/can.t cancel for you/)
  })
})

describe('Streamflow cancel refuses', () => {
  it.each<[string, FakeChain, RegExp]>([
    [
      'a stream someone else started',
      { stream: streamBytes({ sender: ATTACKER }) },
      /didn’t start/,
    ],
    [
      'a stream paying this wallet',
      { stream: streamBytes({ sender: ATTACKER, recipient: ACCOUNT }) },
      /didn’t start/,
    ],
    [
      'one that can’t be cancelled',
      { stream: streamBytes({ cancelableBySender: 0 }) },
      /can’t be cancelled/,
    ],
    ['one already closed', { stream: streamBytes({ closed: 1 }) }, /already ended/],
    [
      'one already cancelled',
      { stream: streamBytes({ canceledAt: BigInt(NOW - 1) }) },
      /already ended/,
    ],
    [
      'one naming another treasury',
      { stream: streamBytes({ treasury: ATTACKER }) },
      /Streamflow’s own/,
    ],
    [
      'one in a token not streamed here',
      { stream: streamBytes({ mint: JITOSOL }) },
      /USDC or USDT/,
    ],
    ['one that isn’t there', { stream: null }, /no stream/i],
    ['an account of another program', { streamOwner: TOKEN_PROGRAM }, /no stream/i],
    ['an account too short to be a stream', { stream: Buffer.alloc(100) }, /no stream/i],
    [
      'what would fail on the chain',
      { simulationError: { InstructionError: [2, 'x'] } },
      /would fail/,
    ],
    ['nothing coming back in the dry run', { after: BigInt(5_000_000) }, /nothing back/],
    ['an unreadable stream', { unreadable: ['getAccountInfo'] }, /could not be read/],
    ['no blockhash', { unreadable: ['getLatestBlockhash'] }, /could not be read/],
    ['no dry run', { unreadable: ['simulateTransaction'] }, /could not be read/],
  ])('%s', async (_name, chain, wanted) => {
    const attempt = prepared(chain)
    await expect(attempt).rejects.toThrow(wanted)
    await expect(attempt).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(attempt).rejects.toThrow(/Nothing was signed or sent/)
  })

  it.each<[string, string | undefined]>([
    ['no id', undefined],
    ['an id that is not an address', 'not-a-stream'],
  ])('%s', async (_name, streamId) => {
    await expect(prepared({}, { ...CANCEL, streamId })).rejects.toThrow(/stream’s id/)
  })

  it('a wallet that is not a Solana address', async () => {
    await expect(venue.prepare(CANCEL, '0x1234')).rejects.toThrow(/Solana wallet/)
  })

  it('without a secret to prove what it issued, and says where else to go', async () => {
    vi.stubEnv('AUTH_SECRET', '')
    await expect(prepared()).rejects.toThrow(/app\.streamflow\.finance/)
  })
})

describe('Streamflow cancel assertSafe refuses', () => {
  it('no proof, a forged one, or a proof for another stream or person', async () => {
    const action = await prepared()
    const context = action.context as Record<string, string>
    const check = (changed: Record<string, string> | undefined): void =>
      venue.assertSafe(action.signing, ACCOUNT, changed)
    expect(() => check(undefined)).toThrow(/not what this app issued/)
    expect(() => check({ ...context, proof: 'forged' })).toThrow(/not what this app issued/)
    expect(() => check({ ...context, stream: OTHER_STREAM })).toThrow(/not what this app issued/)
    expect(() => check({ ...context, recipient: ATTACKER })).toThrow(/not what this app issued/)
    expect(() => check({ ...context, partner: ATTACKER })).toThrow(/not what this app issued/)
    expect(() => check({ ...context, token: USDT })).toThrow(/not what this app issued/)
    expect(() => check({ ...context, escrow: ATTACKER })).toThrow(/not what this app issued/)
    expect(() => venue.assertSafe(action.signing, RECIPIENT, context)).toThrow(ChainActionRefused)
  })

  it('a stream’s proof used for a cancel, or a cancel’s for a stream', async () => {
    const cancel = await prepared()
    const proof = (cancel.context as Record<string, string>)['proof'] as string
    expect(() =>
      venue.assertSafe(cancel.signing, ACCOUNT, {
        recipient: RECIPIENT,
        token: USDC,
        amount: '1',
        days: '1',
        proof,
      })
    ).toThrow(/not what this app issued/)
  })

  it.each<[string, () => string]>([
    ['the person’s token account', () => associatedTokenAccount(ACCOUNT, USDC)],
    ['the recipient', () => RECIPIENT],
    ['the recipient’s token account', () => associatedTokenAccount(RECIPIENT, USDC)],
    ['the stream', () => STREAM_ID],
    ['the escrow', () => ESCROW],
    ['the treasury', () => STREAMFLOW_TREASURY],
    ['the treasury’s token account', () => associatedTokenAccount(STREAMFLOW_TREASURY, USDC)],
    ['the mint', () => USDC],
  ])('%s swapped for an attacker’s', async (_name, from) => {
    await expect(checkTampered((m) => swapAccount(m, from(), ATTACKER))).rejects.toThrow(
      /not the stream/
    )
  })

  it('another program', async () => {
    await expect(
      checkTampered((m) =>
        swapAccount(m, STREAMFLOW_PROGRAM, 'strmdbLr6w7QNmsiEXyFwWg3VSfg1GiELgU27P8aCGw')
      )
    ).rejects.toThrow(/should not need/)
  })

  it('another of the program’s instructions, which a stream’s create would be', async () => {
    await expect(
      checkTampered((m) => ({
        ...m,
        instructions: m.instructions.map((ix, i) =>
          i === m.instructions.length - 1
            ? {
                ...ix,
                data: Uint8Array.from(Buffer.from(`d6904cec5f8b31b4${'00'.repeat(10)}`, 'hex')),
              }
            : ix
        ),
      }))
    ).rejects.toThrow(/didn.t expect/)
  })

  it('extra or short instruction data', async () => {
    const last = (m: Message): Uint8Array => m.instructions.at(-1)?.data as Uint8Array
    const withData = (m: Message, data: Uint8Array): Message => ({
      ...m,
      instructions: m.instructions.map((ix, i) =>
        i === m.instructions.length - 1 ? { ...ix, data } : ix
      ),
    })
    await expect(
      checkTampered((m) => withData(m, Uint8Array.from([...last(m), 1])))
    ).rejects.toThrow(/not the stream/)
    await expect(checkTampered((m) => withData(m, last(m).subarray(0, 8)))).rejects.toThrow(
      /not the stream/
    )
  })

  it('a second cancel in the same transaction', async () => {
    await expect(
      checkTampered((m) => ({
        ...m,
        instructions: [...m.instructions, m.instructions.at(-1) as Message['instructions'][number]],
      }))
    ).rejects.toThrow(/not the stream/)
  })

  it('a second signer', async () => {
    await expect(
      checkTampered((m) => ({ ...m, header: { ...m.header, numSignerAccounts: 2 } }))
    ).rejects.toThrow(/someone other than you/)
  })

  it('no token account step, or that step alone', async () => {
    await expect(
      checkTampered((m) => ({
        ...m,
        instructions: m.instructions.filter((_, i) => i !== m.instructions.length - 2),
      }))
    ).rejects.toThrow(/not the stream/)
    await expect(
      checkTampered((m) => ({ ...m, instructions: m.instructions.slice(0, -1) }))
    ).rejects.toThrow(/not the stream/)
  })

  it('a token account opened for another token', async () => {
    await expect(
      checkTampered((m) => {
        const grown: Message = {
          ...m,
          header: {
            ...m.header,
            numReadonlyNonSignerAccounts: m.header.numReadonlyNonSignerAccounts + 1,
          },
          staticAccounts: [...m.staticAccounts, USDT as Address],
        }
        const usdt = grown.staticAccounts.length - 1
        const usdc = grown.staticAccounts.indexOf(USDC as Address)
        return {
          ...grown,
          instructions: grown.instructions.map((ix, i) =>
            i === grown.instructions.length - 2
              ? {
                  ...ix,
                  accountIndices: (ix.accountIndices ?? []).map((a) => (a === usdc ? usdt : a)),
                }
              : ix
          ),
        }
      })
    ).rejects.toThrow(/not the stream/)
  })
})

describe('Streamflow positions', () => {
  const row = (pubkey: string, overrides: Partial<StreamFields> = {}, owner?: string) => ({
    pubkey,
    data: streamBytes(overrides),
    ...(owner === undefined ? {} : { owner }),
  })

  it('lists what hasn’t streamed yet, under the stream’s id and token', async () => {
    const positions = await venueOver({
      listed: [
        row(STREAM_ID),
        row(OTHER_STREAM, { mint: USDT, deposited: BigInt(50_000_000), perPeriod: BigInt(0) }),
      ],
    }).positions?.(ACCOUNT)
    expect(positions).toEqual([
      { slot: 'supplied', symbol: 'USDC', amount: '90', id: STREAM_ID },
      { slot: 'supplied', symbol: 'USDT', amount: '50', id: OTHER_STREAM },
    ])
  })

  it('asks the chain for only this account’s streams, by the sender’s offset', async () => {
    const rpc = fakeRpc({ listed: [] })
    await createStreamflowVenue({ rpc, indexedRpc: rpc }).positions?.(ACCOUNT)
    const asked = rpc.seen.find((call) => call.method === 'getProgramAccounts')
    expect(asked?.params[0]).toBe(STREAMFLOW_PROGRAM)
    expect(JSON.stringify(asked?.params[1])).toContain(
      `{"memcmp":{"offset":49,"bytes":"${ACCOUNT}"}}`
    )
  })

  it.each<[string, Partial<StreamFields>, string?]>([
    ['closed', { closed: 1 }],
    ['cancelled', { canceledAt: BigInt(NOW - 1) }],
    ['finished', { end: BigInt(NOW - 1) }],
    ['not cancellable', { cancelableBySender: 0 }],
    ['in a token not streamed here', { mint: JITOSOL }],
    ['started by someone else, whatever the node says', { sender: ATTACKER }],
    ['not the program’s', {}, TOKEN_PROGRAM],
  ])('leaves out a stream that is %s', async (_name, overrides, owner) => {
    await expect(
      venueOver({ listed: [row(STREAM_ID, overrides, owner)] }).positions?.(ACCOUNT)
    ).resolves.toEqual([])
  })

  it('counts nothing as unlocked before the cliff, and the cliff amount after it', async () => {
    const before = await venueOver({
      listed: [row(STREAM_ID, { cliff: BigInt(NOW + 10) })],
    }).positions?.(ACCOUNT)
    expect(before?.[0]?.amount).toBe('100')
    const after = await venueOver({
      listed: [row(STREAM_ID, { cliff: BigInt(NOW), cliffAmount: BigInt(25_000_000) })],
    }).positions?.(ACCOUNT)
    expect(after?.[0]?.amount).toBe('75')
  })

  it('shows nothing for a wallet with no streams', async () => {
    await expect(venueOver({ listed: [] }).positions?.(ACCOUNT)).resolves.toEqual([])
  })

  it('falls back to a node that answers when the configured one refuses this read', async () => {
    const refused = fakeRpc({ unreadable: ['getProgramAccounts'] })
    const answers = fakeRpc({ listed: [row(STREAM_ID)] })
    const positions = await createStreamflowVenue({
      rpc: refused,
      indexedRpc: answers,
      now: () => NOW * 1000,
    }).positions?.(ACCOUNT)
    expect(positions).toHaveLength(1)
  })

  it('throws, and never shows nothing, when no node will answer', async () => {
    const refused = fakeRpc({ unreadable: ['getProgramAccounts'] })
    await expect(
      createStreamflowVenue({ rpc: refused, indexedRpc: refused }).positions?.(ACCOUNT)
    ).rejects.toThrow(/could not be read/)
  })

  it('throws on a wallet that is not an address', async () => {
    await expect(venue.positions?.('0x1234')).rejects.toThrow(/Solana wallet/)
  })
})
