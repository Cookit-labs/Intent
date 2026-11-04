import { parseCashout } from '../weave/parse-cashout'
import { amountOf } from './parse-action'
import type { ChainSequenceRequest, FollowOn } from './sequence'

const AMOUNT = String.raw`\$?([\d,]*\.?\d+)`
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
  if (send !== null) return { kind: 'send', recipient: send[1] as string }
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
  const tokenOut = match[3] as string
  if (followOn.kind === 'cashout' && tokenOut.toUpperCase() !== 'USDC') {
    return {
      refusal: `Cash-outs take USDC, so this swap would have to end in USDC, not ${tokenOut.toUpperCase()}. Nothing was signed or sent.`,
    }
  }
  return {
    swap: {
      kind: 'swap',
      amount: amountOf(match[1] as string),
      tokenIn: match[2] as string,
      tokenOut,
      venue: undefined,
    },
    followOn,
  }
}
