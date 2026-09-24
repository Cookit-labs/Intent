import { recipientKind } from './names/kind'

/**
 * An instruction to pay somebody, with no trade first.
 *
 * "Send 50 USDC to deon.xlm" is not a trade, and the trade parser reads it as
 * one — a buy of USDC, spending something the user never offered. Read here
 * before every other parser, in the same position `parseSupplyOnlyIntent`
 * holds, because each of those assumes an intent is a trade.
 *
 * Narrow on purpose, like the other single-action readers. A payment verb, an
 * amount of an asset the app trades, and a recipient in one of the three forms
 * the resolver reads. "Send it to my friend" names nobody the app can pay and
 * is left alone; "send the dollars to my bank" names a bank, not a recipient,
 * and belongs to the offramp reader.
 */

export interface SendIntent {
  kind: 'send-only'
  /** Display units, or dollars when `amountIsUsd`. */
  amount: string
  /** True when `amount` is dollars rather than units of the asset. */
  amountIsUsd: boolean
  /** Ticker. */
  asset: string
  /** As typed: an address, a `.xlm` name or `name*domain`. */
  recipient: string
  /** Free text after "memo", when any. */
  memo?: string
}

/** A trade verb means the compound parser owns the sentence. */
const TRADE_VERB = /\b(?:swap|buy|purchase|sell|convert|trade|exchange)\b/i

/**
 * Verb, amount, asset, recipient, optional memo.
 *
 * The amount comes in two shapes, listed dollar-first because a leading word
 * boundary cannot match before "$" — the same lesson `parse-compound.ts`
 * learned. The recipient is one token; trailing punctuation is shed so a
 * sentence ending in a full stop does not turn "deon.xlm" into "deon.xlm.".
 */
const SEND =
  /^\s*(?:please\s+)?(?:send|pay|transfer)\s+(?:\$\s*([\d,]+(?:\.\d+)?)\s*(?:worth\s+)?(?:of\s+)?([A-Za-z]{2,12})|([\d,]+(?:\.\d+)?)\s*([A-Za-z]{2,12}))\s+to\s+(\S+?)[.,;!]?(?:\s+(?:with\s+)?memo:?\s+(.+?))?\s*$/i

export function parseSendIntent(raw: string, symbols: string[]): SendIntent | null {
  const text = raw.trim()
  if (TRADE_VERB.test(text)) return null

  const match = SEND.exec(text)
  if (match === null) return null

  const usdAmount = match[1]
  const rawAmount = usdAmount ?? match[3]
  const rawAsset = match[2] ?? match[4]
  const recipient = match[5]
  if (rawAmount === undefined || rawAsset === undefined || recipient === undefined) return null

  // Checked against what the app can actually trade, so a typo becomes a
  // refusal rather than a payment in an asset that does not exist.
  const asset = rawAsset.toUpperCase()
  if (!symbols.includes(asset)) return null

  // Only a form the resolver reads. Anything else — "my friend", "my bank" —
  // is not a recipient, and the sentence is somebody else's to read.
  if (recipientKind(recipient) === undefined) return null

  const memo = match[6]?.trim()

  return {
    kind: 'send-only',
    amount: rawAmount.replace(/,/g, ''),
    amountIsUsd: usdAmount !== undefined,
    asset,
    recipient,
    ...(memo !== undefined && memo !== '' ? { memo } : {}),
  }
}
