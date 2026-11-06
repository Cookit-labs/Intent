import { WHOLE_AMOUNT, type ChainActionRequest } from './types'

/**
 * Commas only as thousands, 1,000 or 1,000.5. In "1,5" or "0,500" a comma is a decimal point, and
 * dropping it would read many times the amount, so that is no amount at all and the person is told
 * what works. Thousands never start with a zero.
 */
export const AMOUNT = String.raw`\$?((?:[1-9]\d{0,2}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)`
const TOKEN = String.raw`([a-z][a-z0-9.+]{0,11})`
const VENUE = String.raw`(?:\s+(?:on|via|with|using|in|into|at|to)\s+([a-z0-9][a-z0-9 .-]{1,30}?))?`
const END = String.raw`\s*[.!]?\s*$`

const SWAP = new RegExp(
  String.raw`^(?:please\s+)?(?:swap|convert|exchange|trade|change)\s+${AMOUNT}\s*${TOKEN}\s+(?:to|for|into)\s+${TOKEN}${VENUE}${END}`,
  'i'
)
const SUPPLY = new RegExp(
  String.raw`^(?:please\s+)?(?:supply|lend|deposit|save|earn on|put)\s+${AMOUNT}\s*${TOKEN}${VENUE}${END}`,
  'i'
)
const STAKE = new RegExp(
  String.raw`^(?:please\s+)?(?:liquid\s+)?stake\s+${AMOUNT}\s*${TOKEN}${VENUE}${END}`,
  'i'
)
/** Case stays as typed, since it is part of an address. Ends on a letter or digit, not a full stop. */
const SEND = new RegExp(
  String.raw`^(?:please\s+)?(?:send|transfer)\s+${AMOUNT}\s*${TOKEN}\s+to\s+([a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?)${END}`,
  'i'
)

const FROM_VENUE = String.raw`(?:\s+(?:from|on|at|in|via|with|using)\s+([a-z0-9][a-z0-9 .-]{1,30}?))?`
const ADDRESS = String.raw`([a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?)`

const WITHDRAW = new RegExp(
  String.raw`^(?:please\s+)?(?:withdraw|redeem)\s+${AMOUNT}\s*${TOKEN}${FROM_VENUE}${END}`,
  'i'
)
const UNSTAKE = new RegExp(
  String.raw`^(?:please\s+)?unstake\s+${AMOUNT}\s*${TOKEN}${FROM_VENUE}${END}`,
  'i'
)
const BORROW = new RegExp(
  String.raw`^(?:please\s+)?borrow\s+${AMOUNT}\s*${TOKEN}${FROM_VENUE}${END}`,
  'i'
)
const REPAY = new RegExp(
  String.raw`^(?:please\s+)?(?:repay|pay back)\s+${AMOUNT}\s*${TOKEN}${FROM_VENUE}${END}`,
  'i'
)
/** The length is said in days or months, a month read as 30 days, so nothing is left to a default. */
const STREAM = new RegExp(
  String.raw`^(?:please\s+)?(?:stream|pay)\s+${AMOUNT}\s*${TOKEN}\s+to\s+${ADDRESS}\s+over\s+(\d{1,4})\s+(day|days|month|months)${FROM_VENUE}${END}`,
  'i'
)
const INVOICE = new RegExp(
  String.raw`^(?:please\s+)?invoice\s+${ADDRESS}\s+(?:for\s+)?${AMOUNT}\s*${TOKEN}\s+due\s+(\d{4}-\d{2}-\d{2})${FROM_VENUE}${END}`,
  'i'
)
/** The amount is said too, so what is paid is what the person read, and the invoice must match it. */
const PAY_INVOICE = new RegExp(
  String.raw`^(?:please\s+)?pay\s+invoice\s+#?(\d{1,30})\s+(?:with\s+)?${AMOUNT}\s*${TOKEN}${FROM_VENUE}${END}`,
  'i'
)

/** All of a position: "withdraw all USDC", "withdraw all my USDC", "withdraw my USDC". */
const WHOLE = String.raw`(?:all(?:\s+of)?(?:\s+my)?|everything\s+in|max|my(?:\s+entire)?)`
const WITHDRAW_WHOLE = new RegExp(
  String.raw`^(?:please\s+)?(?:withdraw|redeem|take\s+out)\s+${WHOLE}\s+${TOKEN}${FROM_VENUE}${END}`,
  'i'
)
const UNSTAKE_WHOLE = new RegExp(
  String.raw`^(?:please\s+)?unstake\s+${WHOLE}\s+${TOKEN}${FROM_VENUE}${END}`,
  'i'
)
const REPAY_WHOLE = new RegExp(
  String.raw`^(?:please\s+)?(?:repay|pay\s+back|pay\s+off)\s+${WHOLE}\s+${TOKEN}${FROM_VENUE}${END}`,
  'i'
)
/** Collecting a finished unstake. It takes no amount: it is what the chain says is ready. */
const CLAIM = new RegExp(
  String.raw`^(?:please\s+)?(?:claim|collect)\s+(?:my\s+)?(?:unstaked\s+|cooled\s+)?${TOKEN}${FROM_VENUE}${END}`,
  'i'
)
/** Case stays as typed, since an id can be an address. */
const CANCEL_STREAM = new RegExp(
  String.raw`^(?:please\s+)?cancel\s+(?:my\s+)?stream\s+#?([a-z0-9]{1,64})${FROM_VENUE}${END}`,
  'i'
)
/** A stream's token is read from the chain, so nothing in the request should claim to know it. */
const STREAM_TOKEN = 'STREAM'

const DAYS_IN_A_MONTH = 30

/** Sentences that ask to do something, so a miss gets told what works rather than a guess. */
const ACTION_VERB =
  /\b(swap|convert|exchange|trade|change|buy|sell|supply|lend|deposit|save|earn|stake|unstake|withdraw|redeem|borrow|repay|stream|invoice|claim|cash out|send|bridge|long|short)\b/i

/** People say the chain for its coin. `sui` and `near` are already their symbols. */
const TOKEN_OF_CHAIN_NAME: ReadonlyMap<string, string> = new Map([
  ['solana', 'SOL'],
  ['avalanche', 'AVAX'],
  ['monad', 'MON'],
])

/** A chain's name as its token, whole word and any case. Every other word comes back unchanged. */
export function chainTokenWord(word: string): string {
  return TOKEN_OF_CHAIN_NAME.get(word.toLowerCase()) ?? word
}

/** The chain names that read as this token, for checking what someone said against it. */
export function chainNamesOf(token: string): string[] {
  const wanted = token.toUpperCase()
  return [...TOKEN_OF_CHAIN_NAME].filter(([, symbol]) => symbol === wanted).map(([name]) => name)
}

const FIGURE = String.raw`(\d[\d,]*(?:\.\d+)?|\.\d+)`
/** "$5 worth of sol", "$5 of sol", "5 dollars worth of sol" and "5 usd of sol": a figure in dollars. */
const WORTH_OF = new RegExp(
  String.raw`(^|[^\w$.,])(?:\$\s?${FIGURE}|${FIGURE}\s?(?:usd|dollars?|bucks))\s+(worth\s+of|of)\s+(?:my\s+|the\s+)?([a-z][a-z0-9.+]{0,11})(?![a-z0-9])`,
  'gi'
)
/** After a bare "of", only a token counts: "$110 of profit" is no amount of anything. */
const TOKEN_AFTER_OF = new Set([
  'sol',
  'sui',
  'near',
  'avax',
  'mon',
  'xlm',
  'usdc',
  'usdt',
  'eth',
  'btc',
  'wbtc',
  'wal',
  'deep',
  'jup',
  'bonk',
  'jitosol',
  'msol',
])

/**
 * "$0.8 worth of sol" as "$0.8 sol", the one shape the strict parsers read as dollars, so no model
 * is left to decide between dollars and a count. Nothing else in the text changes.
 */
export function dollarsWorthOf(text: string): string {
  return text.replace(
    WORTH_OF,
    (
      whole,
      lead: string,
      dollar: string | undefined,
      word: string | undefined,
      link: string,
      token: string
    ) => {
      const isToken =
        TOKEN_AFTER_OF.has(token.toLowerCase()) || TOKEN_OF_CHAIN_NAME.has(token.toLowerCase())
      if (!/^worth/i.test(link) && !isToken) return whole
      return `${lead}$${dollar ?? word} ${token}`
    }
  )
}

/** Plain decimal text: no separators, one leading zero on ".5" and none on "05". */
export function amountOf(text: string): string {
  const plain = text.replace(/,/g, '')
  return (plain.startsWith('.') ? `0${plain}` : plain).replace(/^0+(?=\d)/, '')
}

/**
 * "$5 SOL" is five dollars of SOL, not five SOL, which differ by the price of SOL. A dollar of USDC
 * is one USDC, so that stays a count. The `$` must come before the first figure: it is the amount's.
 */
export function dollarsOn(text: string, token: string): { amountIsUsd?: true } {
  return /^[^\d$]*\$/.test(text.trim()) && token.toUpperCase() !== 'USDC'
    ? { amountIsUsd: true }
    : {}
}

/**
 * Reads a plain instruction into an action, or nothing.
 *
 * Deliberately a strict shape and not a guess. An instruction that moves money
 * and is read wrongly costs money, so anything looser falls through to being
 * told what works. Tokens and venues are checked on the server.
 */
export function parseChainAction(text: string): ChainActionRequest | null {
  const swap = SWAP.exec(text.trim())
  if (swap !== null) {
    const tokenIn = chainTokenWord(swap[2] as string)
    return {
      kind: 'swap',
      amount: amountOf(swap[1] as string),
      ...dollarsOn(text, tokenIn),
      tokenIn,
      tokenOut: chainTokenWord(swap[3] as string),
      venue: swap[4]?.trim(),
    }
  }
  const supply = SUPPLY.exec(text.trim())
  if (supply !== null) {
    const tokenIn = chainTokenWord(supply[2] as string)
    return {
      kind: 'supply',
      amount: amountOf(supply[1] as string),
      ...dollarsOn(text, tokenIn),
      tokenIn,
      venue: supply[3]?.trim(),
    }
  }
  const stake = STAKE.exec(text.trim())
  if (stake !== null) {
    const tokenIn = chainTokenWord(stake[2] as string)
    return {
      kind: 'stake',
      amount: amountOf(stake[1] as string),
      ...dollarsOn(text, tokenIn),
      tokenIn,
      venue: stake[3]?.trim(),
    }
  }
  const send = SEND.exec(text.trim())
  if (send !== null) {
    const tokenIn = chainTokenWord(send[2] as string)
    return {
      kind: 'send',
      amount: amountOf(send[1] as string),
      ...dollarsOn(text, tokenIn),
      tokenIn,
      recipient: send[3] as string,
    }
  }
  return parsePositionAction(text.trim()) ?? parsePaymentAction(text.trim())
}

/** Taking out of a position, or borrowing against one: an amount, a token and maybe a venue. */
function parsePositionAction(text: string): ChainActionRequest | null {
  const wholes = [
    ['withdraw', WITHDRAW_WHOLE],
    ['unstake', UNSTAKE_WHOLE],
    ['repay', REPAY_WHOLE],
    ['claim', CLAIM],
  ] as const
  for (const [kind, shape] of wholes) {
    const match = shape.exec(text)
    if (match !== null) {
      return {
        kind,
        amount: WHOLE_AMOUNT,
        tokenIn: chainTokenWord(match[1] as string),
        venue: match[2]?.trim(),
      }
    }
  }
  const cancel = CANCEL_STREAM.exec(text)
  if (cancel !== null) {
    return {
      kind: 'cancel',
      amount: WHOLE_AMOUNT,
      tokenIn: STREAM_TOKEN,
      streamId: cancel[1] as string,
      venue: cancel[2]?.trim(),
    }
  }
  const shapes = [
    ['withdraw', WITHDRAW],
    ['unstake', UNSTAKE],
    ['borrow', BORROW],
    ['repay', REPAY],
  ] as const
  for (const [kind, shape] of shapes) {
    const match = shape.exec(text)
    if (match !== null) {
      return {
        kind,
        amount: amountOf(match[1] as string),
        tokenIn: chainTokenWord(match[2] as string),
        venue: match[3]?.trim(),
      }
    }
  }
  return null
}

function parsePaymentAction(text: string): ChainActionRequest | null {
  const stream = STREAM.exec(text)
  if (stream !== null) {
    const count = Number(stream[4])
    const months = (stream[5] as string).toLowerCase().startsWith('month')
    if (count === 0) return null
    return {
      kind: 'stream',
      amount: amountOf(stream[1] as string),
      tokenIn: chainTokenWord(stream[2] as string),
      recipient: stream[3] as string,
      durationDays: String(months ? count * DAYS_IN_A_MONTH : count),
      venue: stream[6]?.trim(),
    }
  }
  const invoice = INVOICE.exec(text)
  if (invoice !== null) {
    return {
      kind: 'invoice',
      recipient: invoice[1] as string,
      amount: amountOf(invoice[2] as string),
      tokenIn: chainTokenWord(invoice[3] as string),
      dueDate: invoice[4] as string,
      venue: invoice[5]?.trim(),
    }
  }
  const pay = PAY_INVOICE.exec(text)
  if (pay !== null) {
    return {
      kind: 'pay_invoice',
      invoiceId: pay[1] as string,
      amount: amountOf(pay[2] as string),
      tokenIn: chainTokenWord(pay[3] as string),
      venue: pay[4]?.trim(),
    }
  }
  return null
}

const RACED_KINDS: readonly ChainActionRequest['kind'][] = ['swap', 'supply', 'stake']

/** Whether the agents price this first. Only a choice between venues on a price has a race to run. */
export function racesFirst(request: Pick<ChainActionRequest, 'kind'>): boolean {
  return RACED_KINDS.includes(request.kind)
}

export function looksLikeChainAction(text: string): boolean {
  return ACTION_VERB.test(text)
}
