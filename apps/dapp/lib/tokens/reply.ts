import { countFigure, priceFigure, usdFigure, type TokenRow } from './types'

/** As many as the token card lists. */
export const TOKEN_LIST_SIZE = 6

export const TOKENS_UNREAD = (chainName: string): string =>
  `Tokens on ${chainName} couldn’t be read just now. Try again in a moment.`

/** What the token list card showed, in words the chat keeps once the card has gone. */
export function tokenListReply(tokens: readonly TokenRow[], chainName: string): string {
  return [
    `Tokens on ${chainName}:`,
    ...tokens
      .slice(0, TOKEN_LIST_SIZE)
      .map((t) => `${t.symbol} ${priceFigure(t.priceUsd)}, ${usdFigure(t.liquidityUsd)} liquidity`),
  ].join('\n')
}

/** What one token's card showed, or that nothing matched. */
export function tokenReply(token: TokenRow | undefined, query: string, chainName: string): string {
  if (token === undefined) return `Nothing on ${chainName} matches “${query}”.`
  return `${token.symbol} on ${chainName}: ${priceFigure(token.priceUsd)}, ${usdFigure(token.marketCapUsd)} market cap, ${usdFigure(token.liquidityUsd)} liquidity, ${countFigure(token.holders)} holders.`
}
