import {
  currencyNamedIn,
  isFiatWord,
  parseCashout,
  routeCashout,
  type CashoutRoute,
} from '../weave/parse-cashout'
import { AMOUNT, amountOf, chainTokenWord, parseChainAction } from './parse-action'
import {
  SEQUENCE_CASHOUT_CHAINS,
  followOnRefusal,
  type ChainSequenceRequest,
  type FollowOn,
} from './sequence'
import { sequenceWordsMatch, swapOrderSaid } from './sequence-flow'
import type { ChainActionRequest, ChainWithActions } from './types'

const TOKEN = String.raw`([a-z][a-z0-9.+]{0,11})`
const CONNECTOR = String.raw`(?:\s*,\s*(?:and\s+then\s+|then\s+|and\s+)?|\s+(?:and\s+then|then|and)\s+)`

const SEQUENCE = new RegExp(
  String.raw`^(?:please\s+)?(?:swap|convert|exchange|trade|change)\s+${AMOUNT}\s*${TOKEN}\s+(?:to|for|into)\s+${TOKEN}${CONNECTOR}(.+?)\s*[.!]?\s*$`,
  'i'
)
const CASHOUT = /^(?:cash[ -]?out|off[ -]?ramp|withdraw to bank)(?:\s+(.+))?$/i
const EARN =
  /^(deposit|supply|lend|save|earn)(?:\s+it)?(?:\s+(?:on|via|with|using|in|into|at|to)\s+(\S.*?))?$/i
const STAKE = /^stake(?:\s+it)?(?:\s+(?:on|via|with|using|in|into|at|to)\s+(\S.*?))?$/i
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
  const earn = EARN.exec(text)
  if (earn !== null)
    return earn[2] === undefined ? { kind: 'supply' } : { kind: 'supply', venue: earn[2].trim() }
  const stake = STAKE.exec(text)
  if (stake !== null)
    return stake[1] === undefined ? { kind: 'stake' } : { kind: 'stake', venue: stake[1].trim() }
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
): ChainSequenceRequest | { refusal: string } | null {
  const match = SEQUENCE.exec(text.trim())
  if (match === null) return null
  const followOn = followOnOf((match[4] as string).trim())
  if (followOn === null) return null
  if ('refusal' in followOn) return followOn
  return withSwap(
    {
      kind: 'swap',
      amount: amountOf(match[1] as string),
      tokenIn: chainTokenWord(match[2] as string),
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
  const sequence = parseChainSequence(text)
  if (sequence !== null) {
    return 'refusal' in sequence
      ? { kind: 'refusal', refusal: sequence.refusal }
      : { kind: 'sequence', request: sequence }
  }
  const currency = swapIntoCurrency(text, chain, chainName)
  if (currency !== undefined) return currency
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
  return read.kind === 'sequence' || read.kind === 'action'
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
}

const EXAMPLE_AFTER: Record<string, string> = {
  offramp: ' then cash out',
  lend: ' then deposit',
  stake: ' then stake',
  send: ' then send to an address',
}

/** An example that could run: USDC can't be swapped to itself, and goes to a bank with no swap. */
function exampleOf(read: ReadSwap): string {
  const kind = read.followOn?.kind
  const after = kind === undefined ? '' : (EXAMPLE_AFTER[kind] ?? '')
  const tokenIn = chainTokenWord(read.tokenIn)
  if (tokenIn.toUpperCase() !== 'USDC') return `swap 5 ${tokenIn} to USDC${after}`
  if (kind === 'offramp') return 'cash out 5 USDC'
  const tokenOut = chainTokenWord(read.tokenOut)
  return tokenOut.toUpperCase() === 'USDC' ? '5 USDC' : `swap 5 USDC to ${tokenOut}${after}`
}

function refuseUnsaid(read: ReadSwap, what: string): { refusal: string } {
  return {
    refusal: `I could not find ${what} in what you typed, and only your own words decide what is signed. Say it in full, for example "${exampleOf(read)}". Nothing was signed or sent.`,
  }
}

/** The amount and token a model read, or why it cannot be used. Nothing is checked against words. */
function swapOf(read: ReadSwap): ChainActionRequest | { refusal: string } {
  const amount = String(read.amountUsd)
  if (
    !read.amountStated ||
    read.amountIsUsd === true ||
    read.amountOf === 'received' ||
    !/^\d+(?:\.\d+)?$/.test(amount)
  ) {
    return refuseUnsaid(read, 'an amount of the token you are swapping')
  }
  return {
    kind: 'swap',
    amount,
    tokenIn: chainTokenWord(read.tokenIn),
    tokenOut: chainTokenWord(read.tokenOut),
    venue: undefined,
  }
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
  if (!sequenceWordsMatch({ amount: request.amount, token: request.tokenIn }, said)) return false
  const out = request.tokenOut
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
): ChainSequenceRequest | { refusal: string } | null {
  const model = read.followOn ?? refusedFollowOn(read, said)
  if (model === null) return null
  const swap = swapOf(read)
  if ('refusal' in swap) return swap
  if (!requestSaid(swap, said, model.kind === 'offramp')) {
    return refuseUnsaid(read, 'that amount, token and token to receive')
  }

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
      return refuseUnsaid(read, 'that venue')
    }
    followOn =
      model.venueNamed === true ? { kind: 'supply', venue: model.venue } : { kind: 'supply' }
  } else if (model.kind === 'send') {
    const recipient = model.recipient ?? ''
    if (!typedExactly(recipient, said)) return refuseUnsaid(read, 'that address')
    followOn = { kind: 'send', recipient }
  } else {
    return refuseUnsaid(read, 'what to do after the swap')
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

/** Something was asked after the swap that no reading here holds, so a plain swap would lose it. */
function moreAfterSwap(instruction: string, said: readonly string[]): boolean {
  return SEQUENCE.test(instruction.trim()) || said.some((turn) => /\bthen\s+\S/i.test(turn))
}

/** A plain swap a model read, held to the same words as a sequence. */
export function swapFromReading(
  read: ReadSwap,
  said: readonly string[]
): ChainActionRequest | { refusal: string } {
  const swap = swapOf(read)
  if ('refusal' in swap) return swap
  return requestSaid(swap, said)
    ? swap
    : refuseUnsaid({ ...read, followOn: null }, 'that amount, token and token to receive')
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
  instruction: string,
  said: readonly string[]
): ChainRoute | null {
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
      ? { sequence: { ...sequence, followOn: ownFollowOn(followOn, said) } }
      : refuseUnsaid(
          { ...read, followOn: { kind: READING_KIND[followOn.kind], venue: '' } },
          'that request'
        )
  }
  const action = parseChainAction(instruction)
  if (action === null && read.action !== 'swap') return null
  if (moreAfterSwap(instruction, said)) {
    return refuseUnsaid(
      { ...read, followOn: { kind: 'send', venue: '' } },
      'what to do after the swap'
    )
  }
  if (action !== null) {
    // A venue the model added is dropped, and the action kept, unless the person named it.
    const own =
      action.venue !== undefined && !venueSaid(action.venue, said)
        ? { ...action, venue: undefined }
        : action
    return requestSaid(own, said)
      ? { action: own }
      : refuseUnsaid(
          {
            ...read,
            tokenIn: action.tokenIn,
            tokenOut: action.tokenOut ?? action.tokenIn,
            followOn: null,
          },
          'that request'
        )
  }
  const swap = swapFromReading(read, said)
  return 'refusal' in swap ? swap : { action: swap }
}
