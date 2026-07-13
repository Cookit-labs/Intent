import type { CreateIntentInput, IntentType } from '@intent/types'

export interface ParsedIntent {
  outcome: string
  input: CreateIntentInput
  escrowUsd: number
  referencePriceUsd: number
  targetPriceUsd: number
}

const TOKEN_ALIASES: Record<string, string> = {
  eth: 'WETH',
  weth: 'WETH',
  btc: 'WBTC',
  wbtc: 'WBTC',
  arb: 'ARB',
  usdc: 'USDC',
  usdt: 'USDT',
}

const PRICE_USD: Record<string, number> = {
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

function detectToken(text: string, fallback: string): string {
  const t = text.toLowerCase()
  for (const [alias, symbol] of Object.entries(TOKEN_ALIASES)) {
    if (symbol !== 'USDC' && symbol !== 'USDT' && new RegExp(`\\b${alias}\\b`).test(t)) {
      return symbol
    }
  }
  return fallback
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
export function parseIntent(raw: string): ParsedIntent {
  const outcome = raw.trim()
  const type = detectType(outcome)
  const tokenOut = detectToken(outcome, 'WETH')
  const tokenIn = tokenOut === 'USDC' ? 'USDT' : 'USDC'
  const referencePriceUsd = PRICE_USD[tokenOut] ?? 3500

  const num = firstNumber(outcome) ?? 1
  // If the number reads like a token quantity (small), value it; otherwise treat as USD.
  const escrowUsd =
    num > 0 && num < 1000 ? Math.round(num * referencePriceUsd) : Math.round(num || 5000)
  const amountIn = String(escrowUsd)
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
