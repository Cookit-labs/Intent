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
  type Instruction,
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
  type VenuePosition,
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
import { createTokenAccount, createTokenAccountRule } from './stake-pool'
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

/**
 * sha256("global:cancel"), then the ten empty bytes `cancelStreamInstruction` sends in
 * @streamflow/stream's solana/instructions.ts.
 */
const CANCEL = 'e8dbdf29dbecdcbe'
const CANCEL_DATA = Buffer.concat([Buffer.from(CANCEL, 'hex'), Buffer.alloc(10)])

export const STREAMFLOW_POLICY: SolanaVenuePolicy = {
  venueName: 'Streamflow',
  programs: { [STREAMFLOW_PROGRAM]: { discriminators: [CREATE_V2] } },
  mayWrapSol: false,
}

const STREAMFLOW_CANCEL_POLICY: SolanaVenuePolicy = {
  venueName: 'Streamflow',
  programs: { [STREAMFLOW_PROGRAM]: { discriminators: [CANCEL] } },
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
/**
 * Stream addresses come from a random number, so only an account index can list them. publicnode
 * refuses that without a token, and this node answered it on 5 November 2026.
 */
const INDEXED_RPC_URL = 'https://api.mainnet-beta.solana.com'

/** `METADATA_ACC_SIZE` in @streamflow/stream, which filters on it when it lists streams. */
const STREAM_ACCOUNT_BYTES = 1104

/** Offsets into a stream's account: `streamLayout` in @streamflow/stream, and a simulation of one. */
const STREAM = {
  canceledAt: 25,
  end: 33,
  sender: 49,
  recipient: 113,
  mint: 177,
  escrow: 209,
  treasury: 241,
  tokenFee: 305,
  partner: 325,
  partnerFee: 389,
  deposited: 417,
  period: 425,
  perPeriod: 433,
  cliff: 441,
  cliffAmount: 449,
  cancelableBySender: 457,
  closed: 671,
  creationFee: 704,
  minimumBytes: 708,
}

/** Where a token account keeps its balance. */
const TOKEN_AMOUNT_OFFSET = 64

function refuse(sentence: string): never {
  throw new ChainActionRefused(`${sentence} ${NOTHING_MOVED}`)
}

const notTheStream = (): never => refuse('This is not the stream you asked for.')
const unreadable = (): never => refuse('Solana’s network could not be read just now.')

export type SolanaRpc = (method: string, params: unknown[]) => Promise<unknown>

const rpcAt =
  (url: () => string): SolanaRpc =>
  async (method, params) => {
    const { status, body } = await venueFetch(url(), {
      label: 'Solana',
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method, params },
    })
    return status === 200 ? body : undefined
  }

const defaultRpc = rpcAt(() => process.env['SOLANA_RPC_URL']?.trim() || DEFAULT_RPC_URL)
const defaultIndexedRpc = rpcAt(() => INDEXED_RPC_URL)

const RpcAccount = z.object({
  result: z.object({ value: z.object({ owner: z.string() }).nullable() }),
})

const RpcAccountData = z.object({
  result: z.object({
    value: z.object({ owner: z.string(), data: z.tuple([z.string(), z.string()]) }).nullable(),
  }),
})

const RpcStreams = z.object({
  result: z.array(
    z.object({
      pubkey: z.string(),
      account: z.object({ owner: z.string(), data: z.tuple([z.string(), z.string()]) }),
    })
  ),
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
  accounts: readonly (readonly [string, AccountRole])[],
  data: Uint8Array,
  lifetime: { blockhash: string; lastValidBlockHeight: number },
  first: readonly Instruction[] = []
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
          ...first,
          {
            programAddress: STREAMFLOW_PROGRAM as Address,
            accounts: accounts.map(([address, role]) => ({
              address: address as Address,
              role,
            })),
            data: Uint8Array.from(data),
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

interface Call {
  program: string | undefined
  accounts: (string | undefined)[]
  data: Uint8Array
}

/** Every call after the compute budget, seen in full. */
function callsAfterBudget(base64: string): Call[] {
  const { messageBytes } = getTransactionDecoder().decode(bytesFromBase64(base64))
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes)
  if ('addressTableLookups' in message && (message.addressTableLookups?.length ?? 0) > 0) {
    refuse('This transaction uses a lookup table, which hides accounts from this check.')
  }
  const transaction = decodeSolanaTransaction(base64)
  const calls = transaction.instructions.map((instruction) => ({
    program: transaction.staticAccounts[instruction.programIndex],
    accounts: instruction.accounts.map((index) => transaction.staticAccounts[index]),
    data: instruction.data,
  }))
  const rest = calls.slice(calls.findIndex((call) => call.program !== COMPUTE_BUDGET_PROGRAM))
  return rest.some((call) => call.program === COMPUTE_BUDGET_PROGRAM) ? notTheStream() : rest
}

/** The one call this transaction makes after its compute budget. */
function onlyCall(base64: string): Call {
  const [call, ...others] = callsAfterBudget(base64)
  return call === undefined || others.length > 0 || call.program !== STREAMFLOW_PROGRAM
    ? notTheStream()
    : call
}

interface CancelTerms {
  stream: string
  /** The token's id. */
  token: string
  recipient: string
  partner: string
  escrow: string
}

/**
 * The accounts come from the stream as it was read, and go back into `assertSafe` under a proof.
 * The program checks each against the stream, and the treasury is the one it pins.
 */
function cancelAccounts(account: string, terms: CancelTerms): readonly [string, AccountRole][] {
  const { stream, token, recipient, partner, escrow } = terms
  return [
    [account, AccountRole.WRITABLE_SIGNER],
    [account, AccountRole.WRITABLE],
    [associatedTokenAccount(account, token), AccountRole.WRITABLE],
    [recipient, AccountRole.WRITABLE],
    [associatedTokenAccount(recipient, token), AccountRole.WRITABLE],
    [stream, AccountRole.WRITABLE],
    [escrow, AccountRole.WRITABLE],
    [STREAMFLOW_TREASURY, AccountRole.WRITABLE],
    [associatedTokenAccount(STREAMFLOW_TREASURY, token), AccountRole.WRITABLE],
    [partner, AccountRole.WRITABLE],
    [associatedTokenAccount(partner, token), AccountRole.WRITABLE],
    [token, AccountRole.WRITABLE],
    [TOKEN_PROGRAM, AccountRole.READONLY],
  ]
}

function cancelProofOf(account: string, terms: CancelTerms, key: string): string {
  const message = JSON.stringify([
    account,
    terms.stream,
    terms.token,
    terms.recipient,
    terms.partner,
    terms.escrow,
  ])
  return createHmac('sha256', key).update(`streamflow-cancel:${message}`).digest('base64url')
}

function assertCancelSafe(
  payload: SigningPayload,
  account: string,
  context: Record<string, string>
): void {
  const key = secret()
  const { stream, token, recipient, partner, escrow, proof } = context
  if (
    key === undefined ||
    stream === undefined ||
    token === undefined ||
    recipient === undefined ||
    partner === undefined ||
    escrow === undefined ||
    proof === undefined ||
    !sameProof(proof, cancelProofOf(account, { stream, token, recipient, partner, escrow }, key))
  ) {
    return refuse('This stream’s details are not what this app issued.')
  }
  solanaAssertSafe(STREAMFLOW_CANCEL_POLICY)(payload, account)
  if (payload.family !== 'solana') return refuse('That is not a Solana transaction.')
  const [open, call, ...others] = callsAfterBudget(payload.transaction)
  const opens = createTokenAccountRule(account, token)
  const opensOwn =
    open?.program === opens.program &&
    open.accounts.length === opens.accountCount &&
    Buffer.from(open.data).toString('hex') === opens.prefix &&
    Object.entries(opens.accounts).every(
      ([position, address]) => open.accounts[Number(position)] === address
    )
  const expected = cancelAccounts(account, { stream, token, recipient, partner, escrow })
  const cancels =
    call?.program === STREAMFLOW_PROGRAM &&
    call.accounts.length === expected.length &&
    expected.every(([address], position) => call.accounts[position] === address) &&
    CANCEL_DATA.equals(call.data)
  if (!opensOwn || !cancels || others.length > 0) notTheStream()
}

function assertSafe(
  payload: SigningPayload,
  account: string,
  context?: Record<string, string>
): void {
  if (context?.['action'] === 'cancel') return assertCancelSafe(payload, account, context)
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

function streamNotes(stream: AskedStream, fees: WrittenFees, id: string): string[] {
  const { recipient, token, days } = stream
  const length = `${days} ${days === 1 ? 'day' : 'days'}`
  return [
    `The full amount leaves your wallet now and sits in Streamflow's program. It unlocks evenly, hour by hour, for ${length}, starting when this lands.`,
    `On top of that, Streamflow takes ${fromBaseUnits(fees.token, token.decimals)} ${token.symbol} and ${fromBaseUnits(fees.lamports, 9)} SOL. Your wallet also pays about 0.008 SOL in rent, and about 0.0015 SOL more if that address has no ${token.symbol} account yet. You don't get the SOL back.`,
    `The money doesn't arrive by itself. ${recipient} has to withdraw what has streamed, at ${STREAMFLOW_APP} or by calling the program, and needs a little SOL for the network fee.`,
    `You can cancel until it ends, and only you can. What has streamed goes to ${recipient} and the rest comes back to you, so they can't count on it. To do that here, say "cancel stream ${id}". ${STREAMFLOW_APP} can do it too.`,
    `Check that address is a wallet they can sign from. The stream stays with it and can't be moved to another address, and an exchange deposit address may not be able to claim it.`,
    `Whoever holds Streamflow's upgrade key can change this program, including how it treats funds already in it, and Streamflow can change its fees at any time. Neodyme's audit of May 2024 found no critical, high or medium issues and described a 3-of-5 multisig holding that key, but the program was last upgraded on 21 September 2026, so what runs now is not what they reviewed. DefiLlama's hack list shows no exploit.`,
  ]
}

interface ReadStream {
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
  cancelableBySender: boolean
  closed: boolean
}

function decodeStream(bytes: Buffer): ReadStream | undefined {
  if (bytes.length < STREAM.minimumBytes) return undefined
  const addressAt = (offset: number): string =>
    getAddressDecoder().decode(bytes.subarray(offset, offset + 32))
  return {
    sender: addressAt(STREAM.sender),
    recipient: addressAt(STREAM.recipient),
    mint: addressAt(STREAM.mint),
    escrow: addressAt(STREAM.escrow),
    treasury: addressAt(STREAM.treasury),
    partner: addressAt(STREAM.partner),
    deposited: bytes.readBigUInt64LE(STREAM.deposited),
    period: bytes.readBigUInt64LE(STREAM.period),
    perPeriod: bytes.readBigUInt64LE(STREAM.perPeriod),
    cliff: bytes.readBigUInt64LE(STREAM.cliff),
    cliffAmount: bytes.readBigUInt64LE(STREAM.cliffAmount),
    end: bytes.readBigUInt64LE(STREAM.end),
    canceledAt: bytes.readBigUInt64LE(STREAM.canceledAt),
    cancelableBySender: bytes[STREAM.cancelableBySender] !== 0,
    closed: bytes[STREAM.closed] !== 0,
  }
}

/**
 * `calculateUnlockedAmount` in @streamflow/stream, without the pause and rate change that streams
 * from here switch off. On a stream from elsewhere this is an estimate. A cancel's own figure comes
 * from the program, in a dry run.
 */
function notYetStreamed(stream: ReadStream, nowSeconds: bigint): bigint {
  if (nowSeconds >= stream.end) return BigInt(0)
  if (nowSeconds < stream.cliff) return stream.deposited
  const periods =
    stream.period === BigInt(0) ? BigInt(0) : (nowSeconds - stream.cliff) / stream.period
  const unlocked = stream.cliffAmount + periods * stream.perPeriod
  return unlocked >= stream.deposited ? BigInt(0) : stream.deposited - unlocked
}

function streamableToken(mint: string): ChainToken | undefined {
  const token = SOLANA_TOKENS.find((t) => t.id === mint)
  return token !== undefined && STREAMABLE.includes(token.symbol) ? token : undefined
}

function cancelNotes(stream: ReadStream, id: string, token: ChainToken, back: string): string[] {
  return [
    `This ends stream ${id} now. ${back} ${token.symbol} comes back to your wallet, read from a dry run of Streamflow's program just now. It can be a little less by the time this lands, because more unlocks each hour.`,
    `What has already unlocked goes to ${stream.recipient} in this same step, if they haven't withdrawn it already.`,
    `Streamflow keeps its token fee on what unlocked, and what you paid towards the rest of that fee comes back with the amount above. The SOL fee and rent paid when the stream started don't come back. Your wallet pays a small network fee.`,
    `This calls Streamflow's program directly and needs only your signature. It first reopens your ${token.symbol} account if you closed it, for about 0.002 SOL of rent. ${STREAMFLOW_APP} can do the same.`,
  ]
}

export interface StreamflowOptions {
  /** For tests. */
  rpc?: SolanaRpc
  /** For tests. Asked to list streams when `rpc` refuses to. */
  indexedRpc?: SolanaRpc
  /** For tests. Milliseconds. */
  now?: () => number
}

export function createStreamflowVenue(options: StreamflowOptions = {}): ChainVenue {
  const rpc = options.rpc ?? defaultRpc
  const indexedRpc = options.indexedRpc ?? defaultIndexedRpc
  const now = options.now ?? Date.now

  async function prepareCancel(
    request: ChainActionRequest,
    account: string
  ): Promise<PreparedAction> {
    if (!isAddress(account)) refuse('That is not a Solana wallet address.')
    const id = request.streamId
    if (id === undefined || !isAddress(id)) return refuse('That isn’t a stream’s id.')
    const key = secret()
    if (key === undefined) {
      return refuse(
        `Cancelling a stream isn’t available here right now. You can cancel it at ${STREAMFLOW_APP} from this wallet.`
      )
    }

    const reply = RpcAccountData.safeParse(
      await rpc('getAccountInfo', [id, { encoding: 'base64', commitment: 'confirmed' }])
    )
    if (!reply.success) return unreadable()
    const held = reply.data.result.value
    const stream =
      held === null || held.owner !== STREAMFLOW_PROGRAM
        ? undefined
        : decodeStream(Buffer.from(held.data[0], 'base64'))
    if (stream === undefined) return refuse('There is no stream with that id on Streamflow.')
    if (stream.sender !== account) return refuse('This wallet didn’t start that stream.')
    if (stream.closed || stream.canceledAt !== BigInt(0)) {
      return refuse('That stream has already ended.')
    }
    if (!stream.cancelableBySender) {
      return refuse('That stream was set up so that it can’t be cancelled.')
    }
    if (stream.treasury !== STREAMFLOW_TREASURY) {
      return refuse('That stream doesn’t name Streamflow’s own treasury, so I stopped.')
    }
    const token = streamableToken(stream.mint)
    if (token === undefined) {
      return refuse(
        `Only streams of ${STREAMABLE.join(' or ')} can be cancelled here. You can cancel this one at ${STREAMFLOW_APP} from this wallet.`
      )
    }

    const terms: CancelTerms = {
      stream: id,
      token: token.id,
      recipient: stream.recipient,
      partner: stream.partner,
      escrow: stream.escrow,
    }
    const blockhash = RpcBlockhash.safeParse(
      await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])
    )
    if (!blockhash.success) return unreadable()
    const transaction = compile(
      account,
      cancelAccounts(account, terms),
      CANCEL_DATA,
      blockhash.data.result.value,
      // A real stream on 5 November 2026 could not refund its sender, who had closed this account.
      [createTokenAccount(account, token.id)]
    )
    const context = {
      action: 'cancel',
      ...terms,
      proof: cancelProofOf(account, terms, key),
    }
    const signing: SigningPayload = { family: 'solana', transaction }
    assertSafe(signing, account, context)

    const own = associatedTokenAccount(account, token.id)
    const before = RpcAccountData.safeParse(
      await rpc('getAccountInfo', [own, { encoding: 'base64', commitment: 'confirmed' }])
    )
    if (!before.success) return unreadable()
    const simulated = RpcSimulation.safeParse(
      await rpc('simulateTransaction', [
        transaction,
        {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'confirmed',
          accounts: { encoding: 'base64', addresses: [own] },
        },
      ])
    )
    if (!simulated.success) return unreadable()
    const { err, accounts } = simulated.data.result.value
    const written = accounts?.[0]?.data[0]
    if (err !== null && err !== undefined) {
      return refuse(
        `This cancel would fail on the chain right now. Check that you have a little SOL for the network fee, and that ${stream.recipient} still has a ${token.symbol} account, since they have to be paid what has unlocked. You can also try ${STREAMFLOW_APP}.`
      )
    }
    if (written === undefined) return unreadable()
    const amountIn = (held: string | undefined): bigint => {
      const bytes = Buffer.from(held ?? '', 'base64')
      return bytes.length < TOKEN_AMOUNT_OFFSET + 8
        ? BigInt(0)
        : bytes.readBigUInt64LE(TOKEN_AMOUNT_OFFSET)
    }
    const gained = amountIn(written) - amountIn(before.data.result.value?.data[0])
    if (gained <= BigInt(0)) {
      return refuse(
        'A dry run of this cancel paid you nothing back, so it has probably fully unlocked.'
      )
    }
    const back = fromBaseUnits(gained.toString(), token.decimals)
    return {
      venueId: VENUE_ID,
      venueName: 'Streamflow',
      kind: 'cancel',
      summary: `Ends stream ${id} and returns about ${back} ${token.symbol} to your wallet.`,
      pay: { amount: back, symbol: token.symbol },
      receive: { amount: back, symbol: token.symbol, approximate: true },
      notes: cancelNotes(stream, id, token, back),
      signing,
      context,
    }
  }

  async function positions(account: string): Promise<VenuePosition[]> {
    if (!isAddress(account)) refuse('That is not a Solana wallet address.')
    const params = [
      STREAMFLOW_PROGRAM,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        filters: [
          { dataSize: STREAM_ACCOUNT_BYTES },
          { memcmp: { offset: STREAM.sender, bytes: account } },
        ],
      },
    ]
    let listed: z.infer<typeof RpcStreams>['result'] | undefined
    for (const read of [rpc, indexedRpc]) {
      const reply = RpcStreams.safeParse(
        await read('getProgramAccounts', params).catch(() => undefined)
      )
      if (reply.success) {
        listed = reply.data.result
        break
      }
    }
    if (listed === undefined) return unreadable()
    const nowSeconds = BigInt(Math.floor(now() / 1000))
    return listed.flatMap(({ pubkey, account: held }) => {
      if (held.owner !== STREAMFLOW_PROGRAM) return []
      const stream = decodeStream(Buffer.from(held.data[0], 'base64'))
      const token = stream === undefined ? undefined : streamableToken(stream.mint)
      if (
        stream === undefined ||
        token === undefined ||
        stream.sender !== account ||
        stream.closed ||
        stream.canceledAt !== BigInt(0) ||
        !stream.cancelableBySender
      ) {
        return []
      }
      const left = notYetStreamed(stream, nowSeconds)
      if (left === BigInt(0)) return []
      return [
        {
          slot: 'supplied' as const,
          symbol: token.symbol,
          amount: fromBaseUnits(left.toString(), token.decimals),
          id: pubkey,
        },
      ]
    })
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    if (request.kind === 'cancel') return prepareCancel(request, account)
    const key = secret()
    if (key === undefined) refuse('Streaming on Streamflow isn’t available here right now.')
    const stream = asked(request, account)
    await assertRecipientIsWallet(rpc, stream.recipient)

    const reply = RpcBlockhash.safeParse(
      await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])
    )
    if (!reply.success) return unreadable()
    const nonce = randomBytes(4).readUInt32LE()
    const transaction = compile(
      account,
      createAccounts(account, stream, nonce),
      createData(stream, nonce),
      reply.data.result.value
    )

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
      notes: streamNotes(stream, fees, streamAddress(account, token.id, nonce)),
      signing,
      context,
    }
  }

  return {
    id: VENUE_ID,
    name: 'Streamflow',
    kinds: ['stream', 'cancel'],
    positions,
    prepare,
    assertSafe,
  }
}
