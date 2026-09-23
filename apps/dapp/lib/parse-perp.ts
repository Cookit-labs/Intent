/**
 * Reading a perpetual-futures instruction out of free text.
 *
 * "Long XLM 10x with 50 USDC" is not a swap, and the trade parser reads it as
 * one: a purchase of XLM with USDC, spot, unleveraged. A leveraged position is
 * a different instrument with a liquidation price, so it must be recognised
 * before the trade parser sees the sentence — the same reason `parse-compound`
 * splits a sequence before `parseIntent` runs.
 *
 * Narrow on purpose, like the other direct-flow parsers. A side word alone is
 * not enough — "for the long term" and "a short-term hold" both contain one —
 * so the side must be followed closely by a market the venue actually lists.
 * The market list is passed in from a live read rather than kept here: the
 * venue's markets are its own fact, and a static copy would drift.
 */

export interface PerpIntent {
  kind: 'perp'
  side: 'long' | 'short'
  /** The market symbol, as the venue lists it. */
  asset: string
  /**
   * Leverage as stated, not as allowed. The prepare route refuses anything
   * outside the venue's range; a silent cap here would open a smaller
   * position than the one asked for.
   */
  leverage?: number
  /** Collateral in USDC, display units. Absent when the text names none. */
  collateral?: string
}

/** Names people use for a market that are not its symbol. */
const ASSET_ALIASES: Record<string, string> = {
  lumens: 'XLM',
  lumen: 'XLM',
  bitcoin: 'BTC',
  ether: 'ETH',
  ethereum: 'ETH',
}

/**
 * The side word, then at most four filler tokens, then the market.
 *
 * The filler covers "on", "a", a leverage ("5x"), a collateral figure and its
 * unit, so "open a 5x long on ETH" and "long 100 USDC of XLM" both reach the
 * symbol. Four is enough for every phrasing measured and small enough that
 * "long" cannot pick up a symbol three clauses away.
 */
const SIDE_THEN_ASSET =
  /\b(long|short)\b(?:\s+(?:on|a|an|the|position|in|of|worth|usdc|\d+(?:\.\d+)?x|\$?[\d,.]+)){0,4}\s+([a-z]{2,8})\b/i

const LEVERAGE = /\b(\d{1,3})\s*x\b|\bleverage\s*(?:of\s+)?(\d{1,3})\b/i

/**
 * Collateral: a dollar figure, or a figure followed by a USDC-ish unit. The
 * unit is required on the bare form so the "10" of "10x" is never read as ten
 * dollars of margin.
 */
const COLLATERAL = /\$\s*([\d,]+(?:\.\d+)?)|\b([\d,]+(?:\.\d+)?)\s*(?:usdc|usd|dollars)\b/i

export function parsePerpIntent(raw: string, markets: string[]): PerpIntent | null {
  if (markets.length === 0) return null
  const text = raw.trim()

  const match = SIDE_THEN_ASSET.exec(text)
  if (match === null) return null
  const side = match[1]?.toLowerCase() as 'long' | 'short'
  const word = match[2]?.toLowerCase() ?? ''
  const asset = ASSET_ALIASES[word] ?? word.toUpperCase()
  if (!markets.includes(asset)) return null

  const lev = LEVERAGE.exec(text)
  const leverageRaw = lev?.[1] ?? lev?.[2]
  const leverage = leverageRaw !== undefined ? Number(leverageRaw) : undefined

  const col = COLLATERAL.exec(text)
  const collateralRaw = col?.[1] ?? col?.[2]
  const collateral = collateralRaw?.replace(/,/g, '')

  return {
    kind: 'perp',
    side,
    asset,
    ...(leverage !== undefined ? { leverage } : {}),
    ...(collateral !== undefined ? { collateral } : {}),
  }
}
