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
import { nearTokens } from './near/tokens'
import {
  cashoutAmountFrom,
  deliveredAmount,
  strandedReply,
  type ChainSequenceRequest,
  type FollowOn,
} from './sequence'
import { SOLANA_TOKENS } from './solana/tokens'
import { SUI_TOKENS } from './sui/tokens'
import {
  tokenBySymbol,
  type ChainToken,
  type ChainWithActions,
  type SigningPayload,
  type TokenBalance,
  type WalletBalances,
} from './types'

/**
 * A swap, then what comes after it. The swap is an ordinary chain action, signed on its own card,
 * and this reads how it ended. `settled` is the only answer that lets step 2 be offered.
 */
export type SequenceStage = 'swap' | 'measuring' | 'ready' | 'next' | 'stranded' | 'done'

export const MEASURE_INTERVAL_MS = 3_000
export const MEASURE_ATTEMPTS = 20
export const BEFORE_RETRY_MS = 1_500

/** As long as the balances route may run, so one read that hangs still ends as one attempt. */
const READ_TIMEOUT_MS = 20_000

export const CASHOUT_UNDER_WAY =
  'A cash-out is already under way. Follow it here, and do not send it again.'

/** Step 1 may or may not have moved money, so this says neither. */
export const UNCONFIRMED_SWAP =
  "This swap is not confirmed, so the cash-out will not start. Check your wallet's activity before doing anything else. Nothing was paid out."

export const SWAP_NEXT_STEP =
  'Step 2 waits for your press. It uses what the swap actually delivers.'

export const BALANCE_UNREAD =
  'I could not read your USDC balance, so if you sign this swap the cash-out will not follow. You would hold the USDC and can cash it out yourself.'

export const TOO_SMALL_FOR_WEAVE =
  'Weave would refuse a cash-out this small, so this swap would leave you holding the USDC.'

const LEFT_HOLDING = 'This swap would leave you holding the USDC.'

/** Beside the card's own words for the failure, which may or may not say nothing moved. */
export const CASHOUT_NOT_STARTED = 'The cash-out did not start.'

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
  if (stage === 'stranded') return { stage, settled: false, error: UNCONFIRMED_SWAP }
  if (stage === 'done') return { stage, settled: false, error: CASHOUT_NOT_STARTED }
  return { stage, settled: false }
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

/** What the swap's card says about what follows it, in place of promising what won't happen. */
export function swapLine(
  phase: ChainActionPhase,
  status: BeforeStatus,
  quoted: string | undefined
): string {
  if (status === 'unknown' && (phase === 'review' || phase === 'signing')) return BALANCE_UNREAD
  return quoted ?? SWAP_NEXT_STEP
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

/** What reached the wallet, and whether that is enough to cash out. */
export function deliveredLine(delivered: string): string {
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
  error: string | undefined
): string | undefined {
  if (stage === 'ready' && delivered !== undefined) return deliveredLine(delivered)
  return stage === 'stranded' || stage === 'done' ? error : undefined
}

function outputSymbol(request: ChainSequenceRequest): string {
  return (request.swap.tokenOut ?? '').toUpperCase()
}

/** Said when a swap that settled is left before step 2 ran, or nothing where there is no news. */
export function endedNote(
  stage: SequenceStage | undefined,
  delivered: string | undefined,
  request: ChainSequenceRequest | null
): string | undefined {
  if (request === null) return undefined
  if (stage !== 'measuring' && stage !== 'ready' && stage !== 'next') return undefined
  return strandedReply(outputSymbol(request), delivered, request.followOn)
}

/** Step 1's sentence after the measure could not finish. */
export function unmeasuredReply(request: ChainSequenceRequest): string {
  return strandedReply(outputSymbol(request), undefined, request.followOn)
}

export function stepLabels(request: ChainSequenceRequest): [string, string] {
  const { amount, tokenIn } = request.swap
  const first = `Swap ${amount} ${tokenIn.toUpperCase()} to ${outputSymbol(request)}`
  const { followOn } = request
  return [
    first,
    followOn.kind === 'cashout' && followOn.currency !== undefined
      ? `Cash out to ${followOn.currency}`
      : 'Cash out',
  ]
}

export type StepMark = 'now' | 'waiting' | 'done' | 'stopped'

/** How each step stands. `settled` is whether step 1 is known to have settled. */
export function stepMarks(stage: SequenceStage, settled: boolean): [StepMark, StepMark] {
  if (!settled) return stage === 'swap' ? ['now', 'waiting'] : ['stopped', 'stopped']
  if (stage === 'stranded') return ['done', 'stopped']
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

function canonicalNumber(text: string): string {
  const [whole = '', fraction = ''] = text.replace(/,/g, '').split('.')
  const trimmed = fraction.replace(/0+$/, '')
  const digits = whole.replace(/^0+(?=\d)/, '') || '0'
  return trimmed === '' ? digits : `${digits}.${trimmed}`
}

/**
 * Whether the person themselves said this amount and this token. A model's text never sets what is
 * signed, so a cash-out it wrote out runs only if the person's own words carry the same figures.
 * The amount must stand alone, so 15 is not 5, and "$5", "5 dollars", "5k" and "5%" are not 5 of a
 * token. The token must stand alone too, so SOLANA is not SOL: the parser reads it as its own word.
 * Pass what the person typed, and none of the model's lines.
 */
export function sequenceWordsMatch(
  instruction: { amount: string; token: string },
  turns: readonly string[]
): boolean {
  const token = instruction.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const wordEnd = String.raw`(?![A-Za-z0-9+]|\.[A-Za-z0-9])`
  const glued = new RegExp(String.raw`(\d)(${token})${wordEnd}`, 'gi')
  const word = new RegExp(String.raw`(?:^|[^A-Za-z0-9.+])${token}${wordEnd}`, 'i')
  const number = new RegExp(
    String.raw`(?:^|[^\w.,$₦£€])(\d[\d,]*(?:\.\d+)?|\.\d+)(?![\w%]|[.,]\d)(?!\s*(?:${NOT_THE_AMOUNT})(?![\w+]))`,
    'gi'
  )
  const wanted = canonicalNumber(instruction.amount)
  const spaced = turns.map((turn) => turn.replace(glued, '$1 $2').replace(/([$₦£€])\s+/g, '$1'))
  return (
    spaced.some((turn) => word.test(turn)) &&
    spaced.some((turn) =>
      [...turn.matchAll(number)].some((match) => canonicalNumber(match[1] as string) === wanted)
    )
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

/**
 * The follow-ons this build can finish. Refused before step 1, like any follow-on that cannot run.
 * A cash-out is the only one yet: supply, stake and send arrive with `runNext` learning them.
 */
export function followOnNotYet(followOn: FollowOn): string | undefined {
  return followOn.kind === 'cashout'
    ? undefined
    : 'A swap followed by a deposit, a stake or a send is not yet available here. Nothing was signed or sent.'
}
