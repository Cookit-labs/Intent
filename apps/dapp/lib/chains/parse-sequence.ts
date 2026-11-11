import {
  currencyNamedIn,
  isFiatWord,
  parseCashout,
  routeCashout,
  type CashoutRoute,
} from '../weave/parse-cashout'
import { LIMIT_NOT_HERE } from './limit'
import { ordersAsked } from './orders-view'
import { LIMIT_EXAMPLES, limitSaid, limitShapeRefusal, parseChainLimit } from './parse-limit'
import {
  AMOUNT,
  amountOf,
  chainTokenWord,
  dollarsOn,
  dollarsWorthOf,
  parseChainAction,
} from './parse-action'
import {
  SEQUENCE_CASHOUT_CHAINS,
  followOnRefusal,
  type ChainSequenceRequest,
  type FollowOn,
} from './sequence'
import { dollarsSaid, sequenceWordsMatch, swapOrderSaid, tokenSaid } from './sequence-flow'
import type { ChainActionKind, ChainActionRequest, ChainWithActions } from './types'

const TOKEN = String.raw`([a-z][a-z0-9.+]{0,11})`
const CONNECTOR = String.raw`(?:\s*,\s*(?:and\s+then\s+|then\s+|and\s+)?|\s+(?:and\s+then|then|and)\s+)`

const SEQUENCE = new RegExp(
  String.raw`^(?:please\s+)?(?:swap|convert|exchange|trade|change)\s+${AMOUNT}\s*${TOKEN}\s+(?:to|for|into)\s+${TOKEN}${CONNECTOR}(.+?)\s*[.!]?\s*$`,
  'i'
)
const CASHOUT = /^(?:cash[ -]?out|off[ -]?ramp|withdraw to bank)(?:\s+(.+))?$/i
/** What the swap delivered, however it is referred to. Naming a token is left to the model. */
const WHAT_ARRIVED = String.raw`(?:\s+(?:it|that|this|them|the\s+(?:proceeds|funds|money|tokens?|output)|everything|all(?:\s+of\s+(?:it|that))?))?`
const PLACE = String.raw`(?:\s+(?:on|via|with|using|in|into|at|to)\s+(\S.*?))?`
const EARN = new RegExp(
  String.raw`^(?:deposit|supply|lend|save|earn|put)${WHAT_ARRIVED}${PLACE}$`,
  'i'
)
const STAKE = new RegExp(String.raw`^stake${WHAT_ARRIVED}${PLACE}$`, 'i')
const EARN_YIELD = /^earn\s+(?:yield|interest)(?:\s+on\s+(?:it|that|this|them))?$/i
/** "put it" with nowhere to put it asks for nothing. */
const PUT_ALONE = /^put\b/i
/**
 * Words for a kind of place and not for a place: "a yield vault", "the lending pool". They leave
 * the choice of venue open, where taking them for a venue's name would refuse the whole request.
 */
const ANY_PLACE =
  /^(?:(?:an?|the|some|my)\s+)?(?:(?:yield|earn(?:ing)?|lending|savings?|interest|defi)(?:[- ]bearing)?\s*)*(?:vaults?|pools?|venues?|protocols?|apps?|markets?|accounts?|yields?|earn|savings?|lending)?$/i

/** "Earn" alone is how a venue is named on NEAR, where 1Click Earn answers to it. */
function namedPlace(words: string | undefined): string | undefined {
  const place = words?.trim()
  if (place === undefined) return undefined
  return ANY_PLACE.test(place) && place.toLowerCase() !== 'earn' ? undefined : place
}
/** An address and nothing else: NEAR accounts add `.`, `_`, `-` and `:` inside. */
const ADDRESS_CHARS = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const SEND = /^(?:send|transfer)(?:\s+it)?\s+to\s+(\S+)$/i

function followOnOf(text: string): FollowOn | { refusal: string } | null {
  const cashout = CASHOUT.exec(text)
  if (cashout !== null) {
    if (cashout[1] === undefined) return { kind: 'cashout' }
    const read = parseCashout(`cash out ${cashout[1]}`)
    if (read === null || 'unsupportedToken' in read) return null
    if ('unsupportedCurrency' in read) {
      return {
        refusal: `Cash-outs don't pay out in ${read.unsupportedCurrency}. Nothing was signed or sent.`,
      }
    }
    if (read.amount !== undefined) return null
    return read.currency === undefined
      ? { kind: 'cashout' }
      : { kind: 'cashout', currency: read.currency }
  }
  if (EARN_YIELD.test(text)) return { kind: 'supply' }
  const earn = EARN.exec(text)
  if (earn !== null && !(earn[1] === undefined && PUT_ALONE.test(text))) {
    const venue = namedPlace(earn[1])
    return venue === undefined ? { kind: 'supply' } : { kind: 'supply', venue }
  }
  const stake = STAKE.exec(text)
  if (stake !== null) {
    const venue = namedPlace(stake[1])
    return venue === undefined ? { kind: 'stake' } : { kind: 'stake', venue }
  }
  const send = SEND.exec(text)
  if (send !== null && ADDRESS_CHARS.test(send[1] as string)) {
    return { kind: 'send', recipient: send[1] as string }
  }
  return null
}

/**
 * Reads "swap X to Y, then <cash out | deposit | stake | send to ADDRESS>", or nothing.
 * A strict shape, like a plain action. A cash-out after a swap that does not end in USDC
 * is refused in words, since that is never going to work.
 */
export function parseChainSequence(
  text: string
): ChainSequenceRequest | { refusal: string; question?: string } | null {
  const match = SEQUENCE.exec(text.trim())
  if (match === null) return null
  const followOn = followOnOf((match[4] as string).trim())
  if (followOn === null) return null
  if ('refusal' in followOn) return followOn
  const tokenIn = chainTokenWord(match[2] as string)
  return withSwap(
    {
      kind: 'swap',
      amount: amountOf(match[1] as string),
      ...dollarsOn(text, tokenIn),
      tokenIn,
      tokenOut: chainTokenWord(match[3] as string),
      venue: undefined,
    },
    followOn
  )
}

/** A cash-out after a swap that does not end in USDC is refused in words, since it cannot work. */
function withSwap(
  swap: ChainActionRequest,
  followOn: FollowOn
): ChainSequenceRequest | { refusal: string } {
  const tokenOut = swap.tokenOut as string
  if (followOn.kind === 'cashout' && tokenOut.toUpperCase() !== 'USDC') {
    return {
      refusal: `Cash-outs take USDC, so this swap would have to end in USDC, not ${tokenOut.toUpperCase()}. Nothing was signed or sent.`,
    }
  }
  return { swap, followOn }
}

const SWAP_INTO_WORDS = new RegExp(
  String.raw`^(?:please\s+)?(?:swap|convert|exchange|trade|change)\s+(?:my\s+)?(${AMOUNT})\s*${TOKEN}\s+(?:to|for|into)\s+(?:my\s+|the\s+)?(.+?)\s*[.!]?\s*$`,
  'i'
)

type CashoutGoes = Exclude<CashoutRoute, { kind: 'pass' }>

/** What a message typed on a chain with its own module is, before any model has read it. */
export type ChainMessageRead =
  | { kind: 'refusal'; refusal: string }
  | { kind: 'sequence'; request: ChainSequenceRequest }
  | { kind: 'action'; action: ChainActionRequest }
  | { kind: 'limit'; action: ChainActionRequest }
  | { kind: 'orders' }
  | { kind: 'cashout'; route: CashoutGoes }
  | { kind: 'model' }

/**
 * "change 5 SOL into naira": the output is money and not a token, so this is a cash-out. Nothing
 * for a swap that ends in anything else. A venue after the currency has no bearing on a payout.
 */
function swapIntoCurrency(
  text: string,
  chain: ChainWithActions,
  chainName: string
): ChainMessageRead | undefined {
  const match = SWAP_INTO_WORDS.exec(text.trim())
  if (match === null) return undefined
  const target = (match[4] as string)
    .toLowerCase()
    .replace(/\s+(?:on|via|with|using|at)\s.*$/, '')
    .replace(/\s+/g, ' ')
  if (!isFiatWord(target)) return undefined
  if (!SEQUENCE_CASHOUT_CHAINS.includes(chain)) {
    const refusal = followOnRefusal(chain, chainName, { kind: 'cashout' }, [])
    return refusal === undefined ? { kind: 'model' } : { kind: 'refusal', refusal }
  }
  const route = routeCashout(
    parseCashout(`cash out ${match[1] as string} ${match[3] as string} to ${target}`),
    chain
  )
  return route.kind === 'pass' ? { kind: 'model' } : { kind: 'cashout', route }
}

/**
 * This decides whether a message off Stellar goes to the model. Only a request the strict parsers
 * read in full stays here. Everything else does go, verbs included, since the words people use
 * have no end: `chainRouteFromReading` holds what comes back to the person's own words, and returns
 * nothing when nothing can run it, and `helpForUnread` answers if the model can't be reached.
 */
export function readChainMessage(
  text: string,
  chain: ChainWithActions,
  chainName: string
): ChainMessageRead {
  // "$5 worth of sol" is read here as dollars, so it never waits on a model to say which it is.
  text = dollarsWorthOf(text)
  const sequence = parseChainSequence(text)
  if (sequence !== null) {
    return 'refusal' in sequence
      ? { kind: 'refusal', refusal: sequence.refusal }
      : { kind: 'sequence', request: sequence }
  }
  const currency = swapIntoCurrency(text, chain, chainName)
  if (currency !== undefined) return currency
  // Before the plain parser, which would read "swap 50 USDC to SOL at 90" as a swap on a venue "90".
  const notHere = LIMIT_NOT_HERE[chain]
  const limit = parseChainLimit(text)
  if (limit !== null) {
    return notHere === undefined
      ? { kind: 'limit', action: limit }
      : { kind: 'refusal', refusal: notHere }
  }
  const shape = limitShapeRefusal(text)
  if (shape !== undefined) return { kind: 'refusal', refusal: notHere ?? shape }
  if (ordersAsked(text)) {
    return notHere === undefined ? { kind: 'orders' } : { kind: 'refusal', refusal: notHere }
  }
  const action = parseChainAction(text)
  return action === null ? { kind: 'model' } : { kind: 'action', action }
}

/** Whether a cash-out route opens something, where the others only answer in words. */
export function cashoutStarts(route: CashoutRoute): boolean {
  return route.kind === 'ask' || route.kind === 'open' || route.kind === 'sequence'
}

/**
 * Whether a typed message starts an action, for `keepsRun`. A refusal starts nothing, and what the
 * model has yet to read is not known to, so neither ends what is under way.
 */
export function messageStartsAction(route: CashoutRoute, read: ChainMessageRead | null): boolean {
  if (cashoutStarts(route)) return true
  if (read === null) return false
  if (read.kind === 'cashout') return cashoutStarts(read.route)
  return read.kind === 'sequence' || read.kind === 'action' || read.kind === 'limit'
}

/**
 * What a model read of a request, as far as this file needs it. The orchestrator's reading fits it,
 * and so does the chat's `UnderstoodIntent`.
 */
export interface ReadSwap {
  tokenIn: string
  tokenOut: string
  amountUsd: number
  amountStated: boolean
  amountIsUsd?: boolean | undefined
  amountOf?: 'sent' | 'received' | undefined
  followOn: { kind: string; venue: string; venueNamed?: true; recipient?: string } | null
  /** A follow-on the server read and this chain can't honour. It must not become a plain swap. */
  followOnRefused?: { kind: 'lend' | 'offramp'; venue: string } | undefined
  /** How the model read the order: a `limit` must never run as a market swap. */
  style?: string | undefined
}

const EXAMPLE_AFTER: Record<string, string> = {
  offramp: ' then cash out',
  lend: ' then deposit',
  stake: ' then stake',
  send: ' then send to an address',
}

/** An example that could run: USDC can't be swapped to itself, and goes to a bank with no swap. */
function exampleOf(read: ReadSwap, asked: ChainActionKind | undefined): string {
  const kind = read.followOn?.kind
  const after = kind === undefined ? '' : (EXAMPLE_AFTER[kind] ?? '')
  const tokenIn = cleanToken(read.tokenIn)
  // An example of what was asked: a stake is shown a stake, never a swap.
  if (kind === undefined && asked !== undefined && asked !== 'swap') {
    const verb = VERB[asked] ?? asked
    return asked === 'send' ? `send 5 ${tokenIn} to an address` : `${verb} 5 ${tokenIn}`
  }
  if (tokenIn.toUpperCase() !== 'USDC') return `swap 5 ${tokenIn} to USDC${after}`
  if (kind === 'offramp') return 'cash out 5 USDC'
  const tokenOut = cleanToken(read.tokenOut)
  if (tokenOut.toUpperCase() !== 'USDC') return `swap 5 USDC to ${tokenOut}${after}`
  if (kind === 'send' || asked === 'send') return 'send 5 USDC to an address'
  if (kind === 'stake' || asked === 'stake') return 'stake 5 USDC'
  return 'deposit 5 USDC'
}

/** A token as the person would write it: the chain's coin for its name, with no stray punctuation. */
function cleanToken(token: string): string {
  return chainTokenWord(token.trim().replace(/[.,!?;:]+$/, '')).toUpperCase()
}

/** The verb a question uses for each kind of action. */
const VERB: Partial<Record<string, string>> = {
  swap: 'swap',
  stake: 'stake',
  supply: 'deposit',
  lend: 'deposit',
  send: 'send',
  unstake: 'unstake',
  withdraw: 'withdraw',
  borrow: 'borrow',
  repay: 'repay',
  claim: 'claim',
  offramp: 'cash out',
}

/**
 * The one question that gets what is missing from the person's own words. The model understood
 * them; what it read just can't be signed until they say the figure, the token or the address
 * themselves, so they are asked for exactly that, and their answer is read with what came before.
 */
function questionFor(
  read: ReadSwap,
  what: string,
  asked: ChainActionKind | undefined,
  said: readonly string[]
): string {
  if (what === 'that address') {
    return 'Which address should it go to? Paste the full address, exactly as it is.'
  }
  if (what === 'what to do after the swap') {
    return 'What should happen after the swap: cash out, deposit, stake or send it?'
  }
  if (what === 'that venue') return 'Which app do you want to deposit with?'
  const verb = VERB[asked ?? 'swap'] ?? asked ?? 'swap'
  const token = cleanToken(read.tokenIn)
  if (!tokenSaid(token, said)) return `Which token do you want to ${verb}?`
  const amountSaid =
    read.amountStated && sequenceWordsMatch({ amount: String(read.amountUsd), token }, said)
  if (amountSaid && (asked ?? 'swap') === 'swap')
    return `What do you want to get for your ${token}?`
  return `How much ${token} do you want to ${verb}? Say a number, or "half" or "all".`
}

function refuseUnsaid(
  read: ReadSwap,
  what: string,
  /** What was asked, where the reading alone doesn't say. */
  asked?: ChainActionKind,
  /** The person's own turns. With them, the missing part is asked for rather than refused. */
  said?: readonly string[]
): { refusal: string; question?: string } {
  return {
    refusal: `I could not find ${what} in what you typed, and only your own words decide what is signed. Say it in full, for example "${exampleOf(read, asked)}". Nothing was signed or sent.`,
    ...(said !== undefined ? { question: questionFor(read, what, asked, said) } : {}),
  }
}

/**
 * A model reads an amount as a JSON number, which keeps about 16 digits. When the person typed
 * more, what comes back is their figure rounded, which no longer matches what they said. It is put
 * back exactly as they typed it, so their own digits are what is checked and what is signed.
 */
function ownDigits(text: string, said: readonly string[]): string {
  const typed = (said.join(' ').match(/\d[\d,]*\.\d{16,}/g) ?? []).map((t) => t.replace(/,/g, ''))
  if (typed.length === 0) return text
  return text.replace(/\d+\.\d+/g, (n) => typed.find((t) => Number(t) === Number(n)) ?? n)
}

function withOwnDigits<T>(swap: T, said: readonly string[]): T {
  if (typeof swap !== 'object' || swap === null || !('amount' in swap)) return swap
  const amount = (swap as { amount: unknown }).amount
  return typeof amount === 'string' ? { ...swap, amount: ownDigits(amount, said) } : swap
}

/** The amount and token a model read, or why it cannot be used. Nothing is checked against words. */
function swapOf(
  read: ReadSwap
): ChainActionRequest | { refusal: string } | { refusal: string; question: string } {
  const amount = String(read.amountUsd)
  if (!read.amountStated || read.amountOf === 'received' || !/^\d+(?:\.\d+)?$/.test(amount)) {
    const token = chainTokenWord(read.tokenIn).toUpperCase()
    return {
      ...refuseUnsaid(read, 'an amount of the token you are swapping'),
      question: `How much ${token} do you want to swap? You can say a number, or "all my ${token}".`,
    }
  }
  return {
    kind: 'swap',
    amount,
    ...(read.amountIsUsd === true ? { amountIsUsd: true as const } : {}),
    tokenIn: chainTokenWord(read.tokenIn),
    tokenOut: chainTokenWord(read.tokenOut),
    venue: undefined,
  }
}

const STABLE = /^(?:USDC|USDT0?)$/i

/**
 * A model often reads "50 USDC" as fifty dollars. Where the words say a count of the stablecoin it
 * is one, and stays exact rather than being sized at a live price.
 */
function countedInStable(swap: ChainActionRequest, said: readonly string[]): ChainActionRequest {
  if (swap.amountIsUsd !== true || !STABLE.test(swap.tokenIn)) return swap
  if (dollarsSaid(swap.amount, swap.tokenIn, undefined, said)) return swap
  const { amountIsUsd: _dollars, ...counted } = swap
  return counted
}

/** A venue's id, such as jupiter-lend, against "Jupiter Lend" or "jupiterlend" as typed. */
function venueSaid(venue: string, said: readonly string[]): boolean {
  const plain = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '')
  return said.some((turn) => plain(turn).includes(plain(venue)))
}

/** An address or name exactly as typed: whole, with the same letters, not inside a longer word. */
function typedExactly(recipient: string, said: readonly string[]): boolean {
  if (recipient === '') return false
  const escaped = recipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const whole = new RegExp(
    String.raw`(?<![A-Za-z0-9._:-])${escaped}(?![A-Za-z0-9_:-]|\.[A-Za-z0-9])`
  )
  return said.some((turn) => whole.test(turn))
}

/**
 * Whether the amount, the token and any recipient of a request were in what the person typed. A
 * model writes none of these into a signature: it can only restate words that are there.
 */
export function requestSaid(
  request: ChainActionRequest,
  said: readonly string[],
  /** A cash-out follows, which takes USDC, so a swap that names no output is to USDC. */
  usdcImplied = false
): boolean {
  const out = request.tokenOut
  if (request.amountIsUsd === true) {
    const asNamed = dollarsSaid(request.amount, request.tokenIn, out, said)
    const toUsdc =
      usdcImplied &&
      out !== undefined &&
      chainTokenWord(out).toUpperCase() === 'USDC' &&
      dollarsSaid(request.amount, request.tokenIn, undefined, said)
    if (asNamed || toUsdc) {
      return request.recipient === undefined || typedExactly(request.recipient, said)
    }
    if (!STABLE.test(chainTokenWord(request.tokenIn))) return false
  }
  if (!sequenceWordsMatch({ amount: request.amount, token: request.tokenIn }, said)) return false
  // Named in order: the amount by the token given up, and the token received after it. A cash-out
  // takes USDC, so with one following, a swap that names no output is to USDC.
  const named = out !== undefined && swapOrderSaid(request.amount, request.tokenIn, out, said)
  const implied =
    out === undefined ||
    (usdcImplied &&
      chainTokenWord(out).toUpperCase() === 'USDC' &&
      swapOrderSaid(request.amount, request.tokenIn, undefined, said))
  if (out !== undefined && !named && !implied) return false
  if (out === undefined && !swapOrderSaid(request.amount, request.tokenIn, undefined, said)) {
    return false
  }
  return request.recipient === undefined || typedExactly(request.recipient, said)
}

/**
 * A swap a model read with a follow-on, as the same sequence a typed sentence makes, or nothing
 * when it read no follow-on. The amount and token must be in `said`, the person's own typed turns,
 * and so must a recipient, character for character. What fails is refused in words, never run.
 */
export function sequenceFromReading(
  read: ReadSwap,
  said: readonly string[]
): ChainSequenceRequest | { refusal: string; question?: string } | null {
  const model = read.followOn ?? refusedFollowOn(read, said)
  if (model === null) return null
  const read$ = withOwnDigits(swapOf(read), said)
  if ('refusal' in read$) return read$
  if (!requestSaid(read$, said, model.kind === 'offramp')) {
    return refuseUnsaid(read, 'that amount, token and token to receive', 'swap', said)
  }
  const swap = countedInStable(read$, said)

  let followOn: FollowOn
  if (model.kind === 'offramp') {
    if (model.venueNamed === true) {
      return {
        refusal: `Cash-outs here don't run through ${model.venue}. Nothing was signed or sent.`,
      }
    }
    followOn = withCurrency({ kind: 'cashout' }, said)
  } else if (model.kind === 'lend') {
    if (model.venueNamed === true && !venueSaid(model.venue, said)) {
      return refuseUnsaid(read, 'that venue', 'supply', said)
    }
    followOn =
      model.venueNamed === true ? { kind: 'supply', venue: model.venue } : { kind: 'supply' }
  } else if (model.kind === 'send') {
    const recipient = model.recipient ?? ''
    if (!typedExactly(recipient, said)) return refuseUnsaid(read, 'that address', 'send', said)
    followOn = { kind: 'send', recipient }
  } else {
    return refuseUnsaid(read, 'what to do after the swap', 'swap', said)
  }
  return withSwap(swap, followOn)
}

/**
 * A follow-on the server refused, as one the chat can refuse in the chain's own words before step
 * 1. The venue stays only if the person named it, for the server to answer. One the model chose is
 * dropped, like any other.
 */
function refusedFollowOn(read: ReadSwap, said: readonly string[]): ReadSwap['followOn'] {
  const refused = read.followOnRefused
  if (refused === undefined) return null
  return refused.venue !== '' && venueSaid(refused.venue, said)
    ? { kind: refused.kind, venue: refused.venue, venueNamed: true }
    : { kind: refused.kind, venue: '' }
}

/** A cash-out with the currency the person named, so they are not asked it again. */
function withCurrency(
  cashout: Extract<FollowOn, { kind: 'cashout' }>,
  said: readonly string[]
): FollowOn {
  if (cashout.currency !== undefined) return cashout
  const currency = currencyNamedIn(said)
  return currency === undefined ? cashout : { ...cashout, currency }
}

/** What a sentence the model wrote may set for step 2: never a venue the person didn't name. */
function ownFollowOn(followOn: FollowOn, said: readonly string[]): FollowOn {
  if (followOn.kind === 'cashout') return withCurrency(followOn, said)
  if (followOn.kind === 'send' || followOn.venue === undefined) return followOn
  return venueSaid(followOn.venue, said) ? followOn : { kind: followOn.kind }
}

const FOLLOW_ON_WORDS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:cash[ -]?out|off[ -]?ramp|withdraw)\b/i, 'offramp'],
  [/\b(?:deposit|supply|lend|save|earn)\b/i, 'lend'],
  [/\bstake\b/i, 'stake'],
  [/\b(?:send|transfer)\b/i, 'send'],
]

/** The follow-on these words ask for, in a reading's name for it, or nothing if they name none. */
function followOnKindSaid(instruction: string, said: readonly string[]): string | undefined {
  const text = [...said, instruction].join(' ')
  return FOLLOW_ON_WORDS.find(([words]) => words.test(text))?.[1]
}

/** Something was asked after the swap that no reading here holds, so a plain swap would lose it. */
function moreAfterSwap(instruction: string, said: readonly string[]): boolean {
  return SEQUENCE.test(instruction.trim()) || said.some((turn) => /\bthen\s+\S/i.test(turn))
}

/** A plain swap a model read, held to the same words as a sequence. */
export function swapFromReading(
  read: ReadSwap,
  said: readonly string[]
): ChainActionRequest | { refusal: string; question?: string } {
  const swap = withOwnDigits(swapOf(read), said)
  if ('refusal' in swap) return swap
  return requestSaid(swap, said)
    ? countedInStable(swap, said)
    : refuseUnsaid(
        { ...read, followOn: null },
        'that amount, token and token to receive',
        'swap',
        said
      )
}

/** A reading's name for each follow-on, which is what the examples go by. */
const READING_KIND: Record<FollowOn['kind'], string> = {
  cashout: 'offramp',
  supply: 'lend',
  stake: 'stake',
  send: 'send',
}

/** What the chat does with an act the orchestrator read off Stellar. */
export type ChainRoute =
  | { sequence: ChainSequenceRequest }
  | { action: ChainActionRequest }
  | { refusal: string }
  /** Something the person can answer, such as how much: asked rather than refused. */
  | { refusal: string; question: string }

/** A limit order a model read, held to the person's words, or why not. Nothing when it is no limit. */
function limitRouteFromReading(
  read: ReadSwap,
  instruction: string,
  said: readonly string[],
  chain: ChainWithActions | undefined
): ChainRoute | undefined {
  const limit = parseChainLimit(instruction)
  const notHere = chain === undefined ? undefined : LIMIT_NOT_HERE[chain]
  if (limit !== null) {
    if (notHere !== undefined) return { refusal: notHere }
    if (limitSaid(limit, said)) return { action: limit }
    return {
      refusal: `I could not find that amount, token and price in what you typed, and only your own words decide what is signed. Say it in full, ${LIMIT_EXAMPLES}. Nothing was signed or sent.`,
    }
  }
  const shape = limitShapeRefusal(instruction)
  if (shape !== undefined) return { refusal: notHere ?? shape }
  if (read.style === 'limit') {
    return {
      refusal:
        notHere ??
        `I could not read that as a limit order. Say it in full, ${LIMIT_EXAMPLES}. Nothing was signed or sent.`,
    }
  }
  return undefined
}

/**
 * Where an orchestrator reading goes off Stellar, so it never reaches Stellar's swap card.
 *
 * A sentence the model wrote out in the shape a person types, "swap 5 SOL to USDC, then send to X",
 * is read by the same strict parsers as one typed. A follow-on it set in its reading is converted by
 * `sequenceFromReading`, and so is one the server could not honour, which is then refused before
 * step 1 like any other that can't run. Either way, the amount, the token and any recipient must be
 * in `said`, the person's own turns, or the request is refused in words. Nothing when nothing here
 * can run it.
 */
export function chainRouteFromReading(
  read: ReadSwap & { action: string },
  modelInstruction: string,
  said: readonly string[],
  chain?: ChainWithActions
): ChainRoute | null {
  // The model ends its sentence with a full stop, which is no part of the last token or address.
  const instruction = ownDigits(modelInstruction.trim().replace(/[.!?]+$/, ''), said)
  const limit = limitRouteFromReading(read, instruction, said, chain)
  if (limit !== undefined) return limit
  if (read.followOn !== null || read.followOnRefused !== undefined) {
    const out = sequenceFromReading(read, said)
    return out === null ? null : 'refusal' in out ? out : { sequence: out }
  }
  const sequence = parseChainSequence(instruction)
  if (sequence !== null) {
    if ('refusal' in sequence) return sequence
    const { followOn } = sequence
    const recipientSaid = followOn.kind !== 'send' || typedExactly(followOn.recipient, said)
    return requestSaid(sequence.swap, said, followOn.kind === 'cashout') && recipientSaid
      ? {
          sequence: {
            ...sequence,
            swap: countedInStable(sequence.swap, said),
            followOn: ownFollowOn(followOn, said),
          },
        }
      : refuseUnsaid(
          { ...read, followOn: { kind: READING_KIND[followOn.kind], venue: '' } },
          'that request',
          'swap',
          said
        )
  }
  const action = parseChainAction(instruction)
  // An action the model read with no size: asked how much, in that action's words, rather than
  // handed back with nothing to say.
  if (action === null && read.action !== 'swap' && !read.amountStated) {
    const asked = read.action as ChainActionKind
    if (VERB[asked] !== undefined && tokenSaid(cleanToken(read.tokenIn), said)) {
      return refuseUnsaid(read, 'that amount', asked, said) as { refusal: string; question: string }
    }
  }
  if (action === null && read.action !== 'swap') return null
  if (moreAfterSwap(instruction, said)) {
    const kind = followOnKindSaid(instruction, said)
    return refuseUnsaid(
      { ...read, followOn: kind === undefined ? null : { kind, venue: '' } },
      'what to do after the swap',
      'swap',
      said
    )
  }
  if (action !== null) {
    // A venue the model added is dropped, and the action kept, unless the person named it.
    const own =
      action.venue !== undefined && !venueSaid(action.venue, said)
        ? { ...action, venue: undefined }
        : action
    return requestSaid(own, said)
      ? { action: countedInStable(own, said) }
      : refuseUnsaid(
          {
            ...read,
            tokenIn: action.tokenIn,
            tokenOut: action.tokenOut ?? action.tokenIn,
            followOn: null,
          },
          'that request',
          action.kind,
          said
        )
  }
  const swap = swapFromReading(read, said)
  return 'refusal' in swap ? swap : { action: swap }
}
