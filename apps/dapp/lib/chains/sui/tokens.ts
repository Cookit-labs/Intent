import type { ChainToken } from '../types'

/**
 * The only coins anything here will touch. Coin types and decimals were read from
 * each coin's on-chain metadata; USDC also matches Circle's published address. A
 * different coin can call itself USDT on Sui, and several do, so nothing is ever
 * resolved by symbol outside this list.
 */
export const SUI_TOKENS: readonly ChainToken[] = [
  { symbol: 'SUI', id: '0x2::sui::SUI', decimals: 9, name: 'Sui' },
  {
    symbol: 'USDC',
    id: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    decimals: 6,
    name: 'USD Coin (native)',
  },
  {
    symbol: 'USDsui',
    id: '0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI',
    decimals: 6,
    name: 'Sui Dollar',
  },
  {
    symbol: 'USDT',
    id: '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT',
    decimals: 6,
    name: 'Tether (Sui Bridge)',
  },
  {
    symbol: 'WAL',
    id: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
    decimals: 9,
    name: 'Walrus',
  },
  {
    symbol: 'sSUI',
    id: '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI',
    decimals: 9,
    name: 'Spring SUI',
  },
  {
    symbol: 'afSUI',
    id: '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI',
    decimals: 9,
    name: 'Aftermath Staked SUI',
  },
]

export const STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set(['USDC', 'USDsui', 'USDT'])

/** Display text for base units, rounded down so a quote never reads higher than it is. */
export function displayAmount(base: string, decimals: number, places = 6): string {
  const padded = base.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = padded.slice(padded.length - decimals, padded.length - decimals + places)
  const trimmed = fraction.replace(/0+$/, '')
  return trimmed === '' ? whole : `${whole}.${trimmed}`
}
