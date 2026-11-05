import {
  AccountRole,
  getAddressDecoder,
  getAddressEncoder,
  getTransactionDecoder,
  getU64Decoder,
  getU64Encoder,
  type AccountMeta,
  type Address,
  type Instruction,
} from '@solana/kit'

import { bytesFromBase64 } from '../base64'
import { limitPair } from '../limit'
import { ChainActionRefused, tokenBySymbol, type ChainToken, type SigningPayload } from '../types'
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAccount,
  decodeSolanaTransaction,
  ownWrappedSolAccount,
  programAddress,
  solanaAssertSafe,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  type DecodedSolanaTransaction,
} from './assert-safe'
import {
  LIMO_GLOBAL_CONFIG,
  LIMO_ORDER_BYTES,
  LIMO_ORDER_RENT,
  LIMO_POLICY,
  LIMO_PROGRAM,
} from './programs'
import { SOLANA_TOKENS } from './tokens'

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112'
const MAX_U64 = BigInt('18446744073709551615')

const CREATE_ORDER_DATA = [141, 54, 37, 207, 237, 210, 250, 215]
const CLOSE_ORDER_DATA = [244, 27, 12, 226, 45, 247, 230, 43]
const ORDER_DISCRIMINATOR = [134, 173, 223, 185, 77, 86, 28, 51]
const CONFIG_DISCRIMINATOR = [149, 8, 156, 202, 160, 252, 176, 217]
const CONFIG_BYTES = 2168
/** A bid, which is what the SDK sends for every order. */
const ORDER_TYPE_BID = 0

/** The base-58 of `ORDER_DISCRIMINATOR`, for a filter on it. */
export const ORDER_DISCRIMINATOR_BASE58 = 'PXZJQQ2HEmx'

/** What the app trades here. Common enough that their vaults exist and searchers fill them. */
export const LIMO_TOKENS: readonly ChainToken[] = SOLANA_TOKENS.filter((t) =>
  ['SOL', 'USDC', 'USDT'].includes(t.symbol)
)

export function limoToken(mint: string): ChainToken | undefined {
  return LIMO_TOKENS.find((t) => t.id === mint)
}

const encodeAddress = (address: string): Uint8Array =>
  Uint8Array.from(getAddressEncoder().encode(address as Address))
const text = (word: string): Uint8Array => new TextEncoder().encode(word)

export function pdaAuthority(): string {
  return programAddress([text('authority'), encodeAddress(LIMO_GLOBAL_CONFIG)], LIMO_PROGRAM)
}

export function inputVault(mint: string): string {
  return programAddress(
    [text('escrow_vault'), encodeAddress(LIMO_GLOBAL_CONFIG), encodeAddress(mint)],
    LIMO_PROGRAM
  )
}

export function eventAuthority(): string {
  return programAddress([text('__event_authority')], LIMO_PROGRAM)
}

function meta(address: string, role: AccountRole): AccountMeta {
  return { address: address as Address, role }
}

const writable = (address: string): AccountMeta => meta(address, AccountRole.WRITABLE)
const readonly = (address: string): AccountMeta => meta(address, AccountRole.READONLY)
const signer = (address: string): AccountMeta => meta(address, AccountRole.WRITABLE_SIGNER)

function u64(value: bigint): number[] {
  return [...getU64Encoder().encode(value)]
}

/** Creates the account's token account for a mint if it isn't there, paid for by the account. */
function createTokenAccount(account: string, mint: string): Instruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM as Address,
    accounts: [
      signer(account),
      writable(associatedTokenAccount(account, mint)),
      readonly(account),
      readonly(mint),
      readonly(SYSTEM_PROGRAM),
      readonly(TOKEN_PROGRAM),
    ],
    data: Uint8Array.of(1),
  }
}

function closeWrappedSol(account: string): Instruction {
  return {
    programAddress: TOKEN_PROGRAM as Address,
    accounts: [
      writable(ownWrappedSolAccount(account)),
      writable(account),
      meta(account, AccountRole.READONLY_SIGNER),
    ],
    data: Uint8Array.of(9),
  }
}

export interface LimoCreate {
  account: string
  order: string
  inputMint: string
  outputMint: string
  inputAmount: bigint
  outputAmount: bigint
}

/**
 * Every instruction of a new order, in the SDK's order. The output token account is an addition: the
 * SDK leaves it out, and a fill fails without one unless what is bought is SOL, which arrives native.
 */
export function createInstructions(create: LimoCreate): Instruction[] {
  const { account, order, inputMint, outputMint, inputAmount, outputAmount } = create
  const sellsSol = inputMint === WRAPPED_SOL
  return [
    {
      programAddress: SYSTEM_PROGRAM as Address,
      accounts: [signer(account), signer(order)],
      data: Uint8Array.from([
        0,
        0,
        0,
        0,
        ...u64(BigInt(LIMO_ORDER_RENT)),
        ...u64(BigInt(LIMO_ORDER_BYTES)),
        ...encodeAddress(LIMO_PROGRAM),
      ]),
    },
    ...(sellsSol
      ? [
          createTokenAccount(account, WRAPPED_SOL),
          {
            programAddress: SYSTEM_PROGRAM as Address,
            accounts: [signer(account), writable(ownWrappedSolAccount(account))],
            data: Uint8Array.from([2, 0, 0, 0, ...u64(inputAmount)]),
          },
          {
            programAddress: TOKEN_PROGRAM as Address,
            accounts: [writable(ownWrappedSolAccount(account))],
            data: Uint8Array.of(17),
          },
        ]
      : []),
    ...(outputMint === WRAPPED_SOL ? [] : [createTokenAccount(account, outputMint)]),
    {
      programAddress: LIMO_PROGRAM as Address,
      accounts: [
        signer(account),
        writable(LIMO_GLOBAL_CONFIG),
        readonly(pdaAuthority()),
        writable(order),
        readonly(inputMint),
        readonly(outputMint),
        writable(associatedTokenAccount(account, inputMint)),
        writable(inputVault(inputMint)),
        readonly(TOKEN_PROGRAM),
        readonly(TOKEN_PROGRAM),
        readonly(SYSTEM_PROGRAM),
        readonly(eventAuthority()),
        readonly(LIMO_PROGRAM),
      ],
      data: Uint8Array.from([
        ...CREATE_ORDER_DATA,
        ...u64(inputAmount),
        ...u64(outputAmount),
        ORDER_TYPE_BID,
      ]),
    },
    ...(sellsSol ? [closeWrappedSol(account)] : []),
  ]
}

export interface LimoClose {
  account: string
  order: string
  inputMint: string
  outputMint: string
}

/**
 * Closes an order, whether it is open or filled, as the one instruction does both: what is left comes
 * back with its tips and rent. SOL returns wrapped, so it is unwrapped in the same transaction.
 */
export function closeInstructions(close: LimoClose): Instruction[] {
  const { account, order, inputMint, outputMint } = close
  return [
    createTokenAccount(account, inputMint),
    {
      programAddress: LIMO_PROGRAM as Address,
      accounts: [
        signer(account),
        writable(order),
        writable(LIMO_GLOBAL_CONFIG),
        writable(pdaAuthority()),
        readonly(inputMint),
        readonly(outputMint),
        writable(associatedTokenAccount(account, inputMint)),
        writable(inputVault(inputMint)),
        readonly(TOKEN_PROGRAM),
        readonly(SYSTEM_PROGRAM),
        readonly(eventAuthority()),
        readonly(LIMO_PROGRAM),
      ],
      data: Uint8Array.from(CLOSE_ORDER_DATA),
    },
    ...(inputMint === WRAPPED_SOL ? [closeWrappedSol(account)] : []),
  ]
}

const CREATE_ORDER_ACCOUNTS = [
  'maker',
  'global config',
  'authority',
  'order account',
  'input mint',
  'output mint',
  'token account',
  'vault',
  'input token program',
  'output token program',
  'system program',
  'event authority',
  'program',
]

const CLOSE_ORDER_ACCOUNTS = [
  'maker',
  'order account',
  'global config',
  'authority',
  'input mint',
  'output mint',
  'token account',
  'vault',
  'token program',
  'system program',
  'event authority',
  'program',
]

function refused(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * Holds a transaction to exactly what this file would build. Compute budget settings are the one
 * thing left free here: `solanaAssertSafe` has already bounded them.
 */
function assertExactly(
  transaction: DecodedSolanaTransaction,
  expected: readonly Instruction[],
  what: string,
  accountNames: readonly string[]
): void {
  const steps = transaction.instructions.filter(
    (ix) => transaction.staticAccounts[ix.programIndex] !== COMPUTE_BUDGET_PROGRAM
  )
  if (steps.length !== expected.length) {
    refused(`This is not ${what} you asked for: it has other steps in it.`)
  }
  expected.forEach((want, i) => {
    const step = steps[i]
    const isLimo = want.programAddress === LIMO_PROGRAM
    if (
      step === undefined ||
      transaction.staticAccounts[step.programIndex] !== want.programAddress
    ) {
      refused(`This is not ${what} you asked for: its steps are not the ones expected.`)
    }
    const accounts = step.accounts.map((index) => transaction.staticAccounts[index])
    const wanted = want.accounts ?? []
    if (accounts.length !== wanted.length) {
      refused(`This is not ${what} you asked for: one of its steps has other accounts.`)
    }
    wanted.forEach((meta_, position) => {
      if (accounts[position] !== meta_.address) {
        const name = isLimo ? (accountNames[position] ?? 'account') : 'step’s account'
        refused(`This is not ${what} you asked for: its ${name} is not the one expected.`)
      }
    })
    if (!sameBytes(step.data, want.data ?? [])) {
      refused(
        isLimo
          ? `This is not ${what} you asked for: its amounts or type are different.`
          : `This is not ${what} you asked for: one of its steps moves a different amount.`
      )
    }
  })
}

function amountIn(context: Record<string, string> | undefined, key: string): bigint {
  const value = context?.[key]
  if (value === undefined || !/^\d{1,20}$/.test(value)) {
    refused('This order lost track of what you asked for, so I stopped here.')
  }
  const amount = BigInt(value)
  if (amount === BigInt(0) || amount > MAX_U64) {
    refused('This order’s amounts are not ones it can hold.')
  }
  return amount
}

function assertCreate(
  transaction: DecodedSolanaTransaction,
  account: string,
  context: Record<string, string> | undefined,
  signedPayload: string
): void {
  const order = transaction.staticAccounts[1]
  if (transaction.signerCount !== 2 || order === undefined) {
    refused('This order’s account was not created by this transaction.')
  }
  const inputMint = context?.['inputMint'] ?? ''
  const outputMint = context?.['outputMint'] ?? ''
  const input = limoToken(inputMint)
  const output = limoToken(outputMint)
  if (
    input === undefined ||
    output === undefined ||
    limitPair(input.symbol, output.symbol) === undefined
  ) {
    refused('Kamino limit orders here take SOL against USDC or USDT only.')
  }
  assertExactly(
    transaction,
    createInstructions({
      account,
      order,
      inputMint,
      outputMint,
      inputAmount: amountIn(context, 'inputAmount'),
      outputAmount: amountIn(context, 'outputAmount'),
    }),
    'the limit order',
    CREATE_ORDER_ACCOUNTS
  )
  // A wallet that strips it would otherwise leave a transaction the network can only reject.
  const { signatures } = getTransactionDecoder().decode(bytesFromBase64(signedPayload))
  if ((signatures[order as Address] ?? null) === null) {
    refused('This order is missing its own signature, so your wallet may have changed it.')
  }
}

function assertClose(
  transaction: DecodedSolanaTransaction,
  account: string,
  close: DecodedSolanaTransaction['instructions'][number]
): void {
  const at = (position: number): string => {
    const index = close.accounts[position]
    return (index === undefined ? undefined : transaction.staticAccounts[index]) ?? ''
  }
  const inputMint = at(4)
  const outputMint = at(5)
  if (limoToken(inputMint) === undefined || limoToken(outputMint) === undefined) {
    refused('Kamino limit orders here take SOL, USDC and USDT only.')
  }
  assertExactly(
    transaction,
    closeInstructions({ account, order: at(1), inputMint, outputMint }),
    'the order close',
    CLOSE_ORDER_ACCOUNTS
  )
}

const generic = solanaAssertSafe(LIMO_POLICY)

/**
 * Passes only what this file would have built for this account. A close carries everything it needs
 * in its own accounts, and the program refuses a maker who isn't the order's.
 *
 * A create's mints and amounts are compared with `context`, and that is the limit of what it can
 * show. At `prepare` this server wrote the context, so a wrong sum or a wrong build is caught. At
 * submit the browser hands it back unproven, as no secret is required to place an order, so a browser
 * rewriting bytes and context together passes on the amounts, and on which offered pair, and only on
 * those: the wallet, config, vault, accounts and steps are all still held to what they must be. Such
 * a browser could send what it had signed by itself anyway, without coming here.
 */
export function limoAssertSafe(
  payload: SigningPayload,
  account: string,
  context?: Record<string, string> | undefined
): void {
  generic(payload, account)
  if (payload.family !== 'solana') return
  const transaction = decodeSolanaTransaction(payload.transaction)
  const calls = transaction.instructions.filter(
    (ix) => transaction.staticAccounts[ix.programIndex] === LIMO_PROGRAM
  )
  const [call] = calls
  if (calls.length !== 1 || call === undefined) {
    refused('This transaction is not one limit order.')
  }
  const isClose = sameBytes(call.data.subarray(0, 8), CLOSE_ORDER_DATA)
  if (isClose) assertClose(transaction, account, call)
  else assertCreate(transaction, account, context, payload.transaction)
}

/** What each side of a new order is, or a refusal for any pair this app does not offer. */
export function limoPair(
  tokenIn: string,
  tokenOut: string
): { input: ChainToken; output: ChainToken; selling: boolean; base: string; quote: string } {
  const input = tokenBySymbol(LIMO_TOKENS, tokenIn)
  const output = tokenBySymbol(LIMO_TOKENS, tokenOut)
  const pair = limitPair(tokenIn, tokenOut)
  if (input === undefined || output === undefined || pair === undefined) {
    refused('Kamino limit orders here take SOL against USDC or USDT only.')
  }
  return { input, output, selling: pair.selling, base: pair.base, quote: pair.quote }
}

export interface LimoOrder {
  globalConfig: string
  maker: string
  inputMint: string
  outputMint: string
  initialInput: bigint
  expectedOutput: bigint
  remainingInput: bigint
  filledOutput: bigint
  tip: bigint
  /** 0 active, 1 filled, 2 cancelled. */
  status: number
}

/** An order account's fields, or nothing if these bytes are not one. Layout from the SDK's `Order`. */
export function decodeOrder(bytes: Uint8Array): LimoOrder | undefined {
  if (bytes.length !== LIMO_ORDER_BYTES) return undefined
  if (!sameBytes(bytes.subarray(0, 8), ORDER_DISCRIMINATOR)) return undefined
  const address = getAddressDecoder()
  const amount = getU64Decoder()
  return {
    globalConfig: address.decode(bytes, 8),
    maker: address.decode(bytes, 40),
    inputMint: address.decode(bytes, 72),
    outputMint: address.decode(bytes, 136),
    initialInput: amount.decode(bytes, 200),
    expectedOutput: amount.decode(bytes, 208),
    remainingInput: amount.decode(bytes, 216),
    filledOutput: amount.decode(bytes, 224),
    tip: amount.decode(bytes, 232),
    status: bytes[249] as number,
  }
}

export interface LimoConfig {
  newOrdersBlocked: boolean
  emergencyMode: boolean
  /** Lamports `create_order` takes from the maker, inside the call where signed bytes can't show it. */
  cost: bigint
  pdaAuthority: string
}

/** A global config's fields, or nothing if these bytes are not one. Layout from the SDK. */
export function decodeGlobalConfig(bytes: Uint8Array): LimoConfig | undefined {
  if (bytes.length !== CONFIG_BYTES) return undefined
  if (!sameBytes(bytes.subarray(0, 8), CONFIG_DISCRIMINATOR)) return undefined
  const amount = getU64Decoder()
  return {
    emergencyMode: bytes[8] !== 0,
    newOrdersBlocked: bytes[10] !== 0,
    pdaAuthority: getAddressDecoder().decode(bytes, 120),
    cost: amount.decode(bytes, 224) + amount.decode(bytes, 232),
  }
}
