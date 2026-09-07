import type { ChainDescriptor } from '@intent/types'

/**
 * Stellar testnet. Values verified against the live network rather than docs:
 * `getNetwork` on the Soroban RPC returns this passphrase and friendbot URL.
 *
 * Unlike Arc there is no numeric chain id — Stellar identifies a network by its
 * passphrase, which is what wallets compare against. Anything checking "is the
 * user on the right network" must compare passphrases, not ids.
 */
export const stellarTestnet = {
  network: 'stellar-testnet' as const,
  name: 'Stellar Testnet',
  /** Freighter reports its active network with this label. */
  freighterNetwork: 'TESTNET',
  networkPassphrase: 'Test SDF Network ; September 2015',
  horizonUrl: process.env['NEXT_PUBLIC_STELLAR_HORIZON_URL'] ?? 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: process.env['NEXT_PUBLIC_SOROBAN_RPC_URL'] ?? 'https://soroban-testnet.stellar.org',
  /** Funds a new testnet account with XLM. Testnet only — no mainnet equivalent. */
  friendbotUrl: 'https://friendbot.stellar.org',
  blockExplorerUrl: 'https://stellar.expert/explorer/testnet',
}

/**
 * USDC on Stellar is an issued asset, not a native balance: holding it requires
 * an explicit trustline to the issuer, which Arc has no equivalent of. This is
 * Circle's testnet issuer.
 */
export const STELLAR_USDC = {
  code: 'USDC',
  issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  decimals: 7,
}

/** Stellar's native asset. Distinct from USDC — XLM pays fees and reserves. */
export const STELLAR_NATIVE = {
  name: 'Lumens',
  symbol: 'XLM',
  decimals: 7,
}

export const stellarDescriptor: ChainDescriptor = {
  slug: 'stellar',
  family: 'stellar',
  name: 'Stellar',
  network: 'stellar-testnet',
  networkLabel: 'Stellar testnet',
  nativeCurrency: STELLAR_NATIVE,
  blockExplorerUrl: stellarTestnet.blockExplorerUrl,
  enabled: true,
}
