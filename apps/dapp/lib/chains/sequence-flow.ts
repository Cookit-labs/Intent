import type { ChainActionPhase } from '../../hooks/use-chain-action'
import { walletFetch } from '../api/network-fetch'
import {
  NO_CASHOUTS,
  accountMismatch,
  unsupportedCurrencyReply,
  walletSends,
  type CashoutCurrency,
} from '../weave/cashout-view'
import type { CashoutCurrencyCode, CashoutRoute } from '../weave/parse-cashout'
import { MAX_COST_PERCENT } from '../weave/types'
import { AVALANCHE_TOKENS, MONAD_TOKENS } from './evm/tokens'
import { NATIVE_NEAR, nearTokens } from './near/tokens'
import { chainNamesOf, chainTokenWord } from './parse-action'
import {
  cashoutAmountFrom,
  deliveredAmount,
  fromBase,
  strandedReply,
  toBase,
  type ChainSequenceRequest,
  type FollowOn,
} from './sequence'
import { SOLANA_TOKENS } from './solana/tokens'
import { SUI_TOKENS } from './sui/tokens'
import {
  tokenBySymbol,
  type ChainActionKind,
  type ChainActionRequest,
  type ChainToken,
  type ChainWithActions,
  type SigningPayload,
  type TokenBalance,
  type WalletBalances,
} from './types'

/**
 * A swap, then what comes after it. The swap is an ordinary chain action, signed on its own card,
 * and this reads how it ended. `settled` is the only answer that lets step 2 be offered.
 *
 * `next` is a cash-out's form. A deposit, stake or send has a card of its own instead, the same
 * `chainAction` as step 1: `following` while it is live, `followed` once it settled, and
 * `unsettled` once it may have moved money without being seen to finish. Only `following` can go
 * back to `ready`, and only on an answer that proves nothing moved.
 */
export type SequenceStage =
  | 'swap'
  | 'measuring'
  | 'ready'
  | 'next'
  | 'following'
  | 'followed'
  | 'unsettled'
  | 'stranded'
  | 'done'

export const MEASURE_INTERVAL_MS = 3_000
export const MEASURE_ATTEMPTS = 20
export const BEFORE_RETRY_MS = 1_500

/** As long as the balances route may run, so one read that hangs still ends as one attempt. */
const READ_TIMEOUT_MS = 20_000

export const CASHOUT_UNDER_WAY =
  'A cash-out is already under way. Follow it here, and do not send it again.'

/** What each follow-on is called, in the words a person would use. */
function nounOf(followOn: FollowOn): string {
  if (followOn.kind === 'cashout') return 'cash-out'
  return followOn.kind === 'supply' ? 'deposit' : followOn.kind
}

/** Step 1 may or may not have moved money, so this says neither. */
export const UNCONFIRMED_SWAP =
  "This swap is not confirmed, so the cash-out will not start. Check your wallet's activity before doing anything else. Nothing was paid out."

export const SWAP_NEXT_STEP =
  'Step 2 waits for your press. It uses what the swap actually delivers.'

/** For a step with no form to fill. Approving the swap isn't approving this: the wallet still asks. */
export const SWAP_THEN_WALLET =
  'Your wallet opens again for step 2 after this, for what the swap actually delivers. If it does not, a button here does the same. Decline it and you keep what arrived.'

export const BALANCE_UNREAD =
  'I could not read your USDC balance, so if you sign this swap the cash-out will not follow. You would hold the USDC and can cash it out yourself.'

export const TOO_SMALL_FOR_WEAVE =
  'Weave would refuse a cash-out this small, so this swap would leave you holding the USDC.'

const LEFT_HOLDING = 'This swap would leave you holding the USDC.'

/** Beside the card's own words for the failure, which may or may not say nothing moved. */
export const CASHOUT_NOT_STARTED = 'The cash-out did not start.'

function unconfirmedSwap(followOn: FollowOn): string {
  return followOn.kind === 'cashout'
    ? UNCONFIRMED_SWAP
    : `This swap is not confirmed, so the ${nounOf(followOn)} will not start. Check your wallet's activity before doing anything else.`
}

function notStarted(followOn: FollowOn): string {
  return followOn.kind === 'cashout'
    ? CASHOUT_NOT_STARTED
    : `The ${nounOf(followOn)} did not start.`
}

/**
 * What step 1's card says about where the sequence stands. Nothing while it is still open.
 * `signed` is `chainAction.signed`: false on a failure means a signature cannot have moved money,
 * as with a refusal, a clean failure at the wallet or a clean refusal at submit, and the card lets
 * the person try again. Leaving it out assumes the worse.
 */
export function stageAfterSwap(
  phase: ChainActionPhase,
  signed: boolean = true
): SequenceStage | undefined {
  if (phase === 'settled') return 'measuring'
  if (phase === 'pending') return 'stranded'
  if (phase === 'failed') return signed ? 'stranded' : 'done'
  return undefined
}

/**
 * The next stage as the card moves. A plain failure can be retried from the same race, so a
 * rebuild takes the sequence back up. Nothing else the card does can change a stage already reached.
 */
export function stageOnCard(
  current: SequenceStage,
  phase: ChainActionPhase,
  signed: boolean
): SequenceStage {
  if (current === 'done') return phase === 'building' || phase === 'review' ? 'swap' : 'done'
  if (current !== 'swap') return current
  return stageAfterSwap(phase, signed) ?? 'swap'
}

export interface SequenceProgress {
  stage: SequenceStage
  /** Step 1 is known to have settled. A settled swap is what "the swap went through" may be said of. */
  settled: boolean
  error?: string
  /** Step 2's own build has started, so what the card says from here is about step 2. */
  opened?: boolean
}

/**
 * The sequence as step 1's card moves, with what to say. A swap that settled is past the card, and
 * the rest of it is measured from the chain. An unknown `before` can't be measured from, so it
 * strands at once rather than guess.
 */
export function moveOnCard(
  progress: SequenceProgress,
  phase: ChainActionPhase,
  signed: boolean,
  beforeKnown: boolean,
  request: ChainSequenceRequest
): SequenceProgress {
  if (progress.settled) return progress
  const stage = stageOnCard(progress.stage, phase, signed)
  if (stage === progress.stage) return progress
  if (stage === 'measuring') {
    return beforeKnown
      ? { stage, settled: true }
      : { stage: 'stranded', settled: true, error: unmeasuredReply(request) }
  }
  if (stage === 'stranded') {
    return { stage, settled: false, error: unconfirmedSwap(request.followOn) }
  }
  if (stage === 'done') return { stage, settled: false, error: notStarted(request.followOn) }
  return { stage, settled: false }
}

/**
 * The sequence as step 2's card moves, for a follow-on whose card is `chainAction` itself. Step 1
 * stays flagged settled, so `moveOnCard` ignores all of this and nothing is measured again.
 *
 * Until its own build starts, the card may still show how step 1 ended. Once it has, `signed` is
 * the latch, and false on a failure or a closed card means no signature can have moved money. That
 * alone returns to `ready`. Anything else ends here, so no press can ever lift a signed step 2's
 * latch: `ready` is the only stage that offers the button. Only a card of the follow-on's own kind
 * settling is step 2 finishing. Anything else that settled is not it, and is not ticked as it.
 */
export function moveOnSecond(
  progress: SequenceProgress,
  phase: ChainActionPhase,
  signed: boolean,
  request: ChainSequenceRequest,
  delivered: string | undefined,
  cardKind: ChainActionKind | undefined
): SequenceProgress {
  if (progress.stage !== 'following') return progress
  if (progress.opened !== true) {
    return phase === 'building' ? { ...progress, opened: true } : progress
  }
  if (phase === 'settled' && cardKind === request.followOn.kind) {
    return { stage: 'followed', settled: true }
  }
  const clean = (phase === 'failed' || phase === 'idle') && !signed
  if (clean) return { stage: 'ready', settled: true }
  if (phase !== 'settled' && phase !== 'pending' && phase !== 'failed' && phase !== 'idle') {
    return progress
  }
  const arrived =
    delivered === undefined
      ? ''
      : ` and about ${delivered} ${outputSymbol(request)} reached your wallet`
  return {
    stage: 'unsettled',
    settled: true,
    error: `The swap went through${arrived}. The ${nounOf(request.followOn)} has not been confirmed as finished, so check your wallet's activity before trying it again.`,
  }
}

/**
 * The stage as the cash-out form moves. Leaving the form is declining it for now. A cash-out under
 * way or paid ends the sequence, so the button can never offer the same USDC twice.
 */
export function stageOnForm(
  current: SequenceStage,
  form: { open: boolean; locked: boolean; paid: boolean }
): SequenceStage {
  if (current !== 'next') return current
  if (form.locked || form.paid) return 'done'
  return form.open ? 'next' : 'ready'
}

export function stageAfterMeasure(
  delivered: string | undefined,
  attempts: number,
  maxAttempts: number
): SequenceStage | 'keep' {
  if (delivered !== undefined) return 'ready'
  return attempts >= maxAttempts ? 'stranded' : 'keep'
}

const TOKEN_TABLES: Record<ChainWithActions, readonly ChainToken[]> = {
  solana: SOLANA_TOKENS,
  sui: SUI_TOKENS,
  near: nearTokens,
  avalanche: AVALANCHE_TOKENS,
  monad: MONAD_TOKENS,
}

/**
 * The token step 1 delivers, from the prepared card's symbol and this chain's own table, which is
 * what gives the id to measure by. Nothing if the card names something other than what was asked.
 * A native output measures low, since the fee comes out of the same balance, and never high.
 */
export function outputToken(
  chain: string,
  receiveSymbol: string | undefined,
  asked: string | undefined
): ChainToken | undefined {
  if (receiveSymbol === undefined || asked === undefined) return undefined
  if (receiveSymbol.toUpperCase() !== asked.toUpperCase()) return undefined
  // Rhea pays out the coin, and a stake or send spends it. A swap someone named 1Click for arrives
  // as wNEAR instead, this never rises, and the sequence stops at the swap, with the wNEAR held.
  if (chain === 'near' && receiveSymbol.toUpperCase() === NATIVE_NEAR.symbol) return NATIVE_NEAR
  const table = TOKEN_TABLES[chain as ChainWithActions]
  return table === undefined ? undefined : tokenBySymbol(table, receiveSymbol)
}

/**
 * How much of a token an answer shows, matched on id. Missing from an answer that lists everything
 * means none held. Missing from any other answer means not known, never zero: a `before` of zero
 * that was not read would make everything already held look delivered.
 */
export function holdingOf(
  balances: Pick<WalletBalances, 'complete' | 'unread'> & { tokens: readonly TokenBalance[] },
  token: Pick<ChainToken, 'id' | 'symbol'>
): string | undefined {
  const held = balances.tokens.find((t) => t.id === token.id)
  if (held !== undefined) return held.amount
  return balances.complete && balances.unread?.includes(token.symbol) !== true ? '0' : undefined
}

/** One read of a token's balance, or nothing on a failed read, a 503 included. */
export async function readHolding(
  chain: string,
  account: string,
  token: Pick<ChainToken, 'id' | 'symbol'>,
  signal?: AbortSignal
): Promise<string | undefined> {
  const limit = new AbortController()
  const stop = (): void => limit.abort()
  const timer = setTimeout(stop, READ_TIMEOUT_MS)
  signal?.addEventListener('abort', stop, { once: true })
  try {
    const response = await fetch(
      `/api/chain/${chain}/balances?account=${encodeURIComponent(account)}`,
      { cache: 'no-store', signal: limit.signal }
    )
    if (!response.ok) return undefined
    const body = (await response.json()) as Partial<WalletBalances>
    return Array.isArray(body.tokens) ? holdingOf(body as WalletBalances, token) : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
}

/** The output token's balance before the swap. Anything but `known` strands at settled. */
export type Before =
  | { status: 'unknown' }
  | { status: 'reading'; account: string; token: ChainToken }
  | { status: 'known'; amount: string; account: string; token: ChainToken }

export type BeforeStatus = Before['status']

/**
 * Whether a `before` read that just answered is still from before the swap. It holds while the card
 * is being built or is on offer. In the wallet it holds only where the wallet sends nothing itself.
 * Any later and the swap may be in the figure, which would measure too little.
 */
export function beforeReadCounts(
  phase: ChainActionPhase,
  family: SigningPayload['family'] | undefined
): boolean {
  if (phase === 'building' || phase === 'review') return true
  return phase === 'signing' && family !== undefined && !walletSends(family)
}

/** Whether the card that just came up can use the read already made for it. A decline can. */
export function keepsBefore(before: Before, account: string, tokenId: string): boolean {
  return before.status !== 'unknown' && before.account === account && before.token.id === tokenId
}

/** Reads the balance, and once more after a pause if that failed and the card is still unsigned. */
export async function readBeforeSwap(
  read: () => Promise<string | undefined>,
  stillOpen: () => boolean,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
): Promise<string | undefined> {
  const first = await read()
  if (first !== undefined || !stillOpen()) return first
  await wait(BEFORE_RETRY_MS)
  return stillOpen() ? read() : undefined
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

/**
 * Reads until the balance rises or the attempts run out, one read at a time. Nothing once aborted,
 * so a measure that was cleared decides nothing.
 */
export async function measureDelivered(args: {
  before: string
  decimals: number
  read: (signal: AbortSignal) => Promise<string | undefined>
  signal: AbortSignal
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<{ stage: 'ready'; delivered: string } | { stage: 'stranded' } | undefined> {
  const { before, decimals, read, signal, wait = sleep } = args
  for (let attempts = 1; ; attempts += 1) {
    if (signal.aborted) return undefined
    const after = await read(signal)
    if (signal.aborted) return undefined
    const delivered = deliveredAmount(before, after, decimals)
    const stage = stageAfterMeasure(delivered, attempts, MEASURE_ATTEMPTS)
    if (stage !== 'keep') {
      return delivered !== undefined ? { stage: 'ready', delivered } : { stage: 'stranded' }
    }
    await wait(MEASURE_INTERVAL_MS, signal)
  }
}

/**
 * What the swap's card says about what follows it, in place of promising what won't happen. Leaving
 * out the request means a cash-out. `quoted` is Weave's word on a cash-out's size, so nothing else
 * ever shows it.
 */
export function swapLine(
  phase: ChainActionPhase,
  status: BeforeStatus,
  quoted: string | undefined,
  request?: ChainSequenceRequest
): string {
  const unread = status === 'unknown' && (phase === 'review' || phase === 'signing')
  if (request === undefined || request.followOn.kind === 'cashout') {
    return unread ? BALANCE_UNREAD : (quoted ?? SWAP_NEXT_STEP)
  }
  if (!unread) return SWAP_THEN_WALLET
  const symbol = outputSymbol(request)
  return `I could not read your ${symbol} balance, so if you sign this swap the ${nounOf(request.followOn)} will not follow. You would hold the ${symbol}.`
}

export type QuoteStep =
  | { kind: 'none' }
  | { kind: 'note'; note: string }
  | { kind: 'ask'; amount: string }

/** What to ask Weave about a card's receive: the amount the button would open at, not all of it. */
export function quoteStep(receive: string | undefined): QuoteStep {
  if (receive === undefined) return { kind: 'none' }
  const amount = cashoutAmountFrom(receive)
  return amount === undefined
    ? { kind: 'note', note: TOO_SMALL_FOR_WEAVE }
    : { kind: 'ask', amount }
}

/**
 * What a quote's answer means for this card. A cost past what the order route accepts and a refusal
 * of the amount are said. Anything else, such as a busy or failed read, says nothing about the size.
 */
export function quoteNote(
  status: number,
  body: { error?: unknown; message?: unknown; costPercent?: unknown }
): string | undefined {
  if (status === 200) {
    const { costPercent } = body
    return typeof costPercent === 'number' && costPercent > MAX_COST_PERCENT
      ? TOO_SMALL_FOR_WEAVE
      : undefined
  }
  if (status === 400) return body.error === 'invalid_amount' ? TOO_SMALL_FOR_WEAVE : undefined
  if (status !== 422) return undefined
  const { message } = body
  const plain = typeof message === 'string' && message.includes(' ') && !/[<>{}]/.test(message)
  return plain ? `${message} ${LEFT_HOLDING}` : TOO_SMALL_FOR_WEAVE
}

/** A read of the price only: this route makes no order. Nothing on a failed or slow read. */
export async function readCashoutNote(
  chain: string,
  currency: string,
  amount: string
): Promise<string | undefined> {
  try {
    const query = new URLSearchParams({ chain, currency, amount })
    const response = await walletFetch(`/api/cashout/quote?${query.toString()}`, {
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })
    return quoteNote(response.status, (await response.json()) as Parameters<typeof quoteNote>[1])
  } catch {
    return undefined
  }
}

/** What reached the wallet. For a cash-out, which no request means, also whether it is enough. */
export function deliveredLine(delivered: string, request?: ChainSequenceRequest): string {
  if (request !== undefined && request.followOn.kind !== 'cashout') {
    return `About ${delivered} ${outputSymbol(request)} reached your wallet.`
  }
  return cashoutAmountFrom(delivered) === undefined
    ? `About ${delivered} USDC reached your wallet, which is too small to cash out. Nothing was paid out.`
    : `About ${delivered} USDC reached your wallet.`
}

export type ReadyAction =
  | { kind: 'open'; amount: string }
  /** No button: there is nothing to cash out. */
  | { kind: 'too-small'; message: string }
  /** The button stays, since each of these can change: this press does nothing. */
  | { kind: 'refused'; message: string }

/** What the step 2 button does. `account` is the wallet step 1 was built for. */
export function readyAction(
  delivered: string,
  locked: boolean,
  connected: string | undefined,
  account: string
): ReadyAction {
  const amount = cashoutAmountFrom(delivered)
  if (amount === undefined) return { kind: 'too-small', message: deliveredLine(delivered) }
  if (locked) return { kind: 'refused', message: CASHOUT_UNDER_WAY }
  const wrongWallet = accountMismatch(connected, account)
  if (wrongWallet !== undefined) return { kind: 'refused', message: wrongWallet }
  return { kind: 'open', amount }
}

/** The one line a sequence leaves in the transcript as it reaches each ending. */
export function sequenceOutcome(
  stage: SequenceStage | undefined,
  delivered: string | undefined,
  error: string | undefined,
  request?: ChainSequenceRequest
): string | undefined {
  if (stage === 'ready' && delivered !== undefined) return deliveredLine(delivered, request)
  return stage === 'stranded' || stage === 'done' || stage === 'unsettled' ? error : undefined
}

/** A token as the tables spell it, JitoSOL and not JITOSOL, however it was typed. */
function listedSymbol(word: string): string {
  const listed = tokenBySymbol(Object.values(TOKEN_TABLES).flat(), word)
  return listed?.symbol ?? word.toUpperCase()
}

function outputSymbol(request: ChainSequenceRequest): string {
  return listedSymbol(request.swap.tokenOut ?? '')
}

/**
 * Said when a swap that settled is left before step 2 ran, or nothing where there is no news. A
 * step 2 being signed can't be left: the chat holds new messages until the wallet has answered.
 */
export function endedNote(
  stage: SequenceStage | undefined,
  delivered: string | undefined,
  request: ChainSequenceRequest | null
): string | undefined {
  if (request === null) return undefined
  if (stage !== 'measuring' && stage !== 'ready' && stage !== 'next' && stage !== 'following') {
    return undefined
  }
  return strandedReply(outputSymbol(request), delivered, request.followOn)
}

/**
 * Whether a message leaves the run where it stands. One that starts an action ends it. Anything
 * else keeps it while a step is left to take: a question, a refusal, or what only the model can
 * read, until it says. A run before its swap settled has no such step, and the message closes its
 * race and card anyway, so that ends as it always has.
 */
export function keepsRun(stage: SequenceStage | undefined, startsAction: boolean): boolean {
  if (startsAction) return false
  return stage === 'measuring' || stage === 'ready' || stage === 'next' || stage === 'following'
}

/** Step 1's sentence after the measure could not finish. */
export function unmeasuredReply(request: ChainSequenceRequest): string {
  return strandedReply(outputSymbol(request), undefined, request.followOn)
}

export function stepLabels(request: ChainSequenceRequest): [string, string] {
  const { amount, tokenIn } = request.swap
  const first = `Swap ${amount} ${listedSymbol(tokenIn)} to ${outputSymbol(request)}`
  return [first, secondLabel(request.followOn)]
}

function secondLabel(followOn: FollowOn): string {
  switch (followOn.kind) {
    case 'cashout':
      return followOn.currency !== undefined ? `Cash out to ${followOn.currency}` : 'Cash out'
    case 'supply':
      return followOn.venue !== undefined ? `Deposit on ${followOn.venue}` : 'Deposit'
    case 'stake':
      return followOn.venue !== undefined ? `Stake on ${followOn.venue}` : 'Stake'
    case 'send':
      return `Send to ${followOn.recipient}`
  }
}

/** What the button says for a follow-on with a card of its own. A cash-out's button is its own. */
export function secondStepLabel(
  request: ChainSequenceRequest,
  delivered: string
): string | undefined {
  const { followOn } = request
  if (followOn.kind === 'cashout') return undefined
  const verb = followOn.kind === 'supply' ? 'Deposit' : followOn.kind === 'stake' ? 'Stake' : 'Send'
  return `${verb} ${delivered} ${outputSymbol(request)}`
}

/** An amount cut to a token's places, never rounded up. Nothing if that leaves nothing. */
function flooredAmount(text: string, decimals: number): string | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined
  const [whole = '0', fraction = ''] = text.split('.')
  const base = toBase(`${whole}.${fraction.slice(0, decimals) || '0'}`, decimals)
  return base === undefined || base === BigInt(0) ? undefined : fromBase(base, decimals)
}

/**
 * Step 2's request: the measured amount of the token the swap delivered. Nothing for a cash-out,
 * which has a form instead, or when too little is left to move.
 */
export function nextRequest(
  request: ChainSequenceRequest,
  delivered: string,
  decimals: number
): ChainActionRequest | undefined {
  const { followOn, swap } = request
  const amount = flooredAmount(delivered, decimals)
  if (followOn.kind === 'cashout' || amount === undefined || swap.tokenOut === undefined) {
    return undefined
  }
  const tokenIn = swap.tokenOut
  if (followOn.kind === 'send') {
    return { kind: 'send', amount, tokenIn, recipient: followOn.recipient }
  }
  return {
    kind: followOn.kind,
    amount,
    tokenIn,
    ...(followOn.venue !== undefined ? { venue: followOn.venue } : {}),
  }
}

/**
 * What step 2 moves. A deposit, stake or send has no form to correct it, so if more than 2% over the
 * card's quote arrived, money from elsewhere came in as well, and only the quoted amount is this
 * swap's. No quote that can be read means what was measured. A cash-out's form can be edited.
 */
export function stepAmount(
  request: ChainSequenceRequest,
  delivered: string,
  quoted: string | undefined
): { amount: string; note?: string } {
  const measured = { amount: delivered }
  if (request.followOn.kind === 'cashout' || quoted === undefined) return measured
  const placesOf = (text: string): number => (text.split('.')[1] ?? '').length
  const places = Math.max(placesOf(delivered), placesOf(quoted))
  const got = toBase(delivered, places)
  const said = toBase(quoted, places)
  if (got === undefined || said === undefined || said === BigInt(0)) return measured
  if (got * BigInt(100) <= said * BigInt(102)) return measured
  return {
    amount: quoted,
    note: `More arrived than this swap should bring, so this uses the quoted ${quoted} ${outputSymbol(request)}.`,
  }
}

/**
 * Step 2 as a request of its own, as an example with a made-up amount: the token is what the swap
 * delivered. Nothing for a cash-out, whose form is its own way back.
 */
export function stepOnItsOwn(request: ChainSequenceRequest): string | undefined {
  const symbol = outputSymbol(request)
  switch (request.followOn.kind) {
    case 'cashout':
      return undefined
    case 'supply':
      return `deposit 5 ${symbol}`
    case 'stake':
      return `stake 5 ${symbol}`
    case 'send':
      return `send 5 ${symbol} to an address`
  }
}

export type SecondStepPress =
  | { kind: 'prepare'; request: ChainActionRequest }
  /** The button stays, since a wallet can change: this press does nothing. */
  | { kind: 'refused'; message: string }

/** What pressing step 2's button does. `account` is the wallet step 1 was built for. */
export function secondStepPress(
  request: ChainActionRequest | undefined,
  connected: string | undefined,
  account: string
): SecondStepPress {
  if (request === undefined) {
    return {
      kind: 'refused',
      message:
        'What arrived is too small to move, so step 2 did not start. It stays in your wallet.',
    }
  }
  const wrongWallet = accountMismatch(connected, account)
  return wrongWallet !== undefined
    ? { kind: 'refused', message: wrongWallet }
    : { kind: 'prepare', request }
}

export type AutoMove = 'prepare' | 'sign'

/**
 * What step 2 does by itself, or nothing where it waits for a press. Each move happens once: one
 * build a run and one wallet prompt a card. So a decline, a wrong wallet or a failed build leaves the
 * button and the card's own Sign button, and can never bring the wallet back unasked.
 *
 * The wallet is opened only on step 2's own card, of the kind that was asked for and built after
 * step 1 settled. A cash-out has a form, which only a person can fill in. More arriving than this
 * swap should bring stops for a press too, and so does a card warning this may already have been
 * sent, because those have to be read before anything is signed.
 */
export function autoMove(state: {
  stage: SequenceStage | undefined
  followOnKind: FollowOn['kind'] | undefined
  phase: ChainActionPhase
  opened: boolean
  cardKind: ChainActionKind | undefined
  extraArrived: boolean
  /** The card warns of an earlier attempt at the same thing. */
  warned: boolean
  prepareTried: boolean
  signTried: boolean
}): AutoMove | undefined {
  const { stage, followOnKind, phase, opened, cardKind } = state
  if (followOnKind === undefined || followOnKind === 'cashout') return undefined
  if (stage === 'ready') return state.prepareTried || state.extraArrived ? undefined : 'prepare'
  if (stage !== 'following' || !opened || state.signTried || state.warned) return undefined
  return phase === 'review' && cardKind === followOnKind ? 'sign' : undefined
}

export type StepMark = 'now' | 'waiting' | 'done' | 'stopped'

/** How each step stands. `settled` is whether step 1 is known to have settled. */
export function stepMarks(stage: SequenceStage, settled: boolean): [StepMark, StepMark] {
  if (!settled) return stage === 'swap' ? ['now', 'waiting'] : ['stopped', 'stopped']
  if (stage === 'stranded' || stage === 'unsettled') return ['done', 'stopped']
  if (stage === 'followed') return ['done', 'done']
  return stage === 'measuring' ? ['done', 'waiting'] : ['done', 'now']
}

/** "cash out 5 SOL": a swap to USDC, then the cash-out. */
export function cashoutSequence(
  route: Extract<CashoutRoute, { kind: 'sequence' }>
): ChainSequenceRequest {
  return {
    swap: {
      kind: 'swap',
      amount: route.amount,
      ...(route.amountIsUsd === true ? { amountIsUsd: true as const } : {}),
      tokenIn: route.token,
      tokenOut: 'USDC',
      venue: undefined,
    },
    followOn: {
      kind: 'cashout',
      ...(route.currency !== undefined ? { currency: route.currency } : {}),
    },
  }
}

export type CurrencyStep =
  | { kind: 'refuse'; message: string }
  | { kind: 'run'; currency: CashoutCurrencyCode }
  | { kind: 'ask'; choices: CashoutCurrency[] }

/**
 * What to do about the currency before any swap: one this chain can't pay is refused here, while
 * the swap is still unsigned, since the form could only swap it for another afterwards.
 */
export function currencyStep(
  named: CashoutCurrencyCode | undefined,
  choices: CashoutCurrency[]
): CurrencyStep {
  if (choices.length === 0) return { kind: 'refuse', message: NO_CASHOUTS }
  if (named !== undefined) {
    return choices.some((c) => c.code === named)
      ? { kind: 'run', currency: named }
      : { kind: 'refuse', message: unsupportedCurrencyReply(named, choices) }
  }
  const only = choices.length === 1 ? choices[0] : undefined
  return only !== undefined
    ? { kind: 'run', currency: only.code as CashoutCurrencyCode }
    : { kind: 'ask', choices }
}

const NOT_THE_AMOUNT =
  'usd|usdc|dollars?|bucks?|naira|ngn|kes|ksh|ugx|tzs|shillings?|eur|euros?|gbp|pounds?'

/** A figure, what follows it in its turn, and everything said after it. */
interface Figure {
  /** Nothing for a figure that can't be read as one amount, which then matches no amount at all. */
  value: string | undefined
  after: string
  rest: string
}

/**
 * The figures that could be the amount, turn by turn. Money in another unit is not one, nor "5k",
 * "5%" or "$5", and nor is what follows "of my" or "of the": "2 of my 5" says what is held, and if
 * that leaves too little to tell, the request is refused.
 */
function figuresSaid(symbol: string, turns: readonly string[]): Figure[] {
  // "5 USDC" is 5 of a token when the token is USDC, and a sum of money when it is another's.
  const notAmount = NOT_THE_AMOUNT.split('|')
    .filter((unit) => unit !== symbol.toLowerCase())
    .join('|')
  const number = new RegExp(
    String.raw`(?:^|[^\w.,$₦£€])(?<!\bof\s+(?:my\s+|the\s+)?)(\d[\d,]*(?:\.\d+)?|\.\d+)(?![\w%]|[.,]\d)(?!\s*(?:${notAmount})(?![\w+]))`,
    'gi'
  )
  const spaced = spacedTurns(symbol, turns)
  return spaced.flatMap((turn, index) =>
    [...turn.matchAll(number)].map((match) => {
      const after = turn.slice((match.index ?? 0) + match[0].length)
      return {
        value: figureValue(match[1] as string),
        after,
        rest: [after, ...spaced.slice(index + 1)].join(' '),
      }
    })
  )
}

/** A figure with no token of its own: "no make it 2", "flip 3 of it". */
const BARE_FIGURE = /^\s*(?:$|[,.!?;:)]|of\s+(?:it|that|this|them)\b|please\b)/i

/**
 * A figure as typed, or nothing if its comma is not a thousands comma. In "1,5" or "0,500" a comma
 * is a decimal point, and dropping it would read many times the amount, while reading it as a point
 * is a guess, so neither is the amount. See `AMOUNT`.
 */
export function figureValue(text: string): string | undefined {
  const plain = text.replace(/,+$/, '')
  if (plain.includes(',') && !/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/.test(plain)) return undefined
  return canonicalNumber(plain)
}

export function canonicalNumber(text: string): string {
  const [whole = '', fraction = ''] = text.replace(/,/g, '').split('.')
  const trimmed = fraction.replace(/0+$/, '')
  const digits = whole.replace(/^0+(?=\d)/, '') || '0'
  return trimmed === '' ? digits : `${digits}.${trimmed}`
}

/**
 * Whether the person themselves said this amount and this token. A model's text never sets what is
 * signed, so a cash-out it wrote out runs only if the person's own words carry the same figures.
 * The amount must be the last figure stated, so a correction wins over what it corrects and what
 * is spent wins over what is held, and it must stand alone, so 15 is not 5, and "$5", "5 dollars",
 * "5k" and "5%" are not 5 of a token. The token must stand alone too, and a chain's name reads as
 * its token either way round, so "solana" is SOL. Only where it names the coin, though: "5 USDT on
 * solana" did not say SOL, and a model must not get to read it so. Pass what the person typed, and
 * none of the model's lines.
 */
export function sequenceWordsMatch(
  instruction: { amount: string; token: string },
  turns: readonly string[]
): boolean {
  const symbol = chainTokenWord(instruction.token)
  const last = figuresSaid(symbol, turns).at(-1)
  return (
    tokenSaid(instruction.token, turns) &&
    last?.value === canonicalNumber(instruction.amount) &&
    countStandsOverDollars(symbol, turns)
  )
}

interface DollarFigure {
  value: string | undefined
  start: number
  end: number
}

/** Every figure in US dollars. Another country's dollars, R$ or CA$, are not these. */
function dollarFigures(text: string): DollarFigure[] {
  const number = String.raw`(\d[\d,]*(?:\.\d+)?|\.\d+)(?![\w%]|[.,]\d)`
  const dollars = new RegExp(
    String.raw`(?:(?<![A-Za-z])|(?<=\bus))\$${number}|(?:^|[^\w.,$₦£€])${number}\s*(?:usd|dollars?|bucks?)(?![\w+])`,
    'gi'
  )
  return [...text.matchAll(dollars)].map((match) => {
    const at = match.index ?? 0
    return {
      value: figureValue((match[1] ?? match[2]) as string),
      start: match[2] === undefined ? at : at + match[0].indexOf(match[2]),
      end: at + match[0].length,
    }
  })
}

function byToken(token: string): RegExp {
  return new RegExp(
    String.raw`^\s*(?:(?:usd|dollars?)\s+)?(?:worth\s+)?(?:of\s+)?(?:my\s+|the\s+)?(?:${token})${WORD_END}`,
    'i'
  )
}

/**
 * With dollars said as well, a count is only a count if it names its token and comes last. In "$1
 * of SOL, no make it 2" the 2 corrects the dollars, and in "5 SOL if it is above $100" either figure
 * could be taken for the amount, so the person is asked to say it in full and no model chooses.
 */
function countStandsOverDollars(symbol: string, turns: readonly string[]): boolean {
  const joined = spacedTurns(symbol, turns).join('\n')
  const money = dollarFigures(joined).at(-1)
  if (money === undefined) return true
  const plain = figuresSaid(symbol, [joined]).at(-1)
  if (plain === undefined || money.start >= joined.length - plain.after.length) return false
  return byToken(tokenPattern(symbol).token).test(plain.after)
}

/** What may come right before a bare figure that corrects an earlier one. */
const CORRECTING =
  /(?:^|\n|\b(?:actually|no|nope|instead|rather|sorry|make it|change it to))[\s,:-]*$/i

/**
 * Whether the person themselves said this many dollars of this token: "$5 of SOL", "5 dollars worth
 * of my SOL", "SOL worth $5". The same rules as a count of tokens, for the same reason. It must be
 * the last figure stated, so a correction wins, and it must sit by the token given up, so "$5 of
 * USDC to SOL" is not $5 of SOL. A bare figure counts only as a correction of dollars already said
 * of that token, so "5 SOL if it is above $100" is not $100 of SOL. A token received is named after.
 */
export function dollarsSaid(
  amount: string,
  tokenIn: string,
  tokenOut: string | undefined,
  turns: readonly string[]
): boolean {
  const symbol = chainTokenWord(tokenIn)
  const { token } = tokenPattern(symbol)
  const joined = spacedTurns(symbol, turns).join('\n')
  const figures = dollarFigures(joined)
  const last = figures.at(-1)
  if (last === undefined || last.value !== canonicalNumber(amount)) return false

  const after = joined.slice(last.end)
  const plain = figuresSaid(symbol, [joined]).at(-1)
  if (plain !== undefined && joined.length - plain.after.length > last.end) return false

  const worth = new RegExp(String.raw`(?:^|[^A-Za-z0-9.+])(?:${token})\s+worth\s+(?:of\s+)?$`, 'i')
  const named = (figure: DollarFigure): boolean =>
    byToken(token).test(joined.slice(figure.end)) || worth.test(joined.slice(0, figure.start))

  if (named(last)) {
    const follows = byToken(token).exec(after)
    const rest = follows === null ? after : after.slice(follows[0].length)
    return tokenOut === undefined || tokenSaid(tokenOut, [rest], true)
  }
  const correction =
    figures.slice(0, -1).some(named) &&
    BARE_FIGURE.test(after) &&
    CORRECTING.test(joined.slice(0, last.start)) &&
    !tokenSaid(tokenIn, [after], true)
  if (!correction) return false
  return tokenOut === undefined || tokenOutFollows(token, tokenOut, joined)
}

/** Whether the person said the figure of a cash-out the model wrote out, in whichever unit it is. */
export function cashoutSaid(
  route: Extract<CashoutRoute, { kind: 'sequence' }>,
  turns: readonly string[]
): boolean {
  return route.amountIsUsd === true
    ? dollarsSaid(route.amount, route.token, undefined, turns)
    : sequenceWordsMatch(route, turns)
}

export function tokenPattern(symbol: string): { token: string; names: string[] } {
  const names = chainNamesOf(symbol)
  const token = [symbol, ...names].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return { token, names }
}

/** "5sol" read as "5 sol", and "$ 5" as "$5". */
export function spacedTurns(symbol: string, turns: readonly string[]): string[] {
  const glued = new RegExp(String.raw`(\d)(${tokenPattern(symbol).token})${WORD_END}`, 'gi')
  return turns.map((turn) => turn.replace(glued, '$1 $2').replace(/([$₦£€])\s+/g, '$1'))
}

export const WORD_END = String.raw`(?![A-Za-z0-9+]|\.[A-Za-z0-9])`

/**
 * Whether the person themselves named this token, alone as a word. A chain's name counts as its
 * token only where it names the coin: not after "on", "in", "from" and the like. A token received,
 * `destination`, may also be named "to solana" or "into solana".
 */
export function tokenSaid(token: string, turns: readonly string[], destination = false): boolean {
  const symbol = chainTokenWord(token)
  const { token: pattern, names } = tokenPattern(symbol)
  const word = new RegExp(String.raw`(?:^|[^A-Za-z0-9.+])(?:${pattern})${WORD_END}`, 'i')
  const prepositions = destination
    ? 'on|in|from|at|via|using|through'
    : 'on|in|from|to|into|at|via|using|through'
  const place =
    names.length === 0
      ? undefined
      : new RegExp(
          String.raw`\b(?:${prepositions})\s+(?:my\s+|the\s+)?(?:${names.join('|')})\b|\b(?:${names.join('|')})\s+(?:wallet|account|address|chain|network|blockchain)\b`,
          'gi'
        )
  return spacedTurns(symbol, turns).some((turn) =>
    word.test(place === undefined ? turn : turn.replace(place, ' '))
  )
}

/**
 * Whether the amount sits next to the token given up ("5 SOL" or "SOL 5", "5 of my SOL"), and, when
 * a token received is given, that token is named after it. Read over all the person's turns in
 * order, joined, so "swap some sol", "5", "to usdc" is one swap. The last figure said counts with
 * no token of its own, "no make it 2", or as a correction, "actually 3 sol". Then the token received
 * must be named after the token given up, and the token given up not after the figure, which would
 * make "5 to sol from usdc" read backwards. The reverse of a swap is not it.
 */
export function swapOrderSaid(
  amount: string,
  tokenIn: string,
  tokenOut: string | undefined,
  turns: readonly string[]
): boolean {
  const symbol = chainTokenWord(tokenIn)
  const { token } = tokenPattern(symbol)
  const joined = spacedTurns(symbol, turns).join(' ')
  const number = String.raw`(\d[\d,]*(?:\.\d+)?|\.\d+)(?![\w%]|[.,]\d)`
  const before = new RegExp(
    String.raw`(?:^|[^\w.,$₦£€])${number}\s*(?:of\s+)?(?:my\s+|the\s+)?(?:${token})${WORD_END}`,
    'gi'
  )
  const after = new RegExp(
    String.raw`(?:^|[^A-Za-z0-9.+])(?:${token})${WORD_END}[\s:=x]*${number}`,
    'gi'
  )
  const wanted = canonicalNumber(amount)
  const ends: number[] = []
  for (const match of joined.matchAll(before)) {
    if (figureValue(match[1] as string) === wanted) ends.push((match.index ?? 0) + match[0].length)
  }
  for (const match of joined.matchAll(after)) {
    if (figureValue(match[1] as string) === wanted) ends.push((match.index ?? 0) + match[0].length)
  }
  const last = figuresSaid(symbol, turns).at(-1)
  const isLast = last?.value === wanted
  const bare = isLast && BARE_FIGURE.test(last.after) && !tokenSaid(tokenIn, [last.rest], true)
  if (tokenOut === undefined) return ends.length > 0 || (bare && tokenSaid(tokenIn, turns))
  if (ends.some((end) => tokenSaid(tokenOut, [joined.slice(end)], true))) return true
  return (bare || (isLast && ends.length > 0)) && tokenOutFollows(token, tokenOut, joined)
}

/** Whether, after some naming of the token given up, the token received is named. */
function tokenOutFollows(token: string, tokenOut: string, joined: string): boolean {
  const given = new RegExp(String.raw`(?:^|[^A-Za-z0-9.+])(?:${token})${WORD_END}`, 'gi')
  return [...joined.matchAll(given)].some((match) =>
    tokenSaid(tokenOut, [joined.slice((match.index ?? 0) + match[0].length)], true)
  )
}

/**
 * The answer to "which currency?" when it was typed as a cash-out, "cash out to KES", while a swap
 * waits on the question. Nothing for a request with its own amount, which is a new request.
 */
export function questionAnswerFrom(
  question: { sequence?: unknown; answer?: string } | null,
  route: CashoutRoute
): CashoutCurrencyCode | undefined {
  if (question?.sequence === undefined || question.answer !== undefined) return undefined
  return route.kind === 'open' && route.amount === undefined ? route.currency : undefined
}

/** A question asked on one chain can't start a swap on another, whose follow-ons were not checked. */
export function questionChainRefusal(asked: string, now: string): string | undefined {
  return asked === now
    ? undefined
    : 'This was asked on another chain, so it did not start. Nothing was signed or sent.'
}

export const FOLLOW_ON_UNCHECKED =
  'I could not check that the next step can finish, so the swap did not start. Nothing was signed or sent.'

export type FollowOnAnswer = { request: ChainSequenceRequest; note?: string } | { refusal: string }

/** The sequence as the server says it will run: its venue, and anything it had to change. */
function asPlanned(
  request: ChainSequenceRequest,
  body: { kind?: unknown; venue?: unknown; tokenOut?: unknown; note?: unknown }
): FollowOnAnswer {
  const { followOn, swap } = request
  if (followOn.kind === 'cashout' || followOn.kind === 'send') return { request }
  const kind = body.kind === 'stake' || body.kind === 'supply' ? body.kind : followOn.kind
  const venue = typeof body.venue === 'string' ? body.venue : followOn.venue
  const planned: ChainSequenceRequest = {
    swap: typeof body.tokenOut === 'string' ? { ...swap, tokenOut: body.tokenOut } : swap,
    followOn: venue === undefined ? { kind } : { kind, venue },
  }
  return typeof body.note === 'string'
    ? { request: planned, note: body.note }
    : { request: planned }
}

/**
 * Asks the server whether a deposit, stake or send could run after this swap, while the swap is
 * unsigned: its venues, what they take, and what only the chain can say about a receiver. Any answer
 * but a clear yes refuses, so a swap never starts on a follow-on nobody checked.
 */
export async function readFollowOnPlan(
  chain: string,
  request: ChainSequenceRequest,
  account: string
): Promise<FollowOnAnswer> {
  const { followOn, swap } = request
  if (followOn.kind === 'cashout') return { request }
  const step = {
    kind: followOn.kind,
    tokenIn: swap.tokenOut,
    ...(followOn.kind === 'send' ? { recipient: followOn.recipient } : {}),
    ...(followOn.kind !== 'send' && followOn.venue !== undefined ? { venue: followOn.venue } : {}),
  }
  try {
    const response = await fetch(`/api/chain/${chain}/follow-on`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, step }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })
    const body = (await response.json()) as {
      ok?: unknown
      error?: unknown
      kind?: unknown
      venue?: unknown
      tokenOut?: unknown
      note?: unknown
    }
    if (response.status === 200 && body.ok === true) return asPlanned(request, body)
    return {
      refusal:
        response.status === 422 && typeof body.error === 'string'
          ? body.error
          : FOLLOW_ON_UNCHECKED,
    }
  } catch {
    return { refusal: FOLLOW_ON_UNCHECKED }
  }
}
