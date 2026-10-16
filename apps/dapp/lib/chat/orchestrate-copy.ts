import type { StellarBalances } from '../stellar-account'

/**
 * What the chat says when the orchestrator decides a message is not an
 * instruction.
 *
 * Fixed text, never the model's own words: a model asked "what can I do here?"
 * will happily list things this app cannot do, and an app that promises a
 * feature it lacks is worse than one that stays quiet.
 */

const EXAMPLE = '"swap $5 of XLM to USDC"'

/** What Intent can do on a chain, one bullet each. */
function capabilityBullets(chain: string): string[] {
  const common = [
    '• Swap one asset for another, at the market or at a price you set',
    '• Accumulate an asset over time, or hedge into another',
    '• Send an asset to someone',
  ]
  const stellar = [
    '• Supply to a lending pool, or ask about borrowing against it',
    '• Cash out USDC or XLM to a Nigerian bank, paid in naira',
    '• Open a leveraged long or short position',
  ]
  return chain === 'stellar' ? [...common, ...stellar] : common
}

export function helpMessage(chain: string): string {
  return [
    'Tell Intent what you want done and trading agents compete to do it best. You can:',
    ...capabilityBullets(chain),
    `Try ${EXAMPLE}.`,
  ].join(String.fromCharCode(10))
}

/**
 * A message that has nothing to do with Intent.
 *
 * Deliberately not conversational. A boundary that is the same every time is
 * clear, cannot be talked around, and never wanders into advice on a subject
 * this app has no business with. What it can do follows automatically, so the
 * person is not left at a dead end.
 *
 * `note` is the model's few words of acknowledgement, which it is asked to give
 * only when someone sounds genuinely distressed.
 */
export function outOfScopeMessage(chain: string, note?: string): string {
  const lead = note !== undefined && note.trim() !== '' ? [note.trim(), ''] : []
  return [
    ...lead,
    "That's outside what Intent does. Here's what it can do:",
    ...capabilityBullets(chain),
    `Try ${EXAMPLE}.`,
  ].join(String.fromCharCode(10))
}

export function unclearMessage(): string {
  return `I couldn't pin that down. Try rephrasing it as one thing you want done, for example ${EXAMPLE}.`
}

export function unavailableMessage(reason: string, tokens: string[]): string {
  if (reason === 'unknown_token') {
    const names = tokens.join(', ')
    return `I can't confirm ${names} as a verified token on Stellar, so I won't trade it. Which token do you mean? You can name it another way, or paste its issuer account if you know it.`
  }
  if (reason === 'not_tradeable') {
    return 'That asset can be borrowed here but not traded. Pick a different asset to trade.'
  }
  return "I can't read that right now. Please try again in a moment."
}

function figure(raw: string): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  return n.toLocaleString('en-US', { maximumFractionDigits: 7 })
}

/**
 * What the wallet holds, one asset a line, the native asset first.
 *
 * Built from the balances the page has already read rather than asked of the
 * model, which has no way to know them and would invent figures.
 */
export function balanceMessage(balances: StellarBalances | undefined): string {
  if (balances === undefined) {
    return "I can't read your balance yet. Connect your wallet if you haven't, then ask again in a moment."
  }
  if (!balances.exists) {
    return 'This wallet is not funded yet, so it holds nothing. Send it some XLM to activate it.'
  }
  const issued = Object.entries(balances.trustlines).sort(([a], [b]) => a.localeCompare(b))
  return [
    'Your wallet holds:',
    `• ${figure(balances.xlm)} XLM`,
    ...issued.map(([code, held]) => `• ${figure(held.balance)} ${code}`),
  ].join(String.fromCharCode(10))
}
