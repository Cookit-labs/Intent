import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type NearTransaction,
  type PreparedAction,
  type SubmitInput,
  type SubmitResult,
  type VenueQuote,
} from '../types'
import { NEAR_ACCOUNT, NEAR_TX_HASH } from './account'
import {
  assetIdOf,
  depositStatus,
  notifyDeposit,
  oneClickPrice,
  requestQuote,
  type QuoteEnvelope,
} from './oneclick'
import { isRegistered, waitForTransaction } from './rpc'
import {
  assertOneClickSafe,
  DEPOSIT_ADDRESS,
  STORAGE_DEPOSIT_YOCTO,
  STORAGE_GAS,
  TRANSFER_GAS,
  WRAP_GAS,
} from './safety'
import { explorerUrl, formatUnits, nearTokens, toDisplayNumber, WRAP_NEAR } from './tokens'

export const ONECLICK_VENUE_ID = '1click'
const SLIPPAGE_BPS = 100
const QUOTE_WINDOW_MS = 5 * 60_000
/** A quote worth this much less than it costs is refused. */
const MAX_VALUE_LOSS = 0.05

/**
 * The status wait counts from the start and includes the confirm wait. With one
 * last status request and a pause on top, the worst case is still under 30 seconds.
 */
const CONFIRM_WAIT_MS = 10_000
const STATUS_WAIT_MS = 23_000
const STATUS_POLL_MS = 2_000

export const EXPLORER_NOTE = 'You can follow it at explorer.near-intents.org by searching for'

export const ONECLICK_RISK_NOTE =
  'NEAR Intents had an exploit of about $3.8M around 1 October 2026 in its bridge links. Funds were reported returned, but bridges and solvers it relies on remain a risk.'

export interface Destination {
  assetId: string
  symbol: string
  decimals: number
  recipientType: 'DESTINATION_CHAIN' | 'INTENTS'
}

/** What a swap spends, as 1Click names it. Off NEAR the id comes from `oneClickAssetId`. */
export interface QuoteOrigin {
  assetId: string
  decimals: number
}

function nearOrigin(token: ChainToken): QuoteOrigin {
  return { assetId: assetIdOf(token), decimals: token.decimals }
}

function lossBetween(paid: number, received: number): number {
  return paid > 0 && Number.isFinite(paid) && Number.isFinite(received)
    ? 1 - received / paid
    : Number.NaN
}

/**
 * Refuses a quote that gives back too little. It is measured twice, from the
 * quote's own dollar figures and from the token list's prices, and the worse one
 * counts. Both come from 1Click, so this catches bad routes and thin markets. It
 * would not catch 1Click lying about both at once.
 */
async function assertFairValue(
  envelope: QuoteEnvelope,
  origin: QuoteOrigin,
  destination: Destination
): Promise<number> {
  const { quote } = envelope
  const [priceIn, priceOut] = await Promise.all([
    oneClickPrice(origin.assetId, origin.decimals),
    oneClickPrice(destination.assetId, destination.decimals),
  ])
  const quoted = lossBetween(Number(quote.amountInUsd), Number(quote.amountOutUsd))
  const listed =
    priceIn === undefined || priceOut === undefined
      ? Number.NaN
      : lossBetween(
          toDisplayNumber(quote.amountIn, origin.decimals) * priceIn,
          toDisplayNumber(quote.amountOut, destination.decimals) * priceOut
        )
  if (!Number.isFinite(quoted) || !Number.isFinite(listed)) {
    throw new ChainActionRefused(
      "This quote couldn't be checked against live prices, so it was not used. Try again in a minute. Nothing was signed or sent."
    )
  }
  const worst = Math.max(quoted, listed)
  if (worst > MAX_VALUE_LOSS) {
    throw new ChainActionRefused(
      `You would get about ${(worst * 100).toFixed(1)}% less than you pay, which is more than this app allows. Try a smaller amount. Nothing was signed or sent.`
    )
  }
  return worst
}

/** Refuses a quote that doesn't say what was asked, whether or not it is signed. */
function assertQuoteMatches(
  envelope: QuoteEnvelope,
  input: {
    dry: boolean
    originAsset: string
    destinationAsset: string
    amount: string
    account: string
    recipientType: Destination['recipientType']
    deadline: string
  }
): void {
  const { quote, quoteRequest: asked } = envelope
  const matches =
    asked.dry === input.dry &&
    asked.swapType === 'EXACT_INPUT' &&
    asked.depositType === 'ORIGIN_CHAIN' &&
    asked.originAsset === input.originAsset &&
    asked.destinationAsset === input.destinationAsset &&
    asked.amount === input.amount &&
    asked.recipient === input.account &&
    asked.recipientType === input.recipientType &&
    asked.refundTo === input.account &&
    asked.refundType === 'ORIGIN_CHAIN' &&
    asked.deadline === input.deadline &&
    asked.slippageTolerance <= SLIPPAGE_BPS &&
    quote.amountIn === input.amount &&
    quote.minAmountIn === input.amount &&
    BigInt(quote.amountOut) > BigInt(0) &&
    BigInt(quote.minAmountOut) <= BigInt(quote.amountOut) &&
    BigInt(quote.minAmountOut) * BigInt(10_000) >=
      BigInt(quote.amountOut) * BigInt(10_000 - SLIPPAGE_BPS) - BigInt(10_000)
  if (!matches) {
    throw new ChainActionRefused(
      "NEAR Intents' quote didn't match what was asked, so it was not used. Nothing was signed or sent."
    )
  }
}

function functionCall(
  methodName: string,
  args: Record<string, unknown>,
  gas: bigint,
  deposit: string
): NearTransaction['actions'][number] {
  return {
    type: 'FunctionCall',
    params: { methodName, args, gas: gas.toString(), deposit },
  }
}

function storageFor(account: string): NearTransaction['actions'][number] {
  return functionCall(
    'storage_deposit',
    { account_id: account, registration_only: true },
    STORAGE_GAS,
    STORAGE_DEPOSIT_YOCTO
  )
}

/**
 * What the wallet sends. One transaction, so its actions succeed or revert
 * together. A NEP-141 transfer needs the deposit address registered on the token,
 * and fresh deposit addresses are not. `wrap.near` takes the first registration out
 * of a wrap, which would leave too little to transfer, so an unregistered sender
 * pays for storage first.
 */
export async function buildDepositTransaction(
  tokenIn: ChainToken,
  account: string,
  depositAddress: string,
  amount: string
): Promise<NearTransaction> {
  const actions: NearTransaction['actions'] = []
  try {
    if (tokenIn.id === WRAP_NEAR) {
      if (!(await isRegistered(WRAP_NEAR, account))) actions.push(storageFor(account))
      actions.push(functionCall('near_deposit', {}, WRAP_GAS, amount))
    }
    if (!(await isRegistered(tokenIn.id, depositAddress))) actions.push(storageFor(depositAddress))
  } catch {
    throw new ChainActionRefused(
      "NEAR's network could not be read just now, so nothing was built. Try again in a minute."
    )
  }
  actions.push(
    functionCall('ft_transfer', { receiver_id: depositAddress, amount }, TRANSFER_GAS, '1')
  )
  return { receiverId: tokenIn.id, actions }
}

function feeBps(envelope: QuoteEnvelope): number | undefined {
  const fees = envelope.quoteRequest.appFees
  return fees === undefined ? undefined : fees.reduce((sum, fee) => sum + fee.fee, 0)
}

function isPositive(amount: string | undefined): amount is string {
  return amount !== undefined && BigInt(amount) > BigInt(0)
}

/** The parts of the cost note that depend on what the chain's wallet pays for itself. */
export interface CostWording {
  withdrawFor: string
  total: string
}

const NEAR_COST_WORDING: CostWording = {
  withdrawFor: 'to register you on that token',
  total: 'After all costs',
}

export function costNote(
  envelope: QuoteEnvelope,
  loss: number,
  symbol: string,
  decimals: number,
  wording: CostWording = NEAR_COST_WORDING
): string {
  const bps = feeBps(envelope)
  const fee =
    bps === undefined
      ? "The quote includes 1Click's fee."
      : `The quote includes a ${(bps / 100).toFixed(2)}% fee, taken from what you send.`
  const withdraw = envelope.quote.withdrawFee
  const registration = isPositive(withdraw)
    ? ` It also takes ${formatUnits(withdraw, decimals)} ${symbol} ${wording.withdrawFor}.`
    : ''
  const percent = (Math.max(loss, 0) * 100).toFixed(2)
  return `NEAR Intents runs on mainnet only, so this moves real funds. ${fee}${registration} ${wording.total} you get about ${percent}% less in value than you pay, and at least ${formatUnits(envelope.quote.minAmountOut, decimals)} ${symbol}.`
}

export function depositNote(envelope: QuoteEnvelope, tokenIn: ChainToken, account: string): string {
  const refundFee = envelope.quote.refundFee
  const refundNote = isPositive(refundFee)
    ? `, minus a fee of ${formatUnits(refundFee, tokenIn.decimals)} ${tokenIn.symbol}`
    : ''
  return `Your funds go to a one-time deposit address from 1Click, which this app can't check on-chain. Sign within 5 minutes, because a late deposit may be refunded instead of swapped. If the swap can't finish, 1Click returns your funds to ${account}${refundNote}.`
}

interface DepositFlow {
  venueId: string
  venueName: string
  kind: PreparedAction['kind']
  summary: (amount: string, tokenIn: ChainToken) => string
  extraNotes: string[]
}

function assertNearAccount(account: string): void {
  if (!NEAR_ACCOUNT.test(account)) {
    throw new ChainActionRefused('That is not a NEAR account. Connect a NEAR wallet and try again.')
  }
}

/**
 * The preview half of every 1Click flow: a dry quote, checked against what was asked and
 * against live prices. A dry quote makes no deposit address, so the race can run it for
 * every venue, and Review runs it again before the real quote. The caller has already
 * checked the account belongs to the origin chain.
 */
export async function previewOneClick(
  amountText: string,
  origin: QuoteOrigin,
  destination: Destination,
  account: string
) {
  const amount = toBaseUnits(amountText, origin.decimals)
  const shared = {
    originAsset: origin.assetId,
    destinationAsset: destination.assetId,
    amount,
    account,
    recipientType: destination.recipientType,
    slippageBps: SLIPPAGE_BPS,
  }

  const dryDeadline = new Date(Date.now() + QUOTE_WINDOW_MS).toISOString()
  const preview = await requestQuote({ ...shared, dry: true, deadline: dryDeadline })
  assertQuoteMatches(preview, { ...shared, dry: true, deadline: dryDeadline })
  await assertFairValue(preview, origin, destination)
  return { shared, preview }
}

/**
 * The real quote, which creates a deposit address, under the same checks as the preview.
 * The address itself is left to the caller, because its shape depends on the chain.
 */
export async function liveOneClick(
  shared: Awaited<ReturnType<typeof previewOneClick>>['shared'],
  origin: QuoteOrigin,
  destination: Destination
) {
  const deadline = new Date(Date.now() + QUOTE_WINDOW_MS).toISOString()
  const live = await requestQuote({ ...shared, dry: false, deadline })
  assertQuoteMatches(live, { ...shared, dry: false, deadline })
  const loss = await assertFairValue(live, origin, destination)
  return { live, loss, deadline }
}

export function assertNoDepositMemo(envelope: QuoteEnvelope): void {
  const { depositMemo } = envelope.quote
  if (depositMemo !== undefined && depositMemo !== '') {
    throw new ChainActionRefused(
      'NEAR Intents asked for a deposit memo, which this app does not send. Nothing was signed or sent.'
    )
  }
}

function venueQuoteFrom(preview: QuoteEnvelope, destination: Destination): VenueQuote {
  return {
    receive: {
      amount: formatUnits(preview.quote.amountOut, destination.decimals),
      symbol: destination.symbol,
    },
    valueOutUsd: Number(preview.quote.amountOutUsd),
  }
}

/** What a dry quote says the swap would give back. Never reads a deposit address. */
export async function quoteOneClick(
  amountText: string,
  tokenIn: ChainToken,
  destination: Destination,
  account: string
): Promise<VenueQuote> {
  assertNearAccount(account)
  const { preview } = await previewOneClick(amountText, nearOrigin(tokenIn), destination, account)
  return venueQuoteFrom(preview, destination)
}

/** The quote flow behind every 1Click venue. Only the destination and the wording differ. */
export async function prepareOneClickDeposit(
  flow: DepositFlow,
  amountText: string,
  tokenIn: ChainToken,
  destination: Destination,
  account: string
): Promise<PreparedAction> {
  assertNearAccount(account)
  const origin = nearOrigin(tokenIn)
  const { shared } = await previewOneClick(amountText, origin, destination, account)
  const amount = shared.amount

  const { live, loss, deadline } = await liveOneClick(shared, origin, destination)

  const { depositAddress } = live.quote
  if (depositAddress === undefined || !DEPOSIT_ADDRESS.test(depositAddress)) {
    throw new ChainActionRefused(
      "NEAR Intents' deposit address didn't look right, so it was not used. Nothing was signed or sent."
    )
  }
  assertNoDepositMemo(live)

  const transaction = await buildDepositTransaction(tokenIn, account, depositAddress, amount)

  return {
    venueId: flow.venueId,
    venueName: flow.venueName,
    kind: flow.kind,
    summary: flow.summary(amountText, tokenIn),
    pay: { amount: amountText, symbol: tokenIn.symbol },
    receive: {
      amount: formatUnits(live.quote.amountOut, destination.decimals),
      symbol: destination.symbol,
      approximate: true,
    },
    notes: [
      costNote(live, loss, destination.symbol, destination.decimals),
      depositNote(live, tokenIn, account),
      ...flow.extraNotes,
    ],
    signing: { family: 'near', transactions: [transaction] },
    context: { depositAddress, deadline },
  }
}

function swapTokens(request: ChainActionRequest): { tokenIn: ChainToken; tokenOut: ChainToken } {
  const tokenIn = tokenBySymbol(nearTokens, request.tokenIn)
  const tokenOut = tokenBySymbol(nearTokens, request.tokenOut ?? '')
  if (request.kind !== 'swap' || tokenIn === undefined || tokenOut === undefined) {
    throw new ChainActionRefused('NEAR Intents here swaps between NEAR, USDC and USDT.')
  }
  if (tokenIn.id === tokenOut.id) throw new ChainActionRefused('Those are the same token.')
  return { tokenIn, tokenOut }
}

async function quoteSwap(request: ChainActionRequest, account: string): Promise<VenueQuote> {
  const { tokenIn, tokenOut } = swapTokens(request)
  return quoteOneClick(
    request.amount,
    tokenIn,
    {
      assetId: assetIdOf(tokenOut),
      symbol: tokenOut.symbol,
      decimals: tokenOut.decimals,
      recipientType: 'DESTINATION_CHAIN',
    },
    account
  )
}

async function prepareSwap(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  const { tokenIn, tokenOut } = swapTokens(request)
  const toNear = tokenOut.id === WRAP_NEAR
  return prepareOneClickDeposit(
    {
      venueId: ONECLICK_VENUE_ID,
      venueName: 'NEAR Intents 1Click',
      kind: 'swap',
      summary: (amount, token) =>
        token.id === WRAP_NEAR
          ? `Wrap ${amount} NEAR and swap it for ${tokenOut.symbol} through NEAR Intents, into your NEAR account.`
          : toNear
            ? `Swap ${amount} ${token.symbol} for NEAR through NEAR Intents, delivered to your NEAR account as NEAR or wNEAR.`
            : `Swap ${amount} ${token.symbol} for ${tokenOut.symbol} through NEAR Intents, into your NEAR account.`,
      extraNotes: [ONECLICK_RISK_NOTE],
    },
    request.amount,
    tokenIn,
    {
      assetId: assetIdOf(tokenOut),
      symbol: tokenOut.symbol,
      decimals: tokenOut.decimals,
      recipientType: 'DESTINATION_CHAIN',
    },
    account
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stillProcessing(hash: string, depositAddress: string): SubmitResult {
  return {
    ok: false,
    pending: true,
    error: `Your deposit was sent (${hash}) and the swap is still processing, which can take up to 15 minutes. Don't send it again. ${EXPLORER_NOTE} ${depositAddress}.`,
  }
}

function notSeenYet(hash: string, depositAddress: string): SubmitResult {
  return {
    ok: false,
    pending: true,
    error: `Your wallet returned transaction ${hash}, but neither NEAR nor NEAR Intents has seen it yet. Don't send it again until you've checked ${explorerUrl(hash)}. ${EXPLORER_NOTE} ${depositAddress}.`,
  }
}

/**
 * Tells 1Click about the deposit and waits a bounded time for the outcome.
 *
 * A swap still running comes back as `ok: false, pending: true`, with a sentence
 * saying so. Reporting it as finished would be untrue, and as failed would invite
 * a second payment.
 */
export async function submitOneClick(input: SubmitInput): Promise<SubmitResult> {
  const { account, signed, context } = input
  if (signed.family !== 'near') return { ok: false, error: 'That is not a NEAR transaction.' }
  const hash = signed.hashes[signed.hashes.length - 1]
  const depositAddress = context?.['depositAddress']
  if (hash === undefined || !NEAR_TX_HASH.test(hash)) {
    return {
      ok: false,
      pending: true,
      error: 'The wallet did not return a transaction hash to follow.',
    }
  }
  if (depositAddress === undefined || !DEPOSIT_ADDRESS.test(depositAddress)) {
    return {
      ok: false,
      pending: true,
      error: `This swap's deposit address was lost, so it can't be followed from here. Your transaction is ${hash}. Check your wallet before trying again.`,
    }
  }

  const startedAt = Date.now()
  const outcome = await waitForTransaction(hash, account, CONFIRM_WAIT_MS)
  if (outcome.state === 'failed') {
    return {
      ok: false,
      error: `Your deposit transaction failed on NEAR (${hash}), so the funds did not leave your account, apart from the gas. You can try again.`,
    }
  }
  if (outcome.state === 'success') {
    const paysDeposit = outcome.calls.some(
      (c) => c.method === 'ft_transfer' && c.args['receiver_id'] === depositAddress
    )
    if (outcome.signer !== account || !paysDeposit) {
      return {
        ok: false,
        pending: true,
        error: `Transaction ${hash} is not this account's deposit for this swap, so it was not reported to NEAR Intents. Check your wallet's activity.`,
      }
    }
    await notifyDeposit(depositAddress, hash, account)
  }

  let lastStatus: string | undefined
  while (Date.now() - startedAt < STATUS_WAIT_MS) {
    const body = await depositStatus(depositAddress)
    lastStatus = body?.status ?? lastStatus
    const recipient = body?.quoteResponse?.quoteRequest?.recipient
    if (recipient !== undefined && recipient !== account) {
      return {
        ok: false,
        pending: true,
        error: 'That deposit address belongs to a different swap.',
      }
    }
    switch (body?.status) {
      case 'SUCCESS':
        return { ok: true, hash, explorerUrl: explorerUrl(hash) }
      case 'REFUNDED':
        return {
          ok: false,
          error: `The swap did not go through, and NEAR Intents refunded your funds to ${account}. Check your balance before trying again.`,
        }
      case 'FAILED':
        return {
          ok: false,
          pending: true,
          error: `The swap failed after your deposit (${hash}). The refund address is ${account}, so that is where your funds should return. ${EXPLORER_NOTE} ${depositAddress}.`,
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
  const seen =
    outcome.state === 'success' || (lastStatus !== undefined && lastStatus !== 'PENDING_DEPOSIT')
  return seen ? stillProcessing(hash, depositAddress) : notSeenYet(hash, depositAddress)
}

export const oneClickVenue: ChainVenue = {
  id: ONECLICK_VENUE_ID,
  name: 'NEAR Intents 1Click',
  kinds: ['swap'],
  quote: quoteSwap,
  prepare: prepareSwap,
  assertSafe: assertOneClickSafe,
  submit: submitOneClick,
}
