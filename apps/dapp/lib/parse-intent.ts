import type { CreateIntentInput, IntentType } from '@intent/types'

export interface ParsedIntent {
  outcome: string
  input: CreateIntentInput
  escrowUsd: number
  referencePriceUsd: number
  targetPriceUsd: number
}

const TOKEN_ALIASES: Record<string, string> = {
  xlm: 'XLM',
  lumens: 'XLM',
  eth: 'WETH',
  weth: 'WETH',
  btc: 'WBTC',
  wbtc: 'WBTC',
  arb: 'ARB',
  usdc: 'USDC',
  usdt: 'USDT',
}

/**
 * Reference spot prices. Exported because the agent layer must inject these
 * into prompts rather than let a model recall its own — two copies would drift
 * and the projected fills would stop matching the parsed intent.
 */
export const REFERENCE_PRICES_USD: Record<string, number> = {
  // Indicative only. Anything executable is priced against live liquidity in
  // `quoteRoutes`; this table exists so the model has a scale to reason at.
  XLM: 0.58,
  USDC: 1,
  USDT: 1,
  WETH: 3500,
  ARB: 1.25,
  WBTC: 95000,
}

function detectType(text: string): IntentType {
  const t = text.toLowerCase()
  if (t.includes('hedge')) return 'hedge'
  if (t.includes('rebalance')) return 'rebalance'
  if (t.includes('route') || t.includes('liquidity')) return 'route_liquidity'
  if (t.includes('accumulate') || t.includes('dca')) return 'accumulate'
  const limit =
    t.includes('limit') || t.includes('below') || t.includes('above') || t.includes('at $')
  if (t.includes('sell')) return limit ? 'limit_sell' : 'market_sell'
  return limit ? 'limit_buy' : 'market_buy'
}

/**
 * Reads an explicit "swap A to B" pair out of the text.
 *
 * Returns undefined when the intent is not phrased as a directional swap, so
 * the older buy-shaped heuristics still handle "accumulate" and "hedge".
 */
function detectSwapPair(text: string): { from: string; to: string } | undefined {
  const t = text.toLowerCase()
  if (!/\bswap\b|\bconvert\b|\btrade\b|\bsell\b/.test(t)) return undefined

  // Scan for known symbols in the order they appear, rather than pattern
  // matching around a connector word: "worth of" and "for" both look like
  // connectors and picking the wrong one reverses the trade.
  const found: { symbol: string; at: number }[] = []
  for (const [alias, symbol] of Object.entries(TOKEN_ALIASES)) {
    const m = new RegExp(`\\b${alias}\\b`).exec(t)
    if (m !== null) found.push({ symbol, at: m.index })
  }

  // Deduplicate by symbol, keeping the earliest mention of each.
  const bySymbol = new Map<string, number>()
  for (const f of found) {
    const existing = bySymbol.get(f.symbol)
    if (existing === undefined || f.at < existing) bySymbol.set(f.symbol, f.at)
  }

  const ordered = [...bySymbol.entries()].sort((a, b) => a[1] - b[1]).map(([sym]) => sym)

  // "Sell 100 XLM at $0.25" names only one asset, but the direction is not
  // ambiguous: selling X means X leaves and a stablecoin arrives. Without this
  // the buy-shaped fallback below reads it backwards as USDC -> XLM.
  if (ordered.length === 1 && /\bsell\b/.test(t)) {
    const only = ordered[0]
    if (only !== undefined && only !== 'USDC') return { from: only, to: 'USDC' }
    return undefined
  }

  if (ordered.length < 2) return undefined

  // First mentioned is what leaves the account, second is what arrives.
  const [from, to] = ordered
  if (from === undefined || to === undefined || from === to) return undefined
  return { from, to }
}

function detectToken(text: string, fallback: string): string {
  const t = text.toLowerCase()
  for (const [alias, symbol] of Object.entries(TOKEN_ALIASES)) {
    if (symbol !== 'USDC' && symbol !== 'USDT' && new RegExp(`\\b${alias}\\b`).test(t)) {
      return symbol
    }
  }
  return fallback
}

/**
 * The quantity attached to a specific token, e.g. the 100 in "sell 100 XLM".
 *
 * Anchoring to the symbol matters for limit orders: "sell 100 XLM at $0.25"
 * contains two numbers, and taking the first one found is a coin toss between
 * the size and the price. Returns undefined when no number sits next to the
 * token, so the caller can fall back rather than guess.
 */
function amountForToken(text: string, symbol: string): number | undefined {
  const aliases = Object.entries(TOKEN_ALIASES)
    .filter(([, sym]) => sym === symbol)
    .map(([alias]) => alias)
  if (aliases.length === 0) return undefined

  const t = text.toLowerCase().replace(/,/g, '')
  for (const alias of aliases) {
    // "100 xlm" and "xlm 100" both occur in natural phrasing.
    const before = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:worth\\s+of\\s+)?${alias}\\b`).exec(t)
    if (before?.[1] !== undefined) return Number(before[1])
    const after = new RegExp(`${alias}\\b\\s*(\\d+(?:\\.\\d+)?)`).exec(t)
    if (after?.[1] !== undefined) return Number(after[1])
  }
  return undefined
}

// First plain number in the text (e.g. "2.0 ETH", "15,000 USDC").
function firstNumber(text: string): number | null {
  const match = text.replace(/,/g, '').match(/\d+(\.\d+)?/)
  return match ? Number(match[0]) : null
}

function scaleAmount(raw: string, suffix: string | undefined): number {
  let n = Number(raw.replace(/,/g, ''))
  const s = suffix?.toLowerCase()
  if (s === 'k') n *= 1_000
  if (s === 'm') n *= 1_000_000
  return n
}

// A price target if the text names one (e.g. "below $3,200", "at $30k").
function targetPrice(text: string): number | null {
  const dollar = text.match(/\$\s?([\d,]+(?:\.\d+)?)\s?([km])?/i)
  if (dollar) return scaleAmount(dollar[1]!, dollar[2])
  const worded = text.match(/(?:below|above|at|under|over)\s+\$?\s?([\d,]+(?:\.\d+)?)\s?([km])?/i)
  if (worded) return scaleAmount(worded[1]!, worded[2])
  return null
}

/**
 * Best-effort interpretation of a free-text outcome into a structured intent.
 * This is the mock stand-in for the backend's intent parser; it never fails,
 * always producing a valid CreateIntentInput so the competition can run.
 */
export function parseIntent(
  raw: string,
  /**
   * Live prices, when the caller has them.
   *
   * The built-in table is indicative and drifts: it valued XLM at $0.58 while
   * the market was near $0.19, so "$30 of XLM" resolved to 51.7 XLM instead of
   * 158.5 — a third of what the user asked to spend. Callers that can fetch
   * real prices pass them here; the table is the fallback for those that
   * cannot, since this function is synchronous by design.
   */
  livePrices?: Record<string, number>
): ParsedIntent {
  const outcome = raw.trim()
  const type = detectType(outcome)

  // A swap states both sides and a direction, which the buy-shaped path below
  // cannot express: it assumes the user always spends a stablecoin on
  // something volatile. "Swap $30 of XLM to USDC" is the opposite of that, and
  // reading it that way produced the wrong pair, the wrong direction, and an
  // amount out by three orders of magnitude.
  const swap = detectSwapPair(outcome)
  const tokenOut = swap?.to ?? detectToken(outcome, 'WETH')
  const tokenIn = swap?.from ?? (tokenOut === 'USDC' ? 'USDT' : 'USDC')
  const priceOf = (symbol: string): number | undefined =>
    livePrices?.[symbol] ?? REFERENCE_PRICES_USD[symbol]
  const referencePriceUsd = priceOf(tokenOut) ?? 3500

  // Prefer the quantity written next to the input token. A limit order names
  // two numbers — "sell 100 XLM at $0.25" — and taking the first one found is
  // a coin toss between the size and the price.
  const tokenQty = amountForToken(outcome, tokenIn)
  // The dollar amount, when the size is stated as a budget rather than a
  // quantity. Read separately so "$30 worth of XLM" does not reuse the 30 as a
  // token count.
  const dollarAmount = (() => {
    const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(outcome)
    return m?.[1] !== undefined ? Number(m[1].replace(/,/g, '')) : undefined
  })()

  // "$30 of X" is a USD figure; "30 X" is a quantity of X.
  //
  // A dollar sign directly on the size wins, since "$30 worth of XLM" states a
  // budget. But a limit order also carries a dollar sign — on the *price*, as
  // in "sell 100 XLM at $0.25" — so the marker only counts when it precedes
  // the token rather than trailing a limit clause.
  // Requires an actual token name after the figure, not merely a letter:
  // "$0.25 or better" would otherwise read as a budget because "or" starts
  // with one, turning a limit price into an order size.
  const symbols = Object.keys(TOKEN_ALIASES).join('|')
  const budgetForm = new RegExp(
    `\\$\\s*[\\d,.]+\\s*(?:worth\\s+)?(?:of\\s+)?(?:${symbols})\\b`,
    'i'
  ).test(outcome)
  const pricedInUsd = budgetForm || (tokenQty === undefined && /\$\s*[\d,]/.test(outcome))

  // A budget is measured in dollars; anything else is a quantity of the token.
  const num = pricedInUsd
    ? (dollarAmount ?? firstNumber(outcome) ?? 1)
    : (tokenQty ?? firstNumber(outcome) ?? 1)
  const sendPrice = priceOf(tokenIn) ?? 1
  const escrowUsd =
    swap !== undefined
      ? pricedInUsd
        ? Math.round(num)
        : Math.round(num * sendPrice)
      : num > 0 && num < 1000
        ? Math.round(num * referencePriceUsd)
        : Math.round(num || 5000)

  // For a swap this is the quantity of the *input* token, which is what an
  // execution actually sends.
  const amountIn =
    swap !== undefined && sendPrice > 0
      ? (pricedInUsd ? num / sendPrice : num).toFixed(7).replace(/0+$/, '').replace(/\.$/, '')
      : String(escrowUsd)
  const minAmountOut = (escrowUsd / referencePriceUsd).toFixed(4)

  return {
    outcome,
    escrowUsd,
    referencePriceUsd,
    targetPriceUsd: targetPrice(outcome) ?? referencePriceUsd,
    input: {
      type,
      tokenIn,
      tokenOut,
      amountIn,
      minAmountOut,
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    },
  }
}
