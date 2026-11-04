import type { ChainToken } from '../types'

/**
 * Every token this chain's venues may touch. A symbol resolves here or nowhere.
 *
 * Mints and decimals checked on 3 November 2026, each against its issuer's own
 * page and against the mint account on chain:
 * - USDC: https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - USDT: https://tether.to/en/supported-protocols
 * - JitoSOL: https://go.jito.network/docs/jitosol/jitosol-liquid-staking/for-developers/staking-integration/
 * - ONyc: https://docs.onre.finance/technical-resources/token-configuration-and-reference
 * - SOL: the wrapped SOL mint, the Token Program's native mint.
 */
export const SOLANA_TOKENS: readonly ChainToken[] = [
  {
    symbol: 'SOL',
    id: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    name: 'Solana',
  },
  {
    symbol: 'USDC',
    id: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    name: 'USD Coin',
  },
  {
    symbol: 'USDT',
    id: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
    name: 'Tether USD',
  },
  {
    symbol: 'JitoSOL',
    id: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    decimals: 9,
    name: 'Jito Staked SOL',
  },
  {
    symbol: 'ONyc',
    id: '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5',
    decimals: 9,
    name: 'OnRe Tokenized Reinsurance',
  },
]

/** Display units for a base-unit integer, without floating point. */
export function fromBaseUnits(digits: string, decimals: number): string {
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}
