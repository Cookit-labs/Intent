import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getU32Encoder,
  getU64Decoder,
  getU64Encoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
} from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAccount,
  decodeSolanaTransaction,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from '../chains/solana/assert-safe'
import { SOLANA_TOKENS } from '../chains/solana/tokens'
import { ChainActionRefused } from '../chains/types'
import { solanaDeposit } from '../weave/deposit/solana'
import type { DepositExpectation } from '../weave/types'

// The real submit, without the minute of polling it would otherwise wait through.
vi.mock('../chains/solana/submit', async (original) => {
  const actual = await original<typeof import('../chains/solana/submit')>()
  return {
    ...actual,
    createSolanaSubmit: () => actual.createSolanaSubmit({ pollMs: 0, maxPolls: 1, env: {} }),
  }
})

const ACCOUNT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const DEPOSIT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const OTHER = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'
const USDC = SOLANA_TOKENS.find((t) => t.symbol === 'USDC')?.id as string
const USDT = SOLANA_TOKENS.find((t) => t.symbol === 'USDT')?.id as string
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi'

const BASE_UNITS = BigInt(25_500_000)
const EXPECTATION: DepositExpectation = {
  account: ACCOUNT,
  depositAddress: DEPOSIT,
  memo: undefined,
  amount: '25.5',
}

interface Instruction {
  programAddress: string
  accounts: readonly { address: string; role: AccountRole }[]
  data: Uint8Array
}

function compile(
  instructions: readonly Instruction[],
  options: { feePayer?: string; version?: 0 | 'legacy' } = {}
): string {
  const message = pipe(
    createTransactionMessage({ version: options.version ?? 0 }),
    (m) => setTransactionMessageFeePayer((options.feePayer ?? ACCOUNT) as Address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: BigInt(1) },
        m
      ),
    (m) => appendTransactionMessageInstructions(instructions as never, m)
  )
  return getBase64EncodedWireTransaction(compileTransaction(message as never))
}

function transferData(amount: bigint, tag = 12, decimals = 6): Uint8Array {
  return Uint8Array.from([tag, ...getU64Encoder().encode(amount), decimals])
}

function transfer(
  fields: {
    source?: string
    mint?: string
    destination?: string
    owner?: string
    amount?: bigint
    tag?: number
    decimals?: number
    extraAccount?: string
  } = {}
): Instruction {
  const accounts = [
    {
      address: fields.source ?? associatedTokenAccount(ACCOUNT, USDC),
      role: AccountRole.WRITABLE,
    },
    { address: fields.mint ?? USDC, role: AccountRole.READONLY },
    {
      address: fields.destination ?? associatedTokenAccount(DEPOSIT, USDC),
      role: AccountRole.WRITABLE,
    },
    { address: fields.owner ?? ACCOUNT, role: AccountRole.READONLY_SIGNER },
  ]
  if (fields.extraAccount !== undefined) {
    accounts.push({ address: fields.extraAccount, role: AccountRole.READONLY })
  }
  return {
    programAddress: TOKEN_PROGRAM,
    accounts,
    data: transferData(fields.amount ?? BASE_UNITS, fields.tag, fields.decimals),
  }
}

function createAta(
  fields: {
    payer?: string
    ata?: string
    owner?: string
    mint?: string
    system?: string
    token?: string
    data?: readonly number[]
  } = {}
): Instruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      { address: fields.payer ?? ACCOUNT, role: AccountRole.WRITABLE_SIGNER },
      { address: fields.ata ?? associatedTokenAccount(DEPOSIT, USDC), role: AccountRole.WRITABLE },
      { address: fields.owner ?? DEPOSIT, role: AccountRole.READONLY },
      { address: fields.mint ?? USDC, role: AccountRole.READONLY },
      { address: fields.system ?? SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: fields.token ?? TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: Uint8Array.from(fields.data ?? [1]),
  }
}

function setLimit(units: number): Instruction {
  return {
    programAddress: COMPUTE_BUDGET,
    accounts: [],
    data: Uint8Array.from([2, ...getU32Encoder().encode(units)]),
  }
}

function setPrice(microLamports: bigint): Instruction {
  return {
    programAddress: COMPUTE_BUDGET,
    accounts: [],
    data: Uint8Array.from([3, ...getU64Encoder().encode(microLamports)]),
  }
}

type Message = ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>

function openMessage(base64: string): Message {
  const { messageBytes } = getTransactionDecoder().decode(Buffer.from(base64, 'base64'))
  return getCompiledTransactionMessageDecoder().decode(messageBytes)
}

function closeMessage(message: unknown): string {
  const bytes = getCompiledTransactionMessageEncoder().encode(message as never)
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(bytes)]).toString('base64')
}

function check(transaction: string, expectation = EXPECTATION): void {
  solanaDeposit.assertSafe({ family: 'solana', transaction }, expectation)
}

function refused(transaction: string, reason: RegExp): void {
  let caught: unknown
  try {
    check(transaction)
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(ChainActionRefused)
  expect((caught as Error).message).toMatch(reason)
  expect((caught as Error).message).toMatch(/nothing was signed or sent\.$/i)
}

interface RpcAnswers {
  /** SOL held by the account, in lamports. Plenty unless a test says otherwise. */
  lamports?: number
  /** USDC held, in base units, or null for no token account at all. */
  usdc?: bigint | null
  /** Whether the deposit address already has its USDC account. */
  payoutAccountExists?: boolean
  account?: unknown
  blockhash?: unknown
  send?: () => unknown
  statuses?: unknown
  isValid?: boolean
}

function stubRpc(answers: RpcAnswers = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as {
      method: string
      params: unknown[]
    }
    const asked = params?.[0]
    const usdc = answers.usdc === undefined ? BigInt(1_000_000_000) : answers.usdc
    const accountInfo =
      asked === associatedTokenAccount(ACCOUNT, USDC)
        ? {
            result: {
              context: { slot: 1 },
              value:
                usdc === null
                  ? null
                  : {
                      owner: TOKEN_PROGRAM,
                      data: {
                        parsed: { info: { tokenAmount: { amount: String(usdc), decimals: 6 } } },
                      },
                    },
            },
          }
        : asked === associatedTokenAccount(DEPOSIT, USDC)
          ? {
              result: {
                context: { slot: 1 },
                value: answers.payoutAccountExists === true ? { owner: TOKEN_PROGRAM } : null,
              },
            }
          : (answers.account ?? { result: { context: { slot: 1 }, value: null } })
    const replies: Record<string, unknown> = {
      getAccountInfo: accountInfo,
      getBalance: { result: { context: { slot: 1 }, value: answers.lamports ?? 1_000_000_000 } },
      getLatestBlockhash: answers.blockhash ?? {
        result: {
          context: { slot: 1 },
          value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 },
        },
      },
      sendTransaction: answers.send?.() ?? { result: 'sent' },
      getSignatureStatuses: answers.statuses ?? {
        result: { value: [{ confirmationStatus: 'confirmed', err: null }] },
      },
      isBlockhashValid: { result: { value: answers.isValid ?? true } },
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(replies[method] as object) }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function rpcMethods(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(
    ([, init]) => (JSON.parse(String((init as RequestInit).body)) as { method: string }).method
  )
}

/** Fills the fee payer's signature slot, standing in for a wallet. No key is involved. */
function signed(base64: string): string {
  const bytes = Buffer.from(base64, 'base64')
  bytes.fill(7, 1, 65)
  return bytes.toString('base64')
}

beforeEach(() => {
  vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.example.test')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('what a deposit declares', () => {
  it('is USDC with six places and no memo', () => {
    expect(solanaDeposit.chain).toBe('solana')
    expect(solanaDeposit.usdcDecimals).toBe(6)
    expect(solanaDeposit.supportsMemo).toBe(false)
  })

  it('takes Solana addresses only', () => {
    expect(solanaDeposit.isAccount(ACCOUNT)).toBe(true)
    expect(solanaDeposit.isDepositAddress(DEPOSIT)).toBe(true)
    expect(solanaDeposit.isAccount('not-an-address')).toBe(false)
    expect(solanaDeposit.isDepositAddress('0xabc')).toBe(false)
  })
})

describe('assertSafe admits the one shape', () => {
  it.each([
    ['a bare transfer', [transfer()], 0],
    ['a legacy message', [transfer()], 'legacy'],
    ['with an idempotent account creation', [createAta(), transfer()], 0],
    [
      'with both compute budget settings',
      [setLimit(100_000), setPrice(BigInt(1_000)), createAta(), transfer()],
      0,
    ],
  ] as const)('%s', (_name, instructions, version) => {
    expect(() => check(compile(instructions, { version }))).not.toThrow()
  })
})

describe('assertSafe refuses', () => {
  it('a different recipient', () => {
    refused(
      compile([transfer({ destination: associatedTokenAccount(OTHER, USDC) })]),
      /deposit address/
    )
  })

  it('the deposit wallet itself as the destination, which is not its token account', () => {
    refused(compile([transfer({ destination: DEPOSIT })]), /deposit address/)
  })

  it('a different amount, one unit either way', () => {
    refused(compile([transfer({ amount: BASE_UNITS + BigInt(1) })]), /amount/)
    refused(compile([transfer({ amount: BASE_UNITS - BigInt(1) })]), /amount/)
  })

  it('a different token', () => {
    refused(
      compile([
        transfer({
          mint: USDT,
          source: associatedTokenAccount(ACCOUNT, USDT),
          destination: associatedTokenAccount(DEPOSIT, USDT),
        }),
      ]),
      /USDC/
    )
  })

  it('the right accounts with a different mint named', () => {
    refused(compile([transfer({ mint: USDT })]), /USDC/)
  })

  it('wrong decimals', () => {
    refused(compile([transfer({ decimals: 9 })]), /USDC/)
  })

  it('a plain Transfer, which does not name a mint', () => {
    refused(compile([transfer({ tag: 3 })]), /token/i)
  })

  it('an approve hidden under the Token Program', () => {
    refused(compile([transfer(), { ...transfer(), data: Uint8Array.from([4, 0]) }]), /token/i)
  })

  it('an extra transfer', () => {
    refused(compile([transfer(), transfer()]), /one/)
    refused(
      compile([transfer({ amount: BigInt(1), destination: OTHER }), transfer()]),
      /deposit address|one/
    )
  })

  it('a SOL transfer alongside', () => {
    const sol: Instruction = {
      programAddress: SYSTEM_PROGRAM,
      accounts: [
        { address: ACCOUNT, role: AccountRole.WRITABLE_SIGNER },
        { address: OTHER, role: AccountRole.WRITABLE },
      ],
      data: Uint8Array.from([
        ...getU32Encoder().encode(2),
        ...getU64Encoder().encode(BigInt(1_000)),
      ]),
    }
    refused(compile([sol, transfer()]), /program/)
  })

  it('an unknown program', () => {
    const unknown: Instruction = {
      programAddress: OTHER,
      accounts: [],
      data: Uint8Array.from([1]),
    }
    refused(compile([unknown, transfer()]), /program/)
  })

  it('a memo instruction', () => {
    const memo: Instruction = {
      programAddress: MEMO_PROGRAM,
      accounts: [],
      data: Uint8Array.from([104, 105]),
    }
    refused(compile([transfer(), memo]), /program/)
  })

  it('a different fee payer', () => {
    refused(compile([transfer()], { feePayer: OTHER }), /fee/)
  })

  it('a second signer', () => {
    const second = transfer({
      extraAccount: OTHER,
    })
    const accounts = second.accounts.map((a) =>
      a.address === OTHER ? { ...a, role: AccountRole.READONLY_SIGNER } : a
    )
    refused(compile([{ ...second, accounts }]), /signature/)
  })

  it('a transfer signed by someone else, from their account', () => {
    refused(compile([transfer({ owner: OTHER })]), /signature|your wallet/)
    refused(
      compile([transfer({ source: associatedTokenAccount(OTHER, USDC) })]),
      /your USDC account/
    )
  })

  it('a transfer carrying extra accounts', () => {
    refused(compile([transfer({ extraAccount: OTHER })]), /token/i)
  })

  it('an account created for someone other than the deposit address', () => {
    refused(
      compile([createAta({ owner: OTHER, ata: associatedTokenAccount(OTHER, USDC) }), transfer()]),
      /account creation/
    )
  })

  it('an account created for a different mint', () => {
    refused(
      compile([createAta({ mint: USDT, ata: associatedTokenAccount(DEPOSIT, USDT) }), transfer()]),
      /account creation/
    )
  })

  it('an account creation someone else pays for', () => {
    const creation = createAta({ payer: OTHER })
    refused(compile([creation, transfer()]), /signature|account creation/)
  })

  it('an account creation under another token program', () => {
    refused(compile([createAta({ token: TOKEN_2022 }), transfer()]), /account creation/)
  })

  it('a non-idempotent creation, which fails if the account exists', () => {
    refused(compile([createAta({ data: [0] }), transfer()]), /account creation/)
    refused(compile([createAta({ data: [] }), transfer()]), /account creation/)
  })

  it('two account creations', () => {
    refused(compile([createAta(), createAta(), transfer()]), /one/)
  })

  it('steps out of order', () => {
    refused(compile([transfer(), createAta()]), /one/)
    refused(compile([createAta(), setPrice(BigInt(1)), transfer()]), /one/)
  })

  it('no transfer at all', () => {
    refused(compile([createAta()]), /one/)
  })

  it('a compute budget option outside set-limit and set-price', () => {
    const heap: Instruction = {
      programAddress: COMPUTE_BUDGET,
      accounts: [],
      data: Uint8Array.from([1, ...getU32Encoder().encode(256_000)]),
    }
    const loaded: Instruction = {
      programAddress: COMPUTE_BUDGET,
      accounts: [],
      data: Uint8Array.from([4, ...getU32Encoder().encode(32_000)]),
    }
    refused(compile([heap, transfer()]), /compute budget/)
    refused(compile([loaded, transfer()]), /compute budget/)
  })

  it('a compute budget setting given twice', () => {
    refused(compile([setPrice(BigInt(1)), setPrice(BigInt(2)), transfer()]), /compute budget/)
  })

  it('a large priority fee, with or without a stated limit', () => {
    refused(compile([setLimit(1_000_000), setPrice(BigInt(5_000_001)), transfer()]), /priority fee/)
    refused(compile([setPrice(BigInt(1_000_000_000)), transfer()]), /priority fee/)
  })

  it('a priority fee just inside the bound passes', () => {
    expect(() =>
      check(compile([setLimit(1_000_000), setPrice(BigInt(5_000_000)), transfer()]))
    ).not.toThrow()
  })

  it('a lookup table attached and unused', () => {
    const message = openMessage(compile([transfer()]))
    refused(
      closeMessage({
        ...message,
        addressTableLookups: [
          { lookupTableAddress: OTHER, writableIndexes: [0], readonlyIndexes: [] },
        ],
      }),
      /lookup table/
    )
  })

  it('a destination hidden behind a lookup table', () => {
    const message = openMessage(compile([transfer()])) as unknown as {
      staticAccounts: string[]
      instructions: { accountIndices: number[] }[]
    }
    const instructions = message.instructions.map((instruction) => ({
      ...instruction,
      accountIndices: instruction.accountIndices.map((index, position) =>
        position === 2 ? message.staticAccounts.length : index
      ),
    }))
    refused(
      closeMessage({
        ...message,
        instructions,
        addressTableLookups: [
          { lookupTableAddress: OTHER, writableIndexes: [0], readonlyIndexes: [] },
        ],
      }),
      /lookup table/
    )
  })

  it('bytes that are not a transaction', () => {
    refused('!!!', /could not be read/)
    refused(Buffer.from('hello').toString('base64'), /could not be read/)
  })

  it('bytes hidden after the message', () => {
    const padded = Buffer.concat([
      Buffer.from(compile([transfer()]), 'base64'),
      Buffer.from([1, 2, 3]),
    ])
    refused(padded.toString('base64'), /can.t check|could not be read/)
  })

  it('a payload for another chain', () => {
    expect(() =>
      solanaDeposit.assertSafe({ family: 'sui', transaction: compile([transfer()]) }, EXPECTATION)
    ).toThrow(ChainActionRefused)
  })

  it('an order with a memo', () => {
    expect(() => check(compile([transfer()]), { ...EXPECTATION, memo: 'pay-ref' })).toThrow(/memo/)
  })

  it('an order whose deposit address is the account itself', () => {
    expect(() => check(compile([transfer()]), { ...EXPECTATION, depositAddress: ACCOUNT })).toThrow(
      ChainActionRefused
    )
  })

  it('an order amount with too many places, even if the transaction rounds to it', () => {
    expect(() => check(compile([transfer()]), { ...EXPECTATION, amount: '25.5000001' })).toThrow(
      /nothing was signed or sent/i
    )
  })
})

describe('build', () => {
  it('writes a transaction its own check admits, with the account paying', async () => {
    stubRpc()
    const payload = await solanaDeposit.build(EXPECTATION)
    expect(payload.family).toBe('solana')
    if (payload.family !== 'solana') return

    expect(() => solanaDeposit.assertSafe(payload, EXPECTATION)).not.toThrow()
    const decoded = decodeSolanaTransaction(payload.transaction)
    expect(decoded.feePayer).toBe(ACCOUNT)
    expect(decoded.blockhash).toBe(BLOCKHASH)
    expect(decoded.signerCount).toBe(1)

    const last = decoded.instructions[decoded.instructions.length - 1]
    expect(last?.data[0]).toBe(12)
    expect(getU64Decoder().decode(last?.data as Uint8Array, 1)).toBe(BASE_UNITS)
  })

  it('creates the deposit address its USDC account', async () => {
    stubRpc()
    const payload = await solanaDeposit.build(EXPECTATION)
    if (payload.family !== 'solana') throw new Error('wrong family')
    const decoded = decodeSolanaTransaction(payload.transaction)
    const programs = decoded.instructions.map((i) => decoded.staticAccounts[i.programIndex])
    expect(programs).toContain(ASSOCIATED_TOKEN_PROGRAM)
    expect(decoded.staticAccounts).toContain(associatedTokenAccount(DEPOSIT, USDC))
  })

  it('accepts a wallet that already exists under the System Program', async () => {
    stubRpc({ account: { result: { value: { owner: SYSTEM_PROGRAM, lamports: 1 } } } })
    await expect(solanaDeposit.build(EXPECTATION)).resolves.toMatchObject({ family: 'solana' })
  })

  it.each([
    ['the Token Program', TOKEN_PROGRAM],
    ['Token-2022', TOKEN_2022],
  ])('refuses a deposit address owned by %s, where USDC would be stuck', async (_name, owner) => {
    stubRpc({ account: { result: { value: { owner, lamports: 1 } } } })
    await expect(solanaDeposit.build(EXPECTATION)).rejects.toThrow(/token account/)
    await expect(solanaDeposit.build(EXPECTATION)).rejects.toBeInstanceOf(ChainActionRefused)
  })

  it('refuses when the account cannot be read, rather than assuming it is missing', async () => {
    stubRpc({ account: { error: { code: -32005, message: 'behind' } } })
    await expect(solanaDeposit.build(EXPECTATION)).rejects.toBeInstanceOf(ChainActionRefused)

    stubRpc({ account: { result: {} } })
    await expect(solanaDeposit.build(EXPECTATION)).rejects.toBeInstanceOf(ChainActionRefused)
  })

  it('refuses when no blockhash comes back', async () => {
    stubRpc({ blockhash: { error: { code: -32005, message: 'behind' } } })
    await expect(solanaDeposit.build(EXPECTATION)).rejects.toBeInstanceOf(ChainActionRefused)
  })

  it('refuses a deposit of more USDC than the wallet holds, saying both figures', async () => {
    stubRpc({ usdc: BigInt(500_000) })
    await expect(solanaDeposit.assertCanPay?.(EXPECTATION)).rejects.toThrow(
      /You hold 0\.5 USDC, and this cash-out sends 25\.5 USDC/
    )
  })

  it('refuses when there is too little SOL for the fee and opening the payout account', async () => {
    stubRpc({ lamports: 400_000 })
    const attempt = solanaDeposit.assertCanPay?.(EXPECTATION)
    await expect(attempt).rejects.toThrow(/open the payout address’s USDC account/)
    await expect(attempt).rejects.toThrow(/You hold 0\.0004 SOL/)
  })

  it('does not refuse when the balances cannot be read, leaving it to the wallet', async () => {
    stubRpc({ account: { error: { code: -32005, message: 'behind' } }, usdc: null })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}'))
    )
    await expect(solanaDeposit.assertCanPay?.(EXPECTATION)).resolves.toBeUndefined()
  })

  it('needs only the fee once the payout account exists', async () => {
    stubRpc({ lamports: 400_000, payoutAccountExists: true })
    await expect(solanaDeposit.assertCanPay?.(EXPECTATION)).resolves.toBeUndefined()
    stubRpc({ lamports: 10_000, payoutAccountExists: true })
    await expect(solanaDeposit.assertCanPay?.(EXPECTATION)).rejects.toThrow(/network fee/)
  })

  it('refuses a memo before asking the network anything', async () => {
    const fetchMock = stubRpc()
    await expect(solanaDeposit.build({ ...EXPECTATION, memo: 'x' })).rejects.toThrow(/memo/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['account', { account: 'nope' }],
    ['deposit address', { depositAddress: 'nope' }],
    ['amount with too many places', { amount: '1.0000001' }],
    ['zero amount', { amount: '0' }],
    ['amount past what the token can hold', { amount: '18446744073710' }],
    ['deposit address equal to the account', { depositAddress: ACCOUNT }],
  ])('refuses a bad %s before asking the network', async (_name, change) => {
    const fetchMock = stubRpc()
    const attempt = solanaDeposit.build({ ...EXPECTATION, ...change })
    await expect(attempt).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(attempt).rejects.toThrow(/nothing was signed or sent\.$/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('submit', () => {
  const good = signed(compile([createAta(), transfer()]))

  it('sends a signed deposit', async () => {
    const fetchMock = stubRpc()
    const result = await solanaDeposit.submit(
      { family: 'solana', signedTransaction: good },
      EXPECTATION
    )
    expect(result.ok).toBe(true)
    expect(rpcMethods(fetchMock)).toContain('sendTransaction')
  })

  it('checks the signed bytes again and sends nothing if they changed', async () => {
    const fetchMock = stubRpc()
    const swapped = signed(
      compile([transfer({ destination: associatedTokenAccount(OTHER, USDC) })])
    )
    await expect(
      solanaDeposit.submit({ family: 'solana', signedTransaction: swapped }, EXPECTATION)
    ).rejects.toBeInstanceOf(ChainActionRefused)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /** What Phantom adds before signing: a Lighthouse assertion on the signer's own account. */
  const lighthouse: Instruction = {
    programAddress: 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95',
    accounts: [{ address: ACCOUNT, role: AccountRole.READONLY }],
    data: Uint8Array.from([5, 0, 1]),
  }

  it('sends a deposit Phantom guarded, exactly as the wallet signed it', async () => {
    const fetchMock = stubRpc()
    const guarded = signed(compile([createAta(), transfer(), lighthouse]))
    const result = await solanaDeposit.submit(
      { family: 'solana', signedTransaction: guarded },
      EXPECTATION
    )
    expect(result.ok).toBe(true)
    const sent = fetchMock.mock.calls
      .map(
        ([, init]) =>
          JSON.parse(String((init as RequestInit).body)) as { method: string; params: unknown[] }
      )
      .find((call) => call.method === 'sendTransaction')
    expect(sent?.params[0]).toBe(guarded)
  })

  it('still refuses any other program a wallet adds beside the guard', async () => {
    const fetchMock = stubRpc()
    const other: Instruction = { programAddress: OTHER, accounts: [], data: Uint8Array.from([1]) }
    const tampered = signed(compile([createAta(), transfer(), lighthouse, other]))
    await expect(
      solanaDeposit.submit({ family: 'solana', signedTransaction: tampered }, EXPECTATION)
    ).rejects.toThrow(/does not need/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses another family without sending', async () => {
    const fetchMock = stubRpc()
    const result = await solanaDeposit.submit({ family: 'near', hashes: ['x'] }, EXPECTATION)
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not send what the wallet left unsigned', async () => {
    const fetchMock = stubRpc()
    const result = await solanaDeposit.submit(
      { family: 'solana', signedTransaction: compile([transfer()]) },
      EXPECTATION
    )
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    expect(rpcMethods(fetchMock)).not.toContain('sendTransaction')
  })

  it('reports an unconfirmed send as pending, so nobody pays twice', async () => {
    stubRpc({ statuses: { result: { value: [null] } } })
    const result = await solanaDeposit.submit(
      { family: 'solana', signedTransaction: good },
      EXPECTATION
    )
    expect(result).toMatchObject({ ok: false, pending: true })
    if (!result.ok) expect(result.error).toMatch(/again/)
  })

  it('reports a send that broke mid-flight as pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up')
      })
    )
    const result = await solanaDeposit.submit(
      { family: 'solana', signedTransaction: good },
      EXPECTATION
    )
    expect(result).toMatchObject({ ok: false, pending: true })
  })

  it('reports a node error that proves nothing as pending', async () => {
    stubRpc({ send: () => ({ error: { code: -32603, message: 'Internal error' } }) })
    const result = await solanaDeposit.submit(
      { family: 'solana', signedTransaction: good },
      EXPECTATION
    )
    expect(result).toMatchObject({ ok: false, pending: true })
    if (!result.ok) expect(result.error).toMatch(/send it again/i)
  })

  it('reports a failed status read before expiry as pending, not as expired', async () => {
    stubRpc({
      statuses: { error: { code: -32005, message: 'Node is behind' } },
      isValid: false,
    })
    const result = await solanaDeposit.submit(
      { family: 'solana', signedTransaction: good },
      EXPECTATION
    )
    expect(result).toMatchObject({ ok: false, pending: true })
    if (!result.ok) expect(result.error).toMatch(/send it again/i)
  })

  it('reports a failure seen only at processed as pending', async () => {
    stubRpc({
      statuses: { result: { value: [{ confirmationStatus: 'processed', err: { x: 1 } }] } },
    })
    const result = await solanaDeposit.submit(
      { family: 'solana', signedTransaction: good },
      EXPECTATION
    )
    expect(result).toMatchObject({ ok: false, pending: true })
  })

  it('reports an expired transaction as a plain failure', async () => {
    stubRpc({ statuses: { result: { value: [null] } }, isValid: false })
    const result = await solanaDeposit.submit(
      { family: 'solana', signedTransaction: good },
      EXPECTATION
    )
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
  })

  it('reports a landed failure as a plain failure', async () => {
    stubRpc({
      statuses: { result: { value: [{ confirmationStatus: 'confirmed', err: { x: 1 } }] } },
    })
    const result = await solanaDeposit.submit(
      { family: 'solana', signedTransaction: good },
      EXPECTATION
    )
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
  })
})
