/**
 * What the chat says when the orchestrator decides a message is not an
 * instruction.
 *
 * Fixed text, never the model's own words: a model asked "what can I do here?"
 * will happily list things this app cannot do, and an app that promises a
 * feature it lacks is worse than one that stays quiet.
 */

const EXAMPLE = '"swap $5 of XLM to USDC"'

export function helpMessage(chain: string): string {
  const common = [
    'Tell Intent what you want done and trading agents compete to do it best. You can:',
    '• Swap one asset for another, at the market or at a price you set',
    '• Accumulate an asset over time, or hedge into another',
    '• Send an asset to someone',
  ]
  const stellar = [
    '• Supply to a lending pool, or ask about borrowing against it',
    '• Cash out USDC or XLM to a Nigerian bank, paid in naira',
    '• Open a leveraged long or short position',
  ]
  const close = `Try ${EXAMPLE}.`
  return [...common, ...(chain === 'stellar' ? stellar : []), close].join('\n')
}

export function outOfScopeMessage(): string {
  return `That is outside what Intent does. Intent moves and grows money on-chain: swaps, sends, lending and cashing out. Ask what you can do here to see the list, or try ${EXAMPLE}.`
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
