/**
 * Which fiat a typed instruction wants to be paid out in.
 *
 * Deterministic on purpose. Currency words are a closed list, and a model
 * misreading "euros" as something payable would send a person to a naira form
 * they never asked for. Naira is the only currency this app can pay out.
 */

export const SUPPORTED_PAYOUT_CURRENCIES = [{ code: 'NGN', name: 'Nigerian naira' }] as const

export type PayoutRead =
  | { kind: 'ngn' }
  | { kind: 'unsupported'; currency: string }
  | { kind: 'none' }

/** Words that say the user wants money in a bank, as opposed to a token swap. */
const CASH_OUT_CUE = /\b(cash\s*out|cashout|withdraw\w*|off-?ramp\w*|pay\s*out|payout|bank|fiat)\b/

const NAIRA_WORD = /(?:naira|\bngn\b|₦)/
const NAIRA_TARGET = new RegExp(`\\b(?:to|in|into|as)\\s+(?:my\\s+|the\\s+)?${NAIRA_WORD.source}`)

/**
 * Currencies that are never a token here, so naming one as a target is
 * unmistakably a request for fiat.
 */
const OTHER_CURRENCIES: readonly { name: string; word: string }[] = [
  { name: 'Euros', word: 'euros?|eur' },
  { name: 'British pounds', word: 'pounds?|gbp|sterling' },
  { name: 'Ghanaian cedis', word: 'cedis?|ghs' },
  { name: 'South African rand', word: 'rand|zar' },
  { name: 'Kenyan shillings', word: 'shillings?|kes|ugx|tzs' },
  { name: 'Japanese yen', word: 'yen|jpy' },
  { name: 'Chinese yuan', word: 'yuan|rmb|cny' },
  { name: 'Indian rupees', word: 'rupees?|inr' },
  { name: 'Canadian dollars', word: 'cad|canadian\\s+dollars?' },
  { name: 'Australian dollars', word: 'aud|australian\\s+dollars?' },
  { name: 'CFA francs', word: 'francs?|xof|xaf|chf' },
  { name: 'Pesos', word: 'pesos?' },
]

function targetOf(word: string): RegExp {
  return new RegExp(`\\b(?:to|in|into|as)\\s+(?:my\\s+|the\\s+)?(?:${word})\\b`)
}

/**
 * Dollars are the one fiat that is also what a stablecoin is called, so they
 * only count with a cash-out cue: "swap XLM to USD" is a trade, "withdraw to
 * dollars in my bank" is a payout. `\busd\b` does not match USDC.
 */
const DOLLAR_TARGET = targetOf('(?:us\\s+|american\\s+)?dollars?|usd')

export function detectPayout(text: string): PayoutRead {
  const lower = text.toLowerCase()
  const cue = CASH_OUT_CUE.test(lower)

  if (NAIRA_TARGET.test(lower)) return { kind: 'ngn' }

  for (const { name, word } of OTHER_CURRENCIES) {
    if (targetOf(word).test(lower)) return { kind: 'unsupported', currency: name }
  }
  if (cue && DOLLAR_TARGET.test(lower)) return { kind: 'unsupported', currency: 'US dollars' }

  if (cue && (NAIRA_WORD.test(lower) || /\bnigerian\b/.test(lower))) return { kind: 'ngn' }
  return { kind: 'none' }
}

/** The error shown for a currency that cannot be paid out, with what can. */
export function unsupportedCurrencyMessage(currency: string): string {
  const supported = SUPPORTED_PAYOUT_CURRENCIES.map((c) => `${c.name} (${c.code})`).join(', ')
  return `Payouts to ${currency} are not supported. Supported currency: ${supported}.`
}

export type PayoutSource = { kind: 'xlm'; amountXlm?: number } | { kind: 'other'; asset: string }

/**
 * What the user is cashing out, and how much of it when they said.
 *
 * Only XLM can be paid out to naira. A dollar figure is turned into XLM at the
 * live price the caller passes; without a price it is left unsized and the form
 * asks. Any other named asset is refused with its name, not silently treated
 * as XLM.
 */
export function readPayoutSource(text: string, xlmPriceUsd: number | undefined): PayoutSource {
  const lower = text.toLowerCase()

  const other = /\b(usdc|cetes|wbtc|weth|eurc|aqua|yxlm)\b/.exec(lower)
  if (other !== null && !/\bxlm\b/.test(lower)) {
    return { kind: 'other', asset: (other[1] ?? '').toUpperCase() }
  }

  const units = /(\d+(?:\.\d+)?)\s*xlm\b/.exec(lower)
  if (units !== null) return { kind: 'xlm', amountXlm: Number(units[1]) }

  const usd = /\$\s*(\d+(?:\.\d+)?)/.exec(lower)
  if (usd !== null && xlmPriceUsd !== undefined && xlmPriceUsd > 0) {
    return { kind: 'xlm', amountXlm: Math.round((Number(usd[1]) / xlmPriceUsd) * 1e7) / 1e7 }
  }
  return { kind: 'xlm' }
}

export type PayoutPath = 'xlm' | 'usdc'

/**
 * Which route the form opens on, from how the instruction was worded.
 *
 * "Cash out" and "withdraw" ask for the money to leave, so the direct XLM
 * payment is preselected. "Swap", "convert" and "offramp" open on the two-step
 * route, so the agents get to compete on a swap into USDC first. It is a starting
 * point only: the form says which route it is on and the user can change it.
 */
export function preselectPayoutPath(text: string): PayoutPath {
  const lower = text.toLowerCase()
  // Asking for the money to "cash out" or be "withdrawn" is the direct route.
  if (/\b(cash\s*out|cashout|withdraw\w*)\b/.test(lower)) return 'xlm'
  // "Swap", "convert" and "offramp" all open on the two-step route, as asked.
  if (/\b(swap|convert|exchange|trade|off-?ramp\w*)\b/.test(lower)) return 'usdc'
  return 'xlm'
}
