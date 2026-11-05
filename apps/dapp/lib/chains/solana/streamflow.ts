import { createHash, createHmac, randomBytes } from 'node:crypto'

import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isAddress,
  isBlockhash,
  isOffCurveAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
} from '@solana/kit'
import { z } from 'zod'

import { bytesFromBase64 } from '../base64'
import { sameProof, secret } from '../oneclick-origin'
import { sendRefusal } from '../recipient'
import {
  ChainActionRefused,
  toBaseUnits,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
} from '../types'
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAccount,
  decodeSolanaTransaction,
  solanaAssertSafe,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  type SolanaVenuePolicy,
} from './assert-safe'
import { venueFetch } from './http'
import { fromBaseUnits, SOLANA_TOKENS } from './tokens'

/**
 * Payment streams on Streamflow's main program: the whole amount is funded when the stream is
 * created and unlocks hour by hour over the days the person typed.
 *
 * Streamflow also lists an immutable program, strmdbLr6w7QNmsiEXyFwWg3VSfg1GiELgU27P8aCGw, with no
 * upgrade key and no SOL fee. It isn't used because its only single-signer path needs an account
 * made by seed, and Streamflow's app hides that program behind a flag that is off by default, so a
 * recipient would have nowhere ordinary to withdraw and the person nowhere to cancel.
 */

// https://developers.streamflow.finance/docs/resources/program-ids, "Main Program (mainnet)".
// Executable by getAccountInfo, and it takes create_v2 in a simulation: streamflow.live.test.ts.
export const STREAMFLOW_PROGRAM = 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m'

// `STREAMFLOW_TREASURY_PUBLIC_KEY` in @streamflow/stream 13.4.0's solana/constants.ts. The program
// refuses any other, and writes this one into each stream, as a simulation shows. The token fee
// reaches it only as the stream unlocks.
export const STREAMFLOW_TREASURY = '5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw'

// `WITHDRAWOR` in the same file. The program refuses any other. It takes no SOL here, because
// automatic withdrawals are off: the creation fee sits on the stream's own account.
export const STREAMFLOW_WITHDRAWOR = 'wdrwhnCv4pzW8beKsbPa4S2UDZrXenjg16KJdKSpb5u'

// `FEE_ORACLE_PUBLIC_KEY` in the same file, and owned on chain by Streamflow's partner oracle
// program, pardpVtPjC8nLj1Dwncew62mUzfChdCX1EaoZe8oCAa. Whoever runs it sets what a stream costs.
export const STREAMFLOW_FEE_ORACLE = 'B743wFVk2pCYhV91cn287e1xY7f1vt4gdY48hhNiuQmT'

const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111'
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

/** Anchor's discriminator for `create_v2`, whose stream address needs no second signer. */
const CREATE_V2 = 'd6904cec5f8b31b4'

export const STREAMFLOW_POLICY: SolanaVenuePolicy = {
  venueName: 'Streamflow',
  programs: { [STREAMFLOW_PROGRAM]: { discriminators: [CREATE_V2] } },
  mayWrapSol: false,
}

const VENUE_ID = 'streamflow'
const STREAMFLOW_APP = 'app.streamflow.finance'
const NOTHING_MOVED = 'Nothing was signed or sent.'

const STREAMABLE = ['USDC', 'USDT']
const WHOLE_DAYS = /^[1-9]\d{0,3}$/
const MAX_DAYS = 3650
const MAX_U64 = BigInt('18446744073709551615')

const PERIOD_SECONDS = 3600
const PERIODS_PER_DAY = 24
/** Division leaves a remainder that unlocks at the start, and this keeps it from mattering. */
const MAX_START_SHARE = BigInt(100)

const STREAM_NAME = 'Intent stream'
const NAME_BYTES = 64
const INSTRUCTION_BYTES = 150
const NONCE_OFFSET = 136

/** A fresh recipient measured about 92,000 units in simulation. */
const COMPUTE_UNIT_LIMIT = 200_000
/** About 0.00002 SOL at the limit above. */
const COMPUTE_UNIT_PRICE = BigInt(100_000)
const SET_COMPUTE_UNIT_LIMIT = 2
const SET_COMPUTE_UNIT_PRICE = 3

const DEFAULT_RPC_URL = 'https://solana-rpc.publicnode.com'

/** Offsets into a stream's account: `streamLayout` in @streamflow/stream, and a simulation of one. */
const STREAM = {
  sender: 49,
  recipient: 113,
  mint: 177,
  treasury: 241,
  tokenFee: 305,
  partner: 325,
  partnerFee: 389,
  deposited: 417,
  creationFee: 704,
  minimumBytes: 708,
}

function refuse(sentence: string): never {
  throw new ChainActionRefused(`${sentence} ${NOTHING_MOVED}`)
}

const notTheStream = (): never => refuse('This is not the stream you asked for.')
const unreadable = (): never => refuse('Solana’s network could not be read just now.')

export type SolanaRpc = (method: string, params: unknown[]) => Promise<unknown>

const defaultRpc: SolanaRpc = async (method, params) => {
  const url = process.env['SOLANA_RPC_URL']?.trim() || DEFAULT_RPC_URL
  const { status, body } = await venueFetch(url, {
    label: 'Solana',
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method, params },
  })
  return status === 200 ? body : undefined
}

const RpcAccount = z.object({
  result: z.object({ value: z.object({ owner: z.string() }).nullable() }),
})

const RpcBlockhash = z.object({
  result: z.object({
    value: z.object({
      blockhash: z.string().refine(isBlockhash),
      lastValidBlockHeight: z.number().int().nonnegative(),
    }),
  }),
})

const RpcSimulation = z.object({
  result: z.object({
    value: z.object({
      err: z.unknown(),
      accounts: z
        .array(z.object({ data: z.tuple([z.string(), z.string()]) }).nullable())
        .nullable()
        .optional(),
    }),
  }),
})

/**
 * The address a program derives from these seeds. Written out as `associatedTokenAccount` is,
 * because `assertSafe` is synchronous by contract and the kit's derivation is not.
 */
function programAddress(seeds: readonly Uint8Array[], program: string): string {
  const encoded = getAddressEncoder().encode(program as Address)
  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = createHash('sha256')
    for (const seed of seeds) hash.update(seed)
    hash.update(Uint8Array.of(bump))
    hash.update(Uint8Array.from(encoded))
    hash.update('ProgramDerivedAddress')
    const candidate = getAddressDecoder().decode(hash.digest())
    if (isOffCurveAddress(candidate)) return candidate
  }
  throw new Error('No program address for these seeds.')
}

function addressBytes(address: string): Uint8Array {
  return Uint8Array.from(getAddressEncoder().encode(address as Address))
}

function streamAddress(account: string, mint: string, nonce: number): string {
  const big = Buffer.alloc(4)
  big.writeUInt32BE(nonce)
  return programAddress(
    [Buffer.from('strm-met'), addressBytes(mint), addressBytes(account), big],
    STREAMFLOW_PROGRAM
  )
}

function escrowAddress(stream: string): string {
  return programAddress([Buffer.from('strm'), addressBytes(stream)], STREAMFLOW_PROGRAM)
}

interface AskedStream {
  recipient: string
  token: ChainToken
  units: bigint
  days: number
}

/** Even hours, with what division leaves unlocking at the start, so it ends when it was asked to. */
function schedule(units: bigint, days: number): { perPeriod: bigint; atStart: bigint } {
  const periods = BigInt(days * PERIODS_PER_DAY)
  const perPeriod = units / periods
  const atStart = units - perPeriod * periods
  if (perPeriod === BigInt(0) || atStart * MAX_START_SHARE > units) {
    refuse(`That amount is too small to spread evenly over ${days} ${days === 1 ? 'day' : 'days'}.`)
  }
  return { perPeriod, atStart }
}

function asked(request: ChainActionRequest, account: string): AskedStream {
  if (!isAddress(account)) refuse('That is not a Solana wallet address.')
  if (request.kind !== 'stream') refuse('Streamflow only streams here.')
  const token = tokenBySymbol(SOLANA_TOKENS, request.tokenIn)
  if (token === undefined || !STREAMABLE.includes(token.symbol)) {
    return refuse(`Streamflow streams ${STREAMABLE.join(' or ')} here, not ${request.tokenIn}.`)
  }
  const { recipient } = request
  if (recipient === undefined) return refuse('A stream needs an address to go to.')
  const refusal = sendRefusal('solana', token.symbol, recipient, account)
  if (refusal !== undefined) throw new ChainActionRefused(refusal)
  if (isOffCurveAddress(recipient as Address)) {
    refuse('No one can sign for that address, and a stream’s recipient has to sign to withdraw.')
  }
  const durationDays = request.durationDays ?? ''
  if (!WHOLE_DAYS.test(durationDays) || Number(durationDays) > MAX_DAYS) {
    refuse(`A stream needs a length in whole days, from 1 to ${MAX_DAYS} days.`)
  }
  const units = BigInt(toBaseUnits(request.amount, token.decimals))
  if (units > MAX_U64) refuse('That amount is too large for a stream.')
  const days = Number(durationDays)
  schedule(units, days)
  return { recipient, token, units, days }
}

/** A transfer can land anywhere, but a stream pays only an address that can sign to withdraw. */
async function assertRecipientIsWallet(rpc: SolanaRpc, recipient: string): Promise<void> {
  const reply = RpcAccount.safeParse(
    await rpc('getAccountInfo', [
      recipient,
      { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
    ])
  )
  if (!reply.success) unreadable()
  else if (reply.data.result.value !== null && reply.data.result.value.owner !== SYSTEM_PROGRAM) {
    refuse('That address isn’t a plain wallet, and a stream’s recipient has to sign to withdraw.')
  }
}

function createData(stream: AskedStream, nonce: number): Uint8Array {
  const { perPeriod, atStart } = schedule(stream.units, stream.days)
  const data = Buffer.alloc(INSTRUCTION_BYTES)
  let at = data.write(CREATE_V2, 0, 'hex')
  // A start and cliff of zero mean the moment this lands, so a slow signature can't fail it.
  for (const value of [
    BigInt(0),
    stream.units,
    BigInt(PERIOD_SECONDS),
    perPeriod,
    BigInt(0),
    atStart,
  ]) {
    at = data.writeBigUInt64LE(value, at)
  }
  // Cancelable by the sender, and none of: cancel by recipient, automatic withdrawal, transfer by
  // sender, transfer by recipient, top up.
  at = data.writeUInt8(1, at) + 5
  at += data.write(STREAM_NAME, at) + NAME_BYTES - Buffer.byteLength(STREAM_NAME)
  at = data.writeBigUInt64LE(BigInt(PERIOD_SECONDS), at)
  // Not pausable, and no rate change, which would also let the cancel and transfer rules change.
  at += 2
  data.writeUInt32LE(nonce, at)
  return data
}

function createAccounts(account: string, stream: AskedStream, nonce: number) {
  const mint = stream.token.id
  const metadata = streamAddress(account, mint, nonce)
  const tokens = associatedTokenAccount(account, mint)
  const writable: readonly [string, AccountRole][] = [
    [account, AccountRole.WRITABLE_SIGNER],
    [tokens, AccountRole.WRITABLE],
    [stream.recipient, AccountRole.WRITABLE],
    [metadata, AccountRole.WRITABLE],
    [escrowAddress(metadata), AccountRole.WRITABLE],
    [associatedTokenAccount(stream.recipient, mint), AccountRole.WRITABLE],
    [STREAMFLOW_TREASURY, AccountRole.WRITABLE],
    [associatedTokenAccount(STREAMFLOW_TREASURY, mint), AccountRole.WRITABLE],
    [STREAMFLOW_WITHDRAWOR, AccountRole.WRITABLE],
    // The partner's fee would go here. Naming the person keeps it from reaching anyone else.
    [account, AccountRole.WRITABLE],
    [tokens, AccountRole.WRITABLE],
    [mint, AccountRole.READONLY],
    [STREAMFLOW_FEE_ORACLE, AccountRole.READONLY],
    [RENT_SYSVAR, AccountRole.READONLY],
    [STREAMFLOW_PROGRAM, AccountRole.READONLY],
    [TOKEN_PROGRAM, AccountRole.READONLY],
    [ASSOCIATED_TOKEN_PROGRAM, AccountRole.READONLY],
    [SYSTEM_PROGRAM, AccountRole.READONLY],
  ]
  return writable
}

function compile(
  account: string,
  stream: AskedStream,
  nonce: number,
  lifetime: { blockhash: string; lastValidBlockHeight: number }
): string {
  const limit = Buffer.alloc(5)
  limit.writeUInt8(SET_COMPUTE_UNIT_LIMIT)
  limit.writeUInt32LE(COMPUTE_UNIT_LIMIT, 1)
  const price = Buffer.alloc(9)
  price.writeUInt8(SET_COMPUTE_UNIT_PRICE)
  price.writeBigUInt64LE(COMPUTE_UNIT_PRICE, 1)
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
          { programAddress: COMPUTE_BUDGET_PROGRAM as Address, data: Uint8Array.from(limit) },
          { programAddress: COMPUTE_BUDGET_PROGRAM as Address, data: Uint8Array.from(price) },
          {
            programAddress: STREAMFLOW_PROGRAM as Address,
            accounts: createAccounts(account, stream, nonce).map(([address, role]) => ({
              address: address as Address,
              role,
            })),
            data: Uint8Array.from(createData(stream, nonce)),
          },
        ],
        m
      )
  )
  return getBase64EncodedWireTransaction(compileTransaction(message))
}

interface Issued {
  recipient: string
  /** The token's id. */
  token: string
  /** Base units. */
  amount: string
  days: string
}

/**
 * Proves a stream came from this server. The browser hands `context` back at submit and could
 * change it along with the bytes, so every field that decides where funds go is signed, for this
 * venue and account. The prefix keeps this from passing as any other signature on the secret.
 */
function proofOf(account: string, issued: Issued, key: string): string {
  const message = JSON.stringify([
    account,
    issued.token,
    issued.amount,
    issued.recipient,
    issued.days,
  ])
  return createHmac('sha256', key).update(`streamflow-stream:${message}`).digest('base64url')
}

function readIssued(account: string, context: Record<string, string> | undefined): AskedStream {
  const notIssued = (): never => refuse('This stream’s details are not what this app issued.')
  const key = secret()
  const recipient = context?.['recipient']
  const tokenId = context?.['token']
  const amount = context?.['amount']
  const days = context?.['days']
  const proof = context?.['proof']
  if (
    key === undefined ||
    recipient === undefined ||
    tokenId === undefined ||
    amount === undefined ||
    days === undefined ||
    proof === undefined ||
    !sameProof(proof, proofOf(account, { recipient, token: tokenId, amount, days }, key))
  ) {
    return notIssued()
  }
  const token = SOLANA_TOKENS.find((t) => t.id === tokenId)
  return token === undefined
    ? notIssued()
    : { recipient, token, units: BigInt(amount), days: Number(days) }
}

/** The one call this transaction makes after its compute budget, seen in full. */
function onlyCall(base64: string): { accounts: (string | undefined)[]; data: Uint8Array } {
  const { messageBytes } = getTransactionDecoder().decode(bytesFromBase64(base64))
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes)
  if ('addressTableLookups' in message && (message.addressTableLookups?.length ?? 0) > 0) {
    refuse('This transaction uses a lookup table, which hides accounts from this check.')
  }
  const transaction = decodeSolanaTransaction(base64)
  const programs = transaction.instructions.map(
    (instruction) => transaction.staticAccounts[instruction.programIndex]
  )
  const call = transaction.instructions[programs.length - 1]
  const onlyBudgetFirst = programs
    .slice(0, -1)
    .every((program) => program === COMPUTE_BUDGET_PROGRAM)
  if (call === undefined || !onlyBudgetFirst || programs.at(-1) !== STREAMFLOW_PROGRAM) {
    return notTheStream()
  }
  return {
    accounts: call.accounts.map((index) => transaction.staticAccounts[index]),
    data: call.data,
  }
}

function assertSafe(
  payload: SigningPayload,
  account: string,
  context?: Record<string, string>
): void {
  const stream = readIssued(account, context)
  solanaAssertSafe(STREAMFLOW_POLICY)(payload, account)
  if (payload.family !== 'solana') return refuse('That is not a Solana transaction.')
  const { accounts, data } = onlyCall(payload.transaction)
  if (data.length !== INSTRUCTION_BYTES) notTheStream()
  const nonce = Buffer.from(data).readUInt32LE(NONCE_OFFSET)
  // Rebuilt from what was issued, so anything else in this call, however small, doesn't match.
  const expected = createAccounts(account, stream, nonce)
  const sameAccounts =
    accounts.length === expected.length &&
    expected.every(([address], position) => accounts[position] === address)
  if (!sameAccounts || !Buffer.from(createData(stream, nonce)).equals(data)) notTheStream()
}

interface WrittenFees {
  /** Base units of the token, on top of the stream. */
  token: string
  lamports: string
}

/**
 * The stream the program would write, from a dry run. What it costs is read here rather than from
 * the fee oracle, since the program's own arithmetic is what the person pays. Whoever runs the
 * oracle can change it, so a build that names anyone but who was asked for is refused too.
 */
function readWritten(data: string, account: string, stream: AskedStream): WrittenFees {
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length < STREAM.minimumBytes) unreadable()
  const addressAt = (offset: number): string =>
    getAddressDecoder().decode(bytes.subarray(offset, offset + 32))
  if (
    addressAt(STREAM.sender) !== account ||
    addressAt(STREAM.recipient) !== stream.recipient ||
    addressAt(STREAM.mint) !== stream.token.id ||
    addressAt(STREAM.treasury) !== STREAMFLOW_TREASURY ||
    addressAt(STREAM.partner) !== account ||
    bytes.readBigUInt64LE(STREAM.partnerFee) !== BigInt(0) ||
    bytes.readBigUInt64LE(STREAM.deposited) !== stream.units
  ) {
    notTheStream()
  }
  return {
    token: bytes.readBigUInt64LE(STREAM.tokenFee).toString(),
    lamports: String(bytes.readUInt32LE(STREAM.creationFee)),
  }
}

async function dryRun(
  rpc: SolanaRpc,
  transaction: string,
  account: string,
  stream: AskedStream,
  nonce: number
): Promise<WrittenFees> {
  const metadata = streamAddress(account, stream.token.id, nonce)
  const reply = RpcSimulation.safeParse(
    await rpc('simulateTransaction', [
      transaction,
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: [metadata] },
      },
    ])
  )
  if (!reply.success) return unreadable()
  const { err, accounts } = reply.data.result.value
  if (err !== null && err !== undefined) {
    refuse(
      `This stream would fail on the chain right now. Check your ${stream.token.symbol} balance, and that you have enough SOL for Streamflow’s fee and the rent.`
    )
  }
  const written = accounts?.[0]?.data[0]
  return written === undefined ? unreadable() : readWritten(written, account, stream)
}

function streamNotes(stream: AskedStream, fees: WrittenFees): string[] {
  const { recipient, token, days } = stream
  const length = `${days} ${days === 1 ? 'day' : 'days'}`
  return [
    `The full amount leaves your wallet now and sits in Streamflow's program. It unlocks evenly, hour by hour, for ${length}, starting when this lands.`,
    `On top of that, Streamflow takes ${fromBaseUnits(fees.token, token.decimals)} ${token.symbol} and ${fromBaseUnits(fees.lamports, 9)} SOL. Your wallet also pays about 0.008 SOL in rent, and about 0.0015 SOL more if that address has no ${token.symbol} account yet. You don't get the SOL back.`,
    `The money doesn't arrive by itself. ${recipient} has to withdraw what has streamed, at ${STREAMFLOW_APP} or by calling the program, and needs a little SOL for the network fee.`,
    `You can cancel until it ends, and only you can. What has streamed goes to ${recipient} and the rest comes back to you, so they can't count on it. This app can't cancel for you yet: use ${STREAMFLOW_APP} or call the program from this wallet.`,
    `Check that address is a wallet they can sign from. The stream stays with it and can't be moved to another address, and an exchange deposit address may not be able to claim it.`,
    `Whoever holds Streamflow's upgrade key can change this program, including how it treats funds already in it, and Streamflow can change its fees at any time. Neodyme's audit of May 2024 found no critical, high or medium issues and described a 3-of-5 multisig holding that key, but the program was last upgraded on 21 September 2026, so what runs now is not what they reviewed. DefiLlama's hack list shows no exploit.`,
  ]
}

export interface StreamflowOptions {
  /** For tests. */
  rpc?: SolanaRpc
}

export function createStreamflowVenue(options: StreamflowOptions = {}): ChainVenue {
  const rpc = options.rpc ?? defaultRpc

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    const key = secret()
    if (key === undefined) refuse('Streaming on Streamflow isn’t available here right now.')
    const stream = asked(request, account)
    await assertRecipientIsWallet(rpc, stream.recipient)

    const reply = RpcBlockhash.safeParse(
      await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])
    )
    if (!reply.success) return unreadable()
    const nonce = randomBytes(4).readUInt32LE()
    const transaction = compile(account, stream, nonce, reply.data.result.value)

    const issued: Issued = {
      recipient: stream.recipient,
      token: stream.token.id,
      amount: stream.units.toString(),
      days: String(stream.days),
    }
    const context = { ...issued, proof: proofOf(account, issued, key as string) }
    const signing: SigningPayload = { family: 'solana', transaction }
    assertSafe(signing, account, context)
    const fees = await dryRun(rpc, transaction, account, stream, nonce)

    const amount = request.amount.trim()
    const { days, token, recipient } = stream
    return {
      venueId: VENUE_ID,
      venueName: 'Streamflow',
      kind: 'stream',
      summary: `Streams ${amount} ${token.symbol} to ${recipient} over ${days} ${days === 1 ? 'day' : 'days'}.`,
      pay: { amount, symbol: token.symbol },
      notes: streamNotes(stream, fees),
      signing,
      context,
    }
  }

  return { id: VENUE_ID, name: 'Streamflow', kinds: ['stream'], prepare, assertSafe }
}
