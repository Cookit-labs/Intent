import { createHmac, timingSafeEqual } from 'node:crypto'

import { TransactionDataBuilder } from '@mysten/sui/transactions'
import { fromBase64, normalizeStructTag } from '@mysten/sui/utils'

import { walletSends } from '../weave/cashout-view'
import { solanaDeposit } from '../weave/deposit/solana'
import { suiDeposit } from '../weave/deposit/sui'
import type { DepositChain, DepositExpectation } from '../weave/types'
import { evmDeposit } from './evm/deposit'
import { EVM_HASH, sameAddress } from './evm/submit'
import { EVM_CHAINS, EVM_NATIVE_ID, evmExplorerUrl, type EvmChain } from './evm/tokens'
import { depositStatus, listTokens, notifyDeposit, type OneClickToken } from './near/oneclick'
import {
  assertNoDepositMemo,
  costNote,
  depositNote,
  EXPLORER_NOTE,
  liveOneClick,
  ONECLICK_RISK_NOTE,
  previewOneClick,
  type CostWording,
  type Destination,
  type QuoteOrigin,
} from './near/swap'
import { formatUnits } from './near/tokens'
import { explorerUrl as solanaExplorerUrl, feePayerSignature } from './solana/submit'
import { SOLANA_TOKENS } from './solana/tokens'
import { SUI_TOKENS } from './sui/tokens'
import {
  ChainActionRefused,
  tokenBySymbol,
  withArticle,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SignedPayload,
  type SigningPayload,
  type SubmitInput,
  type SubmitResult,
  type VenueQuote,
} from './types'

/**
 * NEAR Intents 1Click as a swap route on a chain other than NEAR. The wallet signs one
 * transfer to a one-time deposit address, and 1Click pays the swap out on the same chain.
 *
 * The browser carries `context` between prepare and submit, so nothing in it is believed
 * until `readIssued` proves this server wrote it. See `proofOf`.
 */

export type OneClickOriginChain = 'solana' | 'sui' | 'avalanche' | 'monad'

const VENUE_NAME = 'NEAR Intents 1Click'

/** What 1Click calls each chain in its token list. */
const BLOCKCHAIN: Record<OneClickOriginChain, string> = {
  solana: 'sol',
  sui: 'sui',
  avalanche: 'avax',
  monad: 'monad',
}

/** All that's spent through 1Click on a chain with a swap of its own, which takes the native coins. */
const SPENDABLE = new Set(['USDC', 'USDT'])

/**
 * The limits inside the submit route's 60 seconds. The status wait counts from the start and
 * includes the confirm wait. One last status request and a pause on top keep it under 60.
 */
const CONFIRM_WAIT_MS = 40_000
const STATUS_WAIT_MS = 50_000
const STATUS_POLL_MS = 2_000

const COST_WORDING: CostWording = {
  withdrawFor: 'to deliver it to you',
  total: "After 1Click's costs, and before your wallet's network costs,",
}

/**
 * Rent for a Solana token account of 165 bytes, in SOL. Every swap pays a new deposit address,
 * whose token account the transaction opens from this wallet and nobody returns. It is treated
 * as always due: a dry quote has no address to look up, and a one-time address has no account
 * yet, so a read at Review would only confirm it. If one somehow exists the transaction opens
 * nothing and this overstates by the rent, which errs against 1Click, not the person.
 */
const SOLANA_DEPOSIT_RENT_SOL = '0.00203928'

const SOLANA_RENT_NOTE =
  "Your wallet also pays about 0.00204 SOL in rent to open a token account at the deposit address, and you don't get it back. Every swap uses a new address, so this is due each time."

interface Origin {
  chainName: string
  family: 'solana' | 'sui' | 'evm'
  tokens: readonly ChainToken[]
  /** The token id that stands for the native coin, which 1Click lists with no contract. */
  nativeId: string
  /**
   * Whether that id is the native coin itself. A mint for wrapped SOL is not SOL: paying out to
   * it would leave wrapped tokens while the card says SOL. Sui's coin type is SUI itself.
   */
  nativeIdIsTheCoin: boolean
  /** What the wallet pays beyond the transfer and the fee, with the sentence that says so. */
  walletCost?: { amount: string; symbol: string; note: string }
  /** The chain's own swap, which takes what 1Click doesn't here. Absent where 1Click is the only one. */
  ownSwap?: string
  deposit: Pick<DepositChain, 'isAccount' | 'isDepositAddress' | 'build' | 'assertSafe' | 'submit'>
  /**
   * Reads what the wallet holds before a deposit address is asked for, where the build won't.
   * Answers with any notes the card should carry about what it read.
   */
  assertFunds?: (account: string, token: ChainToken, amount: string) => Promise<string[]>
  /** The chain's identifier for signed bytes, known before the network has answered. */
  hashOf: (signed: SignedPayload) => string | undefined
  explorerUrl: (hash: string) => string
}

function suiExplorerUrl(hash: string): string {
  return `https://suiscan.xyz/mainnet/tx/${hash}`
}

function evmOrigin(chain: EvmChain): Origin {
  const deposit = evmDeposit(chain)
  const { name, tokens } = EVM_CHAINS[chain]
  return {
    chainName: name,
    family: 'evm',
    tokens,
    nativeId: EVM_NATIVE_ID,
    nativeIdIsTheCoin: false,
    deposit,
    assertFunds: deposit.assertFunds,
    hashOf: (signed) =>
      signed.family === 'evm' && EVM_HASH.test(signed.hash) ? signed.hash : undefined,
    explorerUrl: (hash) => evmExplorerUrl(chain, hash),
  }
}

const ORIGINS: Record<OneClickOriginChain, Origin> = {
  avalanche: evmOrigin('avalanche'),
  monad: evmOrigin('monad'),
  solana: {
    chainName: 'Solana',
    family: 'solana',
    tokens: SOLANA_TOKENS,
    nativeId: 'So11111111111111111111111111111111111111112',
    nativeIdIsTheCoin: false,
    walletCost: { amount: SOLANA_DEPOSIT_RENT_SOL, symbol: 'SOL', note: SOLANA_RENT_NOTE },
    ownSwap: 'Jupiter',
    deposit: solanaDeposit,
    hashOf: (signed) =>
      signed.family === 'solana' ? feePayerSignature(signed.signedTransaction) : undefined,
    explorerUrl: solanaExplorerUrl,
  },
  sui: {
    chainName: 'Sui',
    family: 'sui',
    tokens: SUI_TOKENS,
    nativeId: '0x2::sui::SUI',
    nativeIdIsTheCoin: true,
    ownSwap: 'Cetus',
    deposit: suiDeposit,
    hashOf: (signed) =>
      signed.family === 'sui'
        ? TransactionDataBuilder.getDigestFromBytes(fromBase64(signed.transaction))
        : undefined,
    explorerUrl: suiExplorerUrl,
  },
}

/** The form two copies of a contract compare in. Case is part of a base58 mint, so it stays. */
function normalizeContract(chain: OneClickOriginChain, contract: string): string {
  if (chain === 'solana') return contract
  if (chain !== 'sui') return contract.toLowerCase()
  try {
    return normalizeStructTag(contract)
  } catch {
    return contract
  }
}

/**
 * The 1Click asset for a token, matched on chain and contract. The list repeats symbols, and
 * anyone can name a token USDC, so a symbol alone never matches. Two entries for one contract
 * leave no way to say which is real, so that is no match either.
 *
 * A native coin has no contract, so it matches only as the chain's own native token id, against
 * the one entry with its symbol and no contract. A contract that merely wraps it never matches,
 * since what would arrive is not what the card says.
 */
export async function oneClickAssetId(
  chain: OneClickOriginChain,
  token: ChainToken
): Promise<string | undefined> {
  const entries = (await listTokens()).filter(
    (entry) => entry.blockchain === BLOCKCHAIN[chain] && entry.decimals === token.decimals
  )
  const wanted = normalizeContract(chain, token.id)
  const hasContract = (entry: OneClickToken): boolean =>
    entry.contractAddress !== undefined &&
    entry.contractAddress !== null &&
    entry.contractAddress !== ''
  const isContract = (entry: OneClickToken): boolean =>
    hasContract(entry) && normalizeContract(chain, entry.contractAddress as string) === wanted

  const origin = ORIGINS[chain]
  const matching =
    token.id === origin.nativeId
      ? entries.filter(
          (entry) =>
            entry.symbol.toUpperCase() === token.symbol.toUpperCase() &&
            (!hasContract(entry) || (origin.nativeIdIsTheCoin && isContract(entry)))
        )
      : entries.filter(isContract)
  return matching.length === 1 ? matching[0]?.assetId : undefined
}

function secret(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env['AUTH_SECRET']
  return value !== undefined && value.length >= 32 ? value : undefined
}

/** Whether a chain should offer this venue at all. Nothing can be issued safely without it. */
export function canIssueOneClick(env: Record<string, string | undefined>): boolean {
  return secret(env) !== undefined
}

/** Without the secret nothing could be issued safely at Review, so no route is offered at all. */
function signingKey(): string {
  const key = secret()
  if (key === undefined) {
    throw new ChainActionRefused(`${VENUE_NAME} isn't available here right now.`)
  }
  return key
}

interface Issued {
  depositAddress: string
  /** The token's id. */
  token: string
  /** Base units. */
  amount: string
  deadline: string
}

/**
 * Proves a deposit came from this server. The browser hands `context` back at submit, and
 * could change it along with the bytes it wants sent, so every field that decides where funds
 * go is signed here, for this venue and this account. The prefix keeps this signature from
 * ever passing as a session's, which shares the secret.
 */
function proofOf(venueId: string, account: string, issued: Issued, key: string): string {
  const message = JSON.stringify([
    venueId,
    account,
    issued.token,
    issued.amount,
    issued.depositAddress,
    issued.deadline,
  ])
  return createHmac('sha256', key).update(`oneclick-origin:${message}`).digest('base64url')
}

function sameProof(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function notIssued(): never {
  throw new ChainActionRefused(
    "This swap's details are not what this app issued, so nothing was sent. Get a fresh quote and sign that."
  )
}

/**
 * The deposit this server issued, or a refusal. Never returns anything it did not sign.
 *
 * `deadlineMatters` is false once a wallet has sent for itself: an expired quote then can't mean
 * nothing was sent, so the transfer is followed and 1Click says what became of it.
 */
function readIssued(
  origin: Origin,
  venueId: string,
  account: string,
  context: Record<string, string> | undefined,
  deadlineMatters = true
): DepositExpectation {
  const key = secret()
  const depositAddress = context?.['depositAddress']
  const tokenId = context?.['token']
  const amount = context?.['amount']
  const deadline = context?.['deadline']
  const proof = context?.['proof']
  if (
    key === undefined ||
    depositAddress === undefined ||
    tokenId === undefined ||
    amount === undefined ||
    deadline === undefined ||
    proof === undefined ||
    !sameProof(
      proof,
      proofOf(venueId, account, { depositAddress, token: tokenId, amount, deadline }, key)
    )
  ) {
    return notIssued()
  }
  const token = origin.tokens.find((t) => t.id === tokenId)
  if (token === undefined) return notIssued()
  if (deadlineMatters && !(Date.parse(deadline) > Date.now())) {
    throw new ChainActionRefused(
      'This quote expired before it was sent, so nothing was sent. Get a fresh quote and sign right away.'
    )
  }
  return {
    account,
    depositAddress,
    memo: undefined,
    amount: formatUnits(amount, token.decimals, token.decimals),
    token,
  }
}

interface Route {
  tokenIn: ChainToken
  tokenOut: ChainToken
  origin: QuoteOrigin
  destination: Destination
}

/** What the swap would touch, or the sentence for why not. A refusal drops the route from the race. */
async function routeFor(
  origin: Origin,
  chain: OneClickOriginChain,
  request: ChainActionRequest,
  account: string
): Promise<Route> {
  if (request.kind !== 'swap') {
    throw new ChainActionRefused(`${VENUE_NAME} swaps tokens. It can't ${request.kind} here.`)
  }
  if (!origin.deposit.isAccount(account)) {
    throw new ChainActionRefused(`That is not ${withArticle(origin.chainName)} wallet address.`)
  }
  const tokenIn = tokenBySymbol(origin.tokens, request.tokenIn)
  const tokenOut = tokenBySymbol(origin.tokens, request.tokenOut ?? '')
  if (tokenIn === undefined || tokenOut === undefined) {
    throw new ChainActionRefused(`I can only swap tokens I have confirmed on ${origin.chainName}.`)
  }
  if (tokenIn.id === tokenOut.id) throw new ChainActionRefused('Those are the same token.')
  if (origin.ownSwap !== undefined && !SPENDABLE.has(tokenIn.symbol)) {
    throw new ChainActionRefused(
      `${VENUE_NAME} here spends USDC or USDT, not ${tokenIn.symbol}. ${origin.ownSwap} can swap ${tokenIn.symbol}.`
    )
  }

  let ids: [string | undefined, string | undefined]
  try {
    ids = await Promise.all([oneClickAssetId(chain, tokenIn), oneClickAssetId(chain, tokenOut)])
  } catch {
    throw new ChainActionRefused(
      "NEAR Intents isn't answering right now. Try again in a minute. Nothing was signed or sent."
    )
  }
  const [originAsset, destinationAsset] = ids
  if (originAsset === undefined || destinationAsset === undefined) {
    const missing = originAsset === undefined ? tokenIn.symbol : tokenOut.symbol
    throw new ChainActionRefused(
      `${VENUE_NAME} doesn't list ${missing} on ${origin.chainName}. Nothing was signed or sent.`
    )
  }
  return {
    tokenIn,
    tokenOut,
    origin: { assetId: originAsset, decimals: tokenIn.decimals },
    destination: {
      assetId: destinationAsset,
      symbol: tokenOut.symbol,
      decimals: tokenOut.decimals,
      recipientType: 'DESTINATION_CHAIN',
    },
  }
}

function stillProcessing(hash: string, depositAddress: string): SubmitResult {
  return {
    ok: false,
    pending: true,
    error: `Your deposit was sent (${hash}) and the swap is still processing, which can take up to 15 minutes. Don't send it again. ${EXPLORER_NOTE} ${depositAddress}.`,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Sends through the chain's own deposit submit, which checks the bytes again first. Its
 * refusals only ever come before the send, so they prove nothing moved. Anything else thrown,
 * or no answer inside the limit, leaves open that the transfer went out. So does any refusal
 * where the wallet sent for itself, since there was no send here for it to come before.
 */
async function send(
  origin: Origin,
  signed: SignedPayload,
  expectation: DepositExpectation
): Promise<SubmitResult> {
  const unconfirmed = (): SubmitResult => {
    const hash = origin.hashOf(signed)
    const where = hash === undefined ? "your wallet's activity" : origin.explorerUrl(hash)
    return {
      ok: false,
      pending: true,
      error: `This may have been sent and isn't confirmed yet, so don't send it again. Check ${where} first.`,
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), CONFIRM_WAIT_MS)
  })
  try {
    return (
      (await Promise.race([origin.deposit.submit(signed, expectation), limit])) ?? unconfirmed()
    )
  } catch (e) {
    return e instanceof ChainActionRefused && !walletSends(origin.family)
      ? { ok: false, error: e.message }
      : unconfirmed()
  } finally {
    clearTimeout(timer)
  }
}

/** The venue behind a 1Click swap from `chain`. */
export function oneClickOriginVenue(chain: OneClickOriginChain): ChainVenue {
  const venueId = `1click-${chain}`

  const origin = ORIGINS[chain]

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const route = await routeFor(origin, chain, request, account)
    signingKey()
    const { preview } = await previewOneClick(
      request.amount,
      route.origin,
      route.destination,
      account
    )
    // Only what arrives, not 1Click's own dollar figure. The other routes on this chain are
    // valued by the chain's price source, and a gap between two sources could outweigh a gap
    // between two routes, letting the one that delivers less win.
    const cost = origin.walletCost
    return {
      receive: {
        amount: formatUnits(preview.quote.amountOut, route.destination.decimals),
        symbol: route.destination.symbol,
      },
      ...(cost !== undefined ? { walletCost: { amount: cost.amount, symbol: cost.symbol } } : {}),
    }
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    const {
      tokenIn,
      tokenOut,
      origin: spending,
      destination,
    } = await routeFor(origin, chain, request, account)
    const key = signingKey()
    // Before the real quote, so someone who can't pay never gets a deposit address made.
    const fundsNotes = (await origin.assertFunds?.(account, tokenIn, request.amount)) ?? []
    const { shared } = await previewOneClick(request.amount, spending, destination, account)
    const { live, loss, deadline } = await liveOneClick(shared, spending, destination)

    const { depositAddress } = live.quote
    if (depositAddress === undefined || !origin.deposit.isDepositAddress(depositAddress)) {
      throw new ChainActionRefused(
        "NEAR Intents' deposit address didn't look right, so it was not used. Nothing was signed or sent."
      )
    }
    assertNoDepositMemo(live)

    const signing = await origin.deposit.build({
      account,
      depositAddress,
      memo: undefined,
      amount: request.amount,
      token: tokenIn,
    })

    const issued: Issued = { depositAddress, token: tokenIn.id, amount: shared.amount, deadline }
    return {
      venueId,
      venueName: VENUE_NAME,
      kind: 'swap',
      summary: `Swap ${request.amount} ${tokenIn.symbol} for ${tokenOut.symbol} through NEAR Intents, into your ${origin.chainName} account.`,
      pay: { amount: request.amount, symbol: tokenIn.symbol },
      receive: {
        amount: formatUnits(live.quote.amountOut, destination.decimals),
        symbol: destination.symbol,
        approximate: true,
      },
      notes: [
        costNote(live, loss, destination.symbol, destination.decimals, COST_WORDING),
        ...(origin.walletCost !== undefined ? [origin.walletCost.note] : []),
        ...fundsNotes,
        depositNote(live, tokenIn, account),
        ONECLICK_RISK_NOTE,
      ],
      signing,
      context: { ...issued, proof: proofOf(venueId, account, issued, key) },
    }
  }

  function assertSafe(
    payload: SigningPayload,
    account: string,
    context?: Record<string, string>
  ): void {
    origin.deposit.assertSafe(payload, readIssued(origin, venueId, account, context))
  }

  /**
   * Every `{ ok: false }` without `pending` here comes before the transfer was sent, or from
   * the chain's own submit having proved it did not move. Once the network has the transfer,
   * a swap that fails at 1Click still has funds in flight or on their way back, so that is
   * always pending and the latch stays closed.
   *
   * A wallet that sends for itself has already sent by the time anything arrives here. So on
   * those chains a refusal below can't say nothing was sent, and it is pending too.
   */
  async function submit(input: SubmitInput): Promise<SubmitResult> {
    const { account, signed, context } = input
    const sends = walletSends(origin.family)
    const notFollowed = (why: string): SubmitResult => {
      const hash = origin.hashOf(signed)
      return {
        ok: false,
        pending: true,
        error: `${why} so it can't be followed from here. Your wallet may already have sent it${hash === undefined ? '' : ` as ${hash}`}, so check its activity before trying again.`,
      }
    }
    if (signed.family !== origin.family) {
      return sends
        ? notFollowed(`That is not ${withArticle(origin.chainName)} transaction,`)
        : {
            ok: false,
            error: `That is not ${withArticle(origin.chainName)} transaction, so nothing was sent.`,
          }
    }
    let expectation: DepositExpectation
    try {
      expectation = readIssued(origin, venueId, account, context, !sends)
    } catch (e) {
      if (e instanceof ChainActionRefused) {
        return sends
          ? notFollowed("This swap's details are not what this app issued,")
          : { ok: false, error: e.message }
      }
      throw e
    }
    const { depositAddress } = expectation

    const startedAt = Date.now()
    const sent = await send(origin, signed, expectation)
    if (!sent.ok) {
      return sent.pending === true
        ? { ...sent, error: `${sent.error} ${EXPLORER_NOTE} ${depositAddress}.` }
        : sent
    }

    const { hash: sentHash } = sent
    await notifyDeposit(depositAddress, sentHash)

    // A hex address may come back in another casing, and on other chains case is part of it.
    const isAccount = (recipient: string): boolean =>
      origin.family === 'evm' ? sameAddress(recipient, account) : recipient === account

    while (Date.now() - startedAt < STATUS_WAIT_MS) {
      const body = await depositStatus(depositAddress)
      const recipient = body?.quoteResponse?.quoteRequest?.recipient
      if (recipient !== undefined && !isAccount(recipient)) {
        return {
          ok: false,
          pending: true,
          error: `That deposit address belongs to a different swap. Your transfer is ${sentHash}. Check your wallet's activity before trying again.`,
        }
      }
      switch (body?.status) {
        case 'SUCCESS':
          return sent
        case 'REFUNDED':
          return {
            ok: false,
            pending: true,
            error: `The swap did not go through, and NEAR Intents says your funds were refunded to ${account}. Check your balance before trying again. ${EXPLORER_NOTE} ${depositAddress}.`,
          }
        case 'FAILED':
          return {
            ok: false,
            pending: true,
            error: `The swap failed after your deposit (${sentHash}). The refund address is ${account}, so that is where your funds should return. ${EXPLORER_NOTE} ${depositAddress}.`,
          }
        case 'INCOMPLETE_DEPOSIT':
          return {
            ok: false,
            pending: true,
            error: `NEAR Intents received less than the quote needed, so it won't swap. What arrived is due back at ${account}. ${EXPLORER_NOTE} ${depositAddress}.`,
          }
        default:
          await delay(STATUS_POLL_MS)
      }
    }
    return stillProcessing(sentHash, depositAddress)
  }

  return {
    id: venueId,
    name: VENUE_NAME,
    kinds: ['swap'],
    quote,
    prepare,
    assertSafe,
    submit,
  }
}
