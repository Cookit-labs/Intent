import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getU32Decoder,
  getU32Encoder,
  getU64Decoder,
  getU64Encoder,
  isAddress,
  isBlockhash,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
} from '@solana/kit'
import { z } from 'zod'

import { bytesFromBase64 } from '../../chains/base64'
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAccount,
  decodeSolanaTransaction,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  type DecodedSolanaTransaction,
} from '../../chains/solana/assert-safe'
import { venueFetch } from '../../chains/solana/http'
import { createSolanaSubmit, explorerUrl, feePayerSignature } from '../../chains/solana/submit'
import { SOLANA_TOKENS } from '../../chains/solana/tokens'
import { withoutWalletGuards } from '../../chains/solana/wallet-guards'
import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainToken,
  type SignedPayload,
  type SigningPayload,
  type SubmitResult,
} from '../../chains/types'
import type { DepositChain, DepositExpectation } from '../types'

const USDC = tokenBySymbol(SOLANA_TOKENS, 'USDC') as ChainToken

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const DEFAULT_RPC_URL = 'https://solana-rpc.publicnode.com'

const TRANSFER_CHECKED = 12
const CREATE_IDEMPOTENT = 1
const SET_COMPUTE_UNIT_LIMIT = 2
const SET_COMPUTE_UNIT_PRICE = 3

const MAX_U64 = BigInt('18446744073709551615')
/** The same ceiling `solanaAssertSafe` holds swaps to, about 0.005 SOL. */
const MAX_PRIORITY_FEE_LAMPORTS = BigInt(5_000_000)
const DEFAULT_COMPUTE_UNIT_LIMIT = BigInt(1_400_000)

/** Creating the deposit's token account costs about 30,000 units and the transfer about 6,000. */
const COMPUTE_UNIT_LIMIT = 100_000
/** About 0.00001 SOL at the limit above, enough to land without a live fee estimate. */
const COMPUTE_UNIT_PRICE = BigInt(100_000)

function tokenOf(expectation: DepositExpectation): ChainToken {
  return expectation.token ?? USDC
}

function notOneTransfer(token: ChainToken): string {
  return `This transaction asks the Token Program for something other than one ${token.symbol} transfer.`
}

const RpcAccount = z.object({
  result: z.object({
    value: z.object({ owner: z.string(), executable: z.boolean().optional() }).nullable(),
  }),
})

const RpcBlockhash = z.object({
  result: z.object({
    value: z.object({
      blockhash: z.string().refine(isBlockhash),
      lastValidBlockHeight: z.number().int().nonnegative(),
    }),
  }),
})

function refuse(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

/** Everything about the order itself, checked before any transaction is read or written. */
function orderUnits(expectation: DepositExpectation): bigint {
  const { account, depositAddress, memo, amount } = expectation
  if (memo !== undefined) refuse('This order has a memo, which a Solana deposit cannot carry.')
  if (!isAddress(account)) refuse('That is not a Solana wallet address.')
  if (!isAddress(depositAddress)) refuse('This order’s deposit address is not a Solana address.')
  if (depositAddress === account) refuse('This order’s deposit address is your own wallet.')
  const token = tokenOf(expectation)
  let units: bigint
  try {
    units = BigInt(toBaseUnits(amount, token.decimals))
  } catch (e) {
    return refuse(e instanceof Error ? e.message : 'That is not an amount.')
  }
  if (units > MAX_U64) refuse(`This order’s amount is too large for ${token.symbol}.`)
  return units
}

function decode(base64: string): DecodedSolanaTransaction {
  try {
    return decodeSolanaTransaction(base64)
  } catch {
    return refuse('That transaction could not be read.')
  }
}

function hasLookupTables(base64: string): boolean {
  const { messageBytes } = getTransactionDecoder().decode(bytesFromBase64(base64))
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes)
  return 'addressTableLookups' in message && (message.addressTableLookups?.length ?? 0) > 0
}

type Instruction = DecodedSolanaTransaction['instructions'][number]

function accountsOf(transaction: DecodedSolanaTransaction, instruction: Instruction): string[] {
  return instruction.accounts.map((index) => {
    const address = transaction.staticAccounts[index]
    return address ?? refuse('This transaction uses an account hidden in a lookup table.')
  })
}

function checkComputeBudget(instructions: readonly Instruction[]): void {
  let limit: bigint | undefined
  let price: bigint | undefined
  for (const { data } of instructions) {
    if (data[0] === SET_COMPUTE_UNIT_LIMIT && data.length === 5 && limit === undefined) {
      limit = BigInt(getU32Decoder().decode(data, 1))
    } else if (data[0] === SET_COMPUTE_UNIT_PRICE && data.length === 9 && price === undefined) {
      price = getU64Decoder().decode(data, 1)
    } else {
      refuse('This transaction sets a compute budget option a deposit does not use.')
    }
  }
  const fee = ((price ?? BigInt(0)) * (limit ?? DEFAULT_COMPUTE_UNIT_LIMIT)) / BigInt(1_000_000)
  if (fee > MAX_PRIORITY_FEE_LAMPORTS) {
    refuse('This transaction would pay an unusually large priority fee from your SOL.')
  }
}

function checkAccountCreation(
  transaction: DecodedSolanaTransaction,
  instruction: Instruction,
  expectation: DepositExpectation,
  destination: string
): void {
  const wanted = [
    expectation.account,
    destination,
    expectation.depositAddress,
    tokenOf(expectation).id,
    SYSTEM_PROGRAM,
    TOKEN_PROGRAM,
  ]
  const actual = accountsOf(transaction, instruction)
  const matches =
    instruction.data.length === 1 &&
    instruction.data[0] === CREATE_IDEMPOTENT &&
    actual.length === wanted.length &&
    actual.every((address, position) => address === wanted[position])
  if (!matches) {
    refuse('The account creation in this transaction is not for this order’s deposit address.')
  }
}

function checkTransfer(
  transaction: DecodedSolanaTransaction,
  instruction: Instruction,
  expectation: DepositExpectation,
  destination: string,
  units: bigint
): void {
  const token = tokenOf(expectation)
  const [from, mint, to, owner, ...rest] = accountsOf(transaction, instruction)
  if (rest.length > 0 || owner === undefined) refuse(notOneTransfer(token))
  if (mint !== token.id || instruction.data[9] !== token.decimals) {
    refuse(`This transfer is not ${token.symbol}.`)
  }
  if (from !== associatedTokenAccount(expectation.account, token.id)) {
    refuse(`This transfer does not come from your ${token.symbol} account.`)
  }
  if (owner !== expectation.account) refuse('This transfer is not authorised by your wallet.')
  if (to !== destination) refuse('This transfer does not go to this order’s deposit address.')
  if (getU64Decoder().decode(instruction.data, 1) !== units) {
    refuse('This transfer’s amount is not this order’s amount.')
  }
}

/**
 * Only this shape passes: compute budget settings, then at most one creation of the
 * deposit's token account, then one TransferChecked. Lookup tables are refused outright
 * because resolving one needs the network, and this check has to see every account.
 */
function assertSafe(payload: SigningPayload, expectation: DepositExpectation): void {
  if (payload.family !== 'solana') refuse('That is not a Solana transaction.')
  const units = orderUnits(expectation)
  const token = tokenOf(expectation)
  const transaction = decode(payload.transaction)
  if (hasLookupTables(payload.transaction)) {
    refuse('This transaction uses a lookup table, which hides accounts from this check.')
  }
  if (transaction.feePayer !== expectation.account) {
    refuse('This transaction’s network fee would not be paid by your wallet.')
  }
  if (transaction.signerCount !== 1 || transaction.readonlySignerCount !== 0) {
    refuse('This transaction needs a signature from someone other than you.')
  }

  const budget: Instruction[] = []
  const steps = transaction.instructions.map((instruction) => {
    switch (transaction.staticAccounts[instruction.programIndex]) {
      case COMPUTE_BUDGET_PROGRAM:
        budget.push(instruction)
        return 'budget'
      case ASSOCIATED_TOKEN_PROGRAM:
        return 'create'
      case TOKEN_PROGRAM:
        if (instruction.data.length !== 10 || instruction.data[0] !== TRANSFER_CHECKED) {
          refuse(notOneTransfer(token))
        }
        return 'transfer'
      default:
        return refuse(`This transaction calls a program a ${token.symbol} deposit does not need.`)
    }
  })
  if (!/^(budget,)*(create,)?transfer$/.test(steps.join(','))) {
    refuse(`This transaction is not the one ${token.symbol} transfer this order needs.`)
  }
  checkComputeBudget(budget)

  const destination = associatedTokenAccount(expectation.depositAddress, token.id)
  const transfer = transaction.instructions[transaction.instructions.length - 1] as Instruction
  const creation = transaction.instructions[transaction.instructions.length - 2]
  if (steps[steps.length - 2] === 'create' && creation !== undefined) {
    checkAccountCreation(transaction, creation, expectation, destination)
  }
  checkTransfer(transaction, transfer, expectation, destination, units)
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const url = process.env['SOLANA_RPC_URL']?.trim() || DEFAULT_RPC_URL
  const { status, body } = await venueFetch(url, {
    label: 'Solana',
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method, params },
  })
  return status === 200 ? body : undefined
}

const RpcTokenAccount = z.object({
  result: z.object({
    value: z
      .object({
        data: z.object({
          parsed: z.object({ info: z.object({ tokenAmount: z.object({ amount: z.string() }) }) }),
        }),
      })
      .nullable(),
  }),
})

/**
 * Read from the account itself, because the public RPC refuses the balance calls it
 * counts as indexed. A wallet that has never held USDC has no token account, which
 * is a balance of zero. Anything else unreadable throws rather than reading as zero.
 */
async function usdcBalance(account: string): Promise<bigint> {
  const { result } = RpcTokenAccount.parse(
    await rpc('getAccountInfo', [
      associatedTokenAccount(account, USDC.id),
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ])
  )
  return result.value === null
    ? BigInt(0)
    : BigInt(result.value.data.parsed.info.tokenAmount.amount)
}

/**
 * Funds sent to a token account's own token account can't be moved by anyone, since a
 * token account has no key to sign with. A missing account is fine: it is a fresh wallet.
 */
export async function assertDepositIsNotTokenAccount(
  depositAddress: string,
  token: ChainToken,
  /** For an address a person typed. A program holds no key either, so what it is sent is stranded. */
  options: { refusePrograms?: boolean } = {}
): Promise<void> {
  const reply = RpcAccount.safeParse(
    await rpc('getAccountInfo', [depositAddress, { encoding: 'base64', commitment: 'confirmed' }])
  )
  if (!reply.success) refuse('Solana’s network could not be read just now.')
  if (options.refusePrograms === true && reply.data.result.value?.executable === true) {
    refuse(`That address is a program, and ${token.symbol} sent there would be stuck.`)
  }
  const owner = reply.data.result.value?.owner
  if (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) {
    refuse(
      `This order’s deposit address is a token account, and ${token.symbol} sent there would be stuck.`
    )
  }
}

function compile(
  expectation: DepositExpectation,
  units: bigint,
  lifetime: { blockhash: string; lastValidBlockHeight: number }
): string {
  const { account, depositAddress } = expectation
  const token = tokenOf(expectation)
  const destination = associatedTokenAccount(depositAddress, token.id)
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(account as Address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: lifetime.blockhash as Blockhash,
          lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
        },
        m
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          {
            programAddress: COMPUTE_BUDGET_PROGRAM as Address,
            data: Uint8Array.from([
              SET_COMPUTE_UNIT_LIMIT,
              ...getU32Encoder().encode(COMPUTE_UNIT_LIMIT),
            ]),
          },
          {
            programAddress: COMPUTE_BUDGET_PROGRAM as Address,
            data: Uint8Array.from([
              SET_COMPUTE_UNIT_PRICE,
              ...getU64Encoder().encode(COMPUTE_UNIT_PRICE),
            ]),
          },
          {
            programAddress: ASSOCIATED_TOKEN_PROGRAM as Address,
            accounts: [
              { address: account as Address, role: AccountRole.WRITABLE_SIGNER },
              { address: destination as Address, role: AccountRole.WRITABLE },
              { address: depositAddress as Address, role: AccountRole.READONLY },
              { address: token.id as Address, role: AccountRole.READONLY },
              { address: SYSTEM_PROGRAM as Address, role: AccountRole.READONLY },
              { address: TOKEN_PROGRAM as Address, role: AccountRole.READONLY },
            ],
            data: Uint8Array.of(CREATE_IDEMPOTENT),
          },
          {
            programAddress: TOKEN_PROGRAM as Address,
            accounts: [
              {
                address: associatedTokenAccount(account, token.id) as Address,
                role: AccountRole.WRITABLE,
              },
              { address: token.id as Address, role: AccountRole.READONLY },
              { address: destination as Address, role: AccountRole.WRITABLE },
              { address: account as Address, role: AccountRole.READONLY_SIGNER },
            ],
            data: Uint8Array.from([
              TRANSFER_CHECKED,
              ...getU64Encoder().encode(units),
              token.decimals,
            ]),
          },
        ],
        m
      )
  )
  return getBase64EncodedWireTransaction(compileTransaction(message))
}

async function build(expectation: DepositExpectation): Promise<SigningPayload> {
  const units = orderUnits(expectation)
  await assertDepositIsNotTokenAccount(expectation.depositAddress, tokenOf(expectation))
  const reply = RpcBlockhash.safeParse(
    await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])
  )
  if (!reply.success) refuse('Solana’s network could not be read just now.')

  const payload: SigningPayload = {
    family: 'solana',
    transaction: compile(expectation, units, reply.data.result.value),
  }
  assertSafe(payload, expectation)
  return payload
}

function pending(hash: string, token: ChainToken): SubmitResult {
  return {
    ok: false,
    pending: true,
    error: `Your ${token.symbol} deposit was sent (${hash}) but isn't confirmed yet. Don't send it again until you've checked ${explorerUrl(hash)}.`,
  }
}

async function submit(
  signed: SignedPayload,
  expectation: DepositExpectation
): Promise<SubmitResult> {
  if (signed.family !== 'solana') {
    return { ok: false, error: 'That is not a Solana transaction, so nothing was sent.' }
  }
  // Phantom's Lighthouse guards are its own and only make the transfer fail; the rest is checked.
  assertSafe(
    { family: 'solana', transaction: withoutWalletGuards(signed.signedTransaction) },
    expectation
  )
  const hash = feePayerSignature(signed.signedTransaction)
  if (hash === undefined) {
    return {
      ok: false,
      error: 'Your wallet returned this unsigned, so nothing was sent. Sign it again.',
    }
  }

  let result: SubmitResult
  try {
    result = await createSolanaSubmit()({ account: expectation.account, venueId: 'weave', signed })
  } catch {
    // A connection that broke during the send says nothing about whether it landed.
    return pending(hash, tokenOf(expectation))
  }
  return !result.ok && result.pending === true ? pending(hash, tokenOf(expectation)) : result
}

export const solanaDeposit: DepositChain = {
  chain: 'solana',
  usdcDecimals: USDC.decimals,
  supportsMemo: false,
  isAccount: isAddress,
  isDepositAddress: isAddress,
  usdcBalance,
  build,
  assertSafe,
  submit,
}
