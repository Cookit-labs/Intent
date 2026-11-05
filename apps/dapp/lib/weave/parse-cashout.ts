import { chainTokenWord } from '../chains/parse-action'
import { SEQUENCE_CASHOUT_CHAINS } from '../chains/sequence'
import { isCashoutChain } from './types'

export type CashoutCurrencyCode = 'NGN' | 'KES' | 'UGX' | 'TZS'

export interface CashoutRequest {
  amount?: string
  token: 'USDC'
  currency?: CashoutCurrencyCode
}

export type CashoutRead =
  | CashoutRequest
  | { unsupportedToken: string; amount?: string; dollars?: string; currency?: CashoutCurrencyCode }
  | { unsupportedCurrency: string }

export type CashoutRoute =
  | { kind: 'pass' }
  | { kind: 'open'; amount?: string; currency?: CashoutCurrencyCode }
  /** No currency was named, and a person's country is not something to assume. */
  | { kind: 'ask'; amount?: string }
  | { kind: 'token'; token: string }
  /** A swap to USDC then a cash-out, on a chain that can finish it. */
  | {
      kind: 'sequence'
      token: string
      amount: string
      /** `amount` is dollars of the token, to be sized at a live price before anything runs. */
      amountIsUsd?: true
      currency?: CashoutCurrencyCode
    }
  | { kind: 'currency'; currency: string }

const CURRENCY_WORDS: Record<string, CashoutCurrencyCode> = {
  ngn: 'NGN',
  naira: 'NGN',
  nigeria: 'NGN',
  'nigerian naira': 'NGN',
  '₦': 'NGN',
  kes: 'KES',
  kenya: 'KES',
  'kenyan shilling': 'KES',
  'kenyan shillings': 'KES',
  ugx: 'UGX',
  uganda: 'UGX',
  'ugandan shilling': 'UGX',
  'ugandan shillings': 'UGX',
  tzs: 'TZS',
  tanzania: 'TZS',
  'tanzanian shilling': 'TZS',
  'tanzanian shillings': 'TZS',
}

const OTHER_FIAT: Record<string, string> = {
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  'us dollars': 'USD',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  gbp: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
  ghs: 'GHS',
  ghana: 'GHS',
  cedi: 'GHS',
  cedis: 'GHS',
  zar: 'ZAR',
  rand: 'ZAR',
  'south africa': 'ZAR',
  brl: 'BRL',
  brazil: 'BRL',
  real: 'BRL',
  reais: 'BRL',
  inr: 'INR',
  india: 'INR',
  rupee: 'INR',
  rupees: 'INR',
  cad: 'CAD',
  aud: 'AUD',
  jpy: 'JPY',
  yen: 'JPY',
  cny: 'CNY',
  yuan: 'CNY',
  rmb: 'CNY',
  xof: 'XOF',
  xaf: 'XAF',
  chf: 'CHF',
  mxn: 'MXN',
  peso: 'MXN',
  pesos: 'MXN',
  egp: 'EGP',
  egypt: 'EGP',
  rwf: 'RWF',
  rwanda: 'RWF',
  zmw: 'ZMW',
  zambia: 'ZMW',
  etb: 'ETB',
  ethiopia: 'ETB',
}

/** Where the money goes, but not in what: these leave the currency still to be asked. */
const NO_CURRENCY_TARGETS = new Set(['bank', 'bank account', 'account', 'fiat', 'local currency'])

/** Words that only answer "which currency?": alone in a request they would mean too little. */
const ANSWER_WORDS: Record<string, CashoutCurrencyCode> = {
  nigerian: 'NGN',
  kenyan: 'KES',
  ksh: 'KES',
  ugandan: 'UGX',
  tanzanian: 'TZS',
}

/** Named without an amount, only these read as a token: "cash out now" must not. */
const KNOWN_TOKENS = new Set([
  'sol',
  'xlm',
  'near',
  'sui',
  'avax',
  'eth',
  'weth',
  'btc',
  'wbtc',
  'usdt',
  'dai',
  'eurc',
  'mon',
  'bnb',
])

const VERB = /^(?:please )?(cash[ -]?out|off[ -]?ramp|withdraw|sell)(?: |(?=[\d$.])|$)(.*)$/
/** "4 USD" here means four dollars of USDC, the same as "$4". */
const DOLLAR_WORDS = new Set(['usd', 'dollar', 'dollars'])
const TARGET = /^(.*?) ?(?:(?:^| )(?:to|for|in|into) (?:my |the )?(.+))?$/
const SOURCE = /^(?:my )?(\$)?(\d[\d,]*(?:\.\d+)?|\.\d+)? ?([a-z][a-z0-9.+]{0,11})?$/
const AMOUNT = /^(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)$/

function hasOwn(table: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key)
}

/** Whether this word or phrase names a currency, paid here or not. Lower case, single spaces. */
export function isFiatWord(word: string): boolean {
  return hasOwn(CURRENCY_WORDS, word) || hasOwn(OTHER_FIAT, word)
}

/**
 * The one currency the person's own words name, or nothing if they name none or more than one, so
 * that the question is asked instead. Only words that mean a currency alone count: "my nigerian
 * friend" says nothing about a payout.
 */
export function currencyNamedIn(turns: readonly string[]): CashoutCurrencyCode | undefined {
  const text = turns.join(' ').toLowerCase().replace(/\s+/g, ' ')
  const found = new Set<CashoutCurrencyCode>()
  for (const [word, code] of Object.entries(CURRENCY_WORDS)) {
    if (new RegExp(String.raw`(?<![a-z0-9])${word}(?![a-z0-9])`).test(text)) found.add(code)
  }
  return found.size === 1 ? [...found][0] : undefined
}

/** Plain decimal text, or nothing for a shape that is not an amount or is zero. */
function readAmount(text: string): string | undefined {
  if (!AMOUNT.test(text) || !/[1-9]/.test(text)) return undefined
  const plain = text.replace(/,/g, '')
  return plain.startsWith('.') ? `0${plain}` : plain
}

/**
 * Reads a plain request to cash out, or nothing.
 *
 * A strict shape, not a guess: money moves on what this returns, so anything
 * looser falls through to whatever reads the message next. "Withdraw" and "sell"
 * also mean other things, so they count only with a fiat destination.
 */
export function parseCashout(text: string): CashoutRead | null {
  const clean = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ ?[.!]+$/, '')
  const verb = VERB.exec(clean)
  if (verb === null) return null

  const parts = TARGET.exec(verb[2] ?? '')
  if (parts === null) return null
  const source = parts[1] ?? ''
  const target = parts[2]

  const needsTarget = verb[1] === 'withdraw' || verb[1] === 'sell'
  if (needsTarget && target === undefined) return null

  const namesNoCurrency = target !== undefined && NO_CURRENCY_TARGETS.has(target)

  let currency: CashoutCurrencyCode | undefined
  if (target !== undefined && !namesNoCurrency) {
    if (hasOwn(CURRENCY_WORDS, target)) currency = CURRENCY_WORDS[target]
    else if (!hasOwn(OTHER_FIAT, target)) return null
  }

  const shape = SOURCE.exec(source)
  if (shape === null) return null
  const dollar = shape[1] !== undefined
  const rawAmount = shape[2]
  const token = shape[3]

  let amount: string | undefined
  if (rawAmount !== undefined) {
    amount = readAmount(rawAmount)
    if (amount === undefined) return null
  } else if (dollar) {
    return null
  }

  const withCurrency = currency !== undefined ? { currency } : {}
  const dollarAmount = amount !== undefined && token !== undefined && DOLLAR_WORDS.has(token)

  if (token !== undefined && token !== 'usdc' && !dollarAmount) {
    if (isFiatWord(token)) return null
    if (amount === undefined && !KNOWN_TOKENS.has(token)) return null
    // A fiat we don't pay is said, not dropped: the token case would lose it.
    if (target !== undefined && currency === undefined && !namesNoCurrency) {
      return { unsupportedCurrency: OTHER_FIAT[target] as string }
    }
    // A dollar figure is not an amount of this token.
    const ofToken = amount === undefined ? {} : dollar ? { dollars: amount } : { amount }
    return { unsupportedToken: token.toUpperCase(), ...ofToken, ...withCurrency }
  }
  if (token === undefined && amount !== undefined && !dollar) return null

  if (target !== undefined && currency === undefined && !namesNoCurrency) {
    return { unsupportedCurrency: OTHER_FIAT[target] as string }
  }
  return { ...(amount !== undefined ? { amount } : {}), token: 'USDC', ...withCurrency }
}

/**
 * Reads the answer to "which currency?", or nothing for a message that isn't one,
 * so that anything else a person types next is still read as what it is.
 */
export function parseCurrencyAnswer(
  text: string
): { currency: CashoutCurrencyCode } | { unsupported: string } | null {
  const word = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ ?[.!]+$/, '')
    .replace(/ please$/, '')
    .replace(/^(?:please )?(?:(?:to|in|into|for) )?(?:my |the )?/, '')
  if (hasOwn(CURRENCY_WORDS, word)) return { currency: CURRENCY_WORDS[word] as CashoutCurrencyCode }
  if (hasOwn(ANSWER_WORDS, word)) return { currency: ANSWER_WORDS[word] as CashoutCurrencyCode }
  if (hasOwn(OTHER_FIAT, word)) return { unsupported: OTHER_FIAT[word] as string }
  return null
}

/**
 * What the chat does with a read, by chain.
 *
 * A request naming no currency is asked about on every chain. Stellar pays naira
 * through its own path, so naira and what only that path can read go on as if this
 * had not looked. Stellar testnet has no real cash-out, only its test anchor, so
 * there is nothing to ask about.
 */
export function routeCashout(
  read: CashoutRead | null,
  chain: string,
  stellarMainnet = true
): CashoutRoute {
  if (read === null || !isCashoutChain(chain)) return { kind: 'pass' }

  const weaveOnly = (currency: CashoutCurrencyCode | undefined): boolean =>
    currency !== undefined && currency !== 'NGN'

  if ('unsupportedCurrency' in read) {
    return chain === 'stellar'
      ? { kind: 'pass' }
      : { kind: 'currency', currency: read.unsupportedCurrency }
  }
  if ('unsupportedToken' in read) {
    if (chain === 'stellar' && !weaveOnly(read.currency)) return { kind: 'pass' }
    const figure = read.amount ?? read.dollars
    // A leading zero may be a decimal comma, "0,500" read as 0500, and a swap would take it as 500.
    if (
      figure !== undefined &&
      !/^0\d/.test(figure) &&
      (SEQUENCE_CASHOUT_CHAINS as readonly string[]).includes(chain)
    ) {
      return {
        kind: 'sequence',
        token: chainTokenWord(read.unsupportedToken),
        amount: figure,
        ...(read.dollars !== undefined ? { amountIsUsd: true as const } : {}),
        ...(read.currency !== undefined ? { currency: read.currency } : {}),
      }
    }
    return { kind: 'token', token: read.unsupportedToken }
  }
  // Off Stellar a leading zero may be a decimal comma, "0,500" read as 0500: the form opens
  // with no seed and the person types the amount.
  const seed =
    read.amount !== undefined && (chain === 'stellar' || !/^0\d/.test(read.amount))
      ? { amount: read.amount }
      : {}
  if (read.currency === undefined) {
    if (chain === 'stellar' && !stellarMainnet) return { kind: 'pass' }
    return { kind: 'ask', ...seed }
  }
  if (chain === 'stellar' && !weaveOnly(read.currency)) return { kind: 'pass' }
  return {
    kind: 'open',
    ...seed,
    ...(read.currency !== undefined ? { currency: read.currency } : {}),
  }
}
