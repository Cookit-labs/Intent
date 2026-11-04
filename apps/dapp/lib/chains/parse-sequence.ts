import { parseCashout } from '../weave/parse-cashout'
import { AMOUNT, amountOf, chainTokenWord, parseChainAction } from './parse-action'
import type { ChainSequenceRequest, FollowOn } from './sequence'
import { sequenceWordsMatch } from './sequence-flow'
import type { ChainActionRequest } from './types'

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
}

const EXAMPLE_AFTER: Record<string, string> = {
  offramp: ' then cash out',
  lend: ' then deposit',
  send: ' then send to an address',
}

function refuseUnsaid(read: ReadSwap, what: string): { refusal: string } {
  const after = read.followOn === null ? '' : (EXAMPLE_AFTER[read.followOn.kind] ?? '')
  return {
    refusal: `I could not find ${what} in what you typed, and only your own words decide what is signed. Say it in full, for example "swap 5 ${chainTokenWord(read.tokenIn)} to ${chainTokenWord(read.tokenOut)}${after}". Nothing was signed or sent.`,
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
export function requestSaid(request: ChainActionRequest, said: readonly string[]): boolean {
  if (!sequenceWordsMatch({ amount: request.amount, token: request.tokenIn }, said)) return false
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
  const model = read.followOn
  if (model === null) return null
  const swap = swapOf(read)
  if ('refusal' in swap) return swap
  if (!requestSaid(swap, said)) return refuseUnsaid(read, 'that amount and token')

  let followOn: FollowOn
  if (model.kind === 'offramp') {
    followOn = { kind: 'cashout' }
  } else if (model.kind === 'lend') {
    if (model.venueNamed === true && !said.some((t) => t.toLowerCase().includes(model.venue))) {
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

/** A plain swap a model read, held to the same words as a sequence. */
export function swapFromReading(
  read: ReadSwap,
  said: readonly string[]
): ChainActionRequest | { refusal: string } {
  const swap = swapOf(read)
  if ('refusal' in swap) return swap
  return requestSaid(swap, said)
    ? swap
    : refuseUnsaid({ ...read, followOn: null }, 'that amount and token')
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
 * `sequenceFromReading`. Either way, the amount, the token and any recipient must be in `said`, the
 * person's own turns, or the request is refused in words. Nothing when nothing here can run it.
 */
export function chainRouteFromReading(
  read: ReadSwap & { action: string },
  instruction: string,
  said: readonly string[]
): ChainRoute | null {
  if (read.followOn !== null) {
    const out = sequenceFromReading(read, said)
    return out === null ? null : 'refusal' in out ? out : { sequence: out }
  }
  const sequence = parseChainSequence(instruction)
  if (sequence !== null) {
    if ('refusal' in sequence) return sequence
    const { followOn } = sequence
    const recipientSaid = followOn.kind !== 'send' || typedExactly(followOn.recipient, said)
    return requestSaid(sequence.swap, said) && recipientSaid
      ? { sequence }
      : refuseUnsaid(
          {
            ...read,
            followOn: { kind: followOn.kind === 'cashout' ? 'offramp' : 'send', venue: '' },
          },
          'that request'
        )
  }
  const action = parseChainAction(instruction)
  if (action !== null) {
    return requestSaid(action, said)
      ? { action }
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
  if (read.action !== 'swap') return null
  const swap = swapFromReading(read, said)
  return 'refusal' in swap ? swap : { action: swap }
}
