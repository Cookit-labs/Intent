import type { ChainToken } from '../types'

export const WRAP_NEAR = 'wrap.near'
export const USDC_NEAR = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
export const USDT_NEAR = 'usdt.tether-token.near'
export const RNEAR_CONTRACT = 'lst.rhealab.near'
export const METAPOOL_CONTRACT = 'meta-pool.near'

/**
 * Exact NEP-141 accounts. Each id and decimal count was read from the contract's
 * `ft_metadata` and matches the 1Click token list. `near-contracts.live.test.ts`
 * re-checks them. NEAR itself is held natively and travels as wNEAR on `wrap.near`.
 */
export const nearTokens: readonly ChainToken[] = [
  { symbol: 'NEAR', id: WRAP_NEAR, decimals: 24, name: 'NEAR' },
  { symbol: 'USDC', id: USDC_NEAR, decimals: 6, name: 'USD Coin' },
  { symbol: 'USDT', id: USDT_NEAR, decimals: 6, name: 'Tether USD' },
  { symbol: 'stNEAR', id: METAPOOL_CONTRACT, decimals: 24, name: 'Meta Pool Staked NEAR' },
  { symbol: 'rNEAR', id: RNEAR_CONTRACT, decimals: 24, name: 'Rhea Staked NEAR' },
]

/**
 * The coin itself, as a balance read reports it. The table above lists NEAR by the wrapped contract
 * it trades through, and a wallet's wNEAR is a different holding from its NEAR.
 */
export const NATIVE_NEAR: ChainToken = { symbol: 'NEAR', id: 'near', decimals: 24, name: 'NEAR' }

export const YOCTO_PER_NEAR = BigInt('1000000000000000000000000')
export const TGAS = BigInt('1000000000000')

export const NEAR_EXPLORER_TX = 'https://nearblocks.io/txns/'

export function explorerUrl(hash: string): string {
  return `${NEAR_EXPLORER_TX}${hash}`
}

/** Base units as display text, cut to `places` decimals and never rounded up. */
export function formatUnits(base: string, decimals: number, places = 6): string {
  const padded = base.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = padded.slice(padded.length - decimals, padded.length - decimals + places)
  const trimmed = fraction.replace(/0+$/, '')
  return trimmed === '' ? whole : `${whole}.${trimmed}`
}

/**
 * A base-unit amount as a number of display units, for dollar comparisons only.
 * Never used to build what gets signed.
 */
export function toDisplayNumber(base: string, decimals: number): number {
  return Number(base) / 10 ** decimals
}
