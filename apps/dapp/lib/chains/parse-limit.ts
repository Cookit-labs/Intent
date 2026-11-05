import { limitPair } from './limit'
import { AMOUNT, amountOf, chainTokenWord } from './parse-action'
import {
  canonicalNumber,
  figureValue,
  spacedTurns,
  tokenPattern,
  tokenSaid,
  WORD_END,
} from './sequence-flow'
import type { ChainActionRequest } from './types'

/** A count of tokens: a dollar figure here would be dollars, which a limit order does not take. */
const COUNT = AMOUNT.replace(String.raw`\$?`, '')
const TOKEN = String.raw`([a-z][a-z0-9.+]{0,11})`
const AT = String.raw`(?:at|@|when\s+it\s+(?:hits|reaches)|if\s+it\s+(?:hits|reaches))\s*`
const END = String.raw`\s*[.!]?\s*$`

const SELL = new RegExp(
  String.raw`^(?:please\s+)?(?:limit\s+)?sell\s+${COUNT}\s*${TOKEN}(?:\s+(?:for|to|into)\s+${TOKEN})?\s+${AT}${AMOUNT}${END}`,
  'i'
)
const SWAP = new RegExp(
  String.raw`^(?:please\s+)?(?:limit\s+)?(?:swap|convert|exchange|trade|change)\s+${COUNT}\s*${TOKEN}\s+(?:to|for|into)\s+${TOKEN}\s+${AT}${AMOUNT}${END}`,
  'i'
)
const BUY_PAYING_FIRST = new RegExp(
  String.raw`^(?:please\s+)?(?:limit\s+)?buy\s+${TOKEN}\s+(?:with|using)\s+${COUNT}\s*${TOKEN}\s+${AT}${AMOUNT}${END}`,
  'i'
)
const BUY_PRICE_FIRST = new RegExp(
  String.raw`^(?:please\s+)?(?:limit\s+)?buy\s+${TOKEN}\s+${AT}${AMOUNT}\s+(?:with|using)\s+${COUNT}\s*${TOKEN}${END}`,
  'i'
)

function order(
  amount: string,
  given: string,
  got: string,
  price: string
): ChainActionRequest | null {
  const tokenIn = chainTokenWord(given)
  const tokenOut = chainTokenWord(got)
  if (limitPair(tokenIn, tokenOut) === undefined) return null
  return {
    kind: 'limit',
    amount: amountOf(amount),
    tokenIn,
    tokenOut,
    limitPrice: amountOf(price),
    venue: undefined,
  }
}

/**
 * Reads "sell 1 SOL at $110" or "buy SOL with 50 USDC at 90" into a limit order, or nothing. A strict
 * shape: the amount is a count of the token given up, the price is in a stablecoin, and anything
 * else, such as an amount received, is left unread.
 */
export function parseChainLimit(text: string): ChainActionRequest | null {
  const typed = text.trim()
  const sell = SELL.exec(typed)
  if (sell !== null) {
    return order(sell[1] as string, sell[2] as string, sell[3] ?? 'USDC', sell[4] as string)
  }
  const swap = SWAP.exec(typed)
  if (swap !== null) {
    return order(swap[1] as string, swap[2] as string, swap[3] as string, swap[4] as string)
  }
  const paying = BUY_PAYING_FIRST.exec(typed)
  if (paying !== null) {
    return order(paying[2] as string, paying[3] as string, paying[1] as string, paying[4] as string)
  }
  const early = BUY_PRICE_FIRST.exec(typed)
  if (early !== null) {
    return order(early[3] as string, early[4] as string, early[1] as string, early[2] as string)
  }
  return null
}

const SHAPE_VERB = /^(?:please\s+)?(?:limit\s+)?(?:sell|buy|swap|convert|exchange|trade|change)\b/i
const PRICE_AT_END = new RegExp(
  String.raw`(?:\bat|@|\bwhen\s+it\s+(?:hits|reaches)|\bif\s+it\s+(?:hits|reaches))\s*\$?(\d[\d,]*(?:\.\d+)?)${END}`,
  'i'
)
const BUY_BY_COUNT = new RegExp(
  String.raw`^(?:please\s+)?(?:limit\s+)?buy\s+${COUNT}\s*${TOKEN}\s+`,
  'i'
)
const SELL_BY_DOLLARS = new RegExp(
  String.raw`^(?:please\s+)?(?:limit\s+)?sell\s+\$[\d,.]+\s*(?:of\s+)?${TOKEN}\b`,
  'i'
)

export const LIMIT_EXAMPLES = 'for example "sell 1 SOL at $110" or "buy SOL with 180 USDC at $90"'

/**
 * What to tell someone who gave a price but not an order the strict reader can take, such as a
 * purchase sized in what it gets or a sale in dollars. Nothing for a message that names no price,
 * so a plain swap is left alone.
 */
export function limitShapeRefusal(text: string): string | undefined {
  const typed = text.trim()
  const price = PRICE_AT_END.exec(typed)
  if (!SHAPE_VERB.test(typed) || price === null) return undefined
  const buy = BUY_BY_COUNT.exec(typed)
  if (buy !== null) {
    const symbol = chainTokenWord(buy[2] as string).toUpperCase()
    return `Say how much you will spend, for example "buy ${symbol} with 180 USDC at $${price[1] as string}". Nothing was signed or sent.`
  }
  const sell = SELL_BY_DOLLARS.exec(typed)
  if (sell !== null) {
    const symbol = chainTokenWord(sell[1] as string).toUpperCase()
    return `Say how much ${symbol}, for example "sell 0.05 ${symbol} at $110". Nothing was signed or sent.`
  }
  return `I could not read that as a limit order. Say it in full, ${LIMIT_EXAMPLES}. Nothing was signed or sent.`
}

const NUMBER = String.raw`(\d[\d,]*(?:\.\d+)?|\.\d+)(?![\w%]|[.,]\d)`

/**
 * Whether the person themselves said this amount of this token and this price. A model's text never
 * sets what is signed. The amount is a count by its token, the price follows "at", "@" or "hits",
 * and each must be the last said, so a correction wins. This does not go through
 * `sequenceWordsMatch`, which refuses a count with a dollar figure after it, the very shape of a
 * limit order. Pass what the person typed, not the model's lines.
 */
export function limitSaid(request: ChainActionRequest, turns: readonly string[]): boolean {
  if (request.limitPrice === undefined) return false
  const symbol = chainTokenWord(request.tokenIn)
  const joined = spacedTurns(symbol, turns).join(' ')
  const counted = new RegExp(
    String.raw`(?:^|[^\w.,$₦£€])${NUMBER}\s*(?:of\s+)?(?:my\s+|the\s+)?(?:${tokenPattern(symbol).token})${WORD_END}`,
    'gi'
  )
  const priced = new RegExp(String.raw`(?:\b(?:at|hits?|reach(?:es)?)\s+|@\s*)\$?${NUMBER}`, 'gi')
  const amount = [...joined.matchAll(counted)].at(-1)
  const price = [...joined.matchAll(priced)].at(-1)
  if (
    !tokenSaid(request.tokenIn, turns) ||
    amount === undefined ||
    price === undefined ||
    figureValue(amount[1] as string) !== canonicalNumber(request.amount) ||
    figureValue(price[1] as string) !== canonicalNumber(request.limitPrice)
  ) {
    return false
  }
  return sideAndTokenOutSaid(request, joined, amount)
}

/**
 * The side and the token received must be the person's too. Selling names the token received after
 * the amount, except that USDC may go unnamed after "sell", the parser's own default. A purchase
 * names it anywhere. "buy" is never a sale, and "sell" is never a purchase unless it is a swap.
 */
function sideAndTokenOutSaid(
  request: ChainActionRequest,
  joined: string,
  amount: RegExpMatchArray
): boolean {
  const tokenOut = request.tokenOut
  if (tokenOut === undefined) return false
  const pair = limitPair(request.tokenIn, tokenOut)
  if (pair === undefined) return false
  const sell = /\bsell\b/i.test(joined)
  const buy = /\bbuy\b/i.test(joined)
  const swap = /\b(?:swap|convert|exchange|trade|change)\b/i.test(joined)
  if (pair.selling ? buy && !sell : sell && !buy && !swap) return false
  const end = (amount.index ?? 0) + amount[0].length
  const after = joined.slice(end)
  const named = pair.selling
    ? tokenSaid(tokenOut, [after], true)
    : tokenSaid(tokenOut, [joined], true)
  // Selling without naming a stablecoin is for USDC, unless the person named the other one.
  const implied =
    pair.selling &&
    !buy &&
    (sell || !swap) &&
    chainTokenWord(tokenOut).toUpperCase() === 'USDC' &&
    !tokenSaid('USDT', [joined], true)
  return named || implied
}
