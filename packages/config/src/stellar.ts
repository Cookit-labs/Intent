import type { ChainDescriptor, SupportedNetwork } from '@intent/types'

/**
 * Which Stellar network this deployment executes on.
 *
 * One flag, `NEXT_PUBLIC_STELLAR_NETWORK`, read at import. Testnet is the
 * default so that a checkout with no `.env` behaves exactly as it always has;
 * `mainnet` is the one other value. Anything else throws here rather than
 * falling back: an operator who typed `pubnet` meant real money, and the
 * wrong silent default in either direction is worse than a failed boot.
 *
 * The flag is `NEXT_PUBLIC_` because the browser needs it too — the wallet
 * passphrase check, the explorer links and the funding button all differ —
 * and Next.js inlines it into the client bundle only when it is read as a
 * literal `process.env['NEXT_PUBLIC_…']`, which is the one form used below.
 */
export type StellarNetworkName = 'testnet' | 'mainnet'

const NETWORK_ENV = 'NEXT_PUBLIC_STELLAR_NETWORK'

/** The flag's value as a network, or a thrown misconfiguration. Pure, for tests. */
export function parseStellarNetwork(raw: string | undefined): StellarNetworkName {
  const value = raw?.trim() ?? ''
  if (value === '' || value === 'testnet') return 'testnet'
  if (value === 'mainnet') return 'mainnet'
  throw new Error(
    `${NETWORK_ENV} must be "testnet" (the default) or "mainnet", not "${value}". ` +
      'Unset it to stay on testnet.'
  )
}

export function activeNetwork(): StellarNetworkName {
  return parseStellarNetwork(process.env['NEXT_PUBLIC_STELLAR_NETWORK'])
}

export function isMainnet(): boolean {
  return activeNetwork() === 'mainnet'
}

export interface StellarNetwork {
  network: SupportedNetwork
  name: string
  /** Freighter reports its active network with this label. */
  freighterNetwork: 'TESTNET' | 'PUBLIC'
  networkPassphrase: string
  horizonUrl: string
  sorobanRpcUrl: string
  /** Funds a new account with XLM. Testnet only — absent on mainnet, where nothing is free. */
  friendbotUrl?: string
  blockExplorerUrl: string
  /**
   * USDC on Stellar is an issued asset, not a native balance: holding it
   * requires an explicit trustline to the issuer, which Arc has no equivalent
   * of. Circle issues from a different account on each network.
   */
  usdc: { code: string; issuer: string; decimals: number }
}

const NETWORK = activeNetwork()

/**
 * A private Horizon or RPC, for the active network only. Applied to the
 * network in use rather than to both, so a mainnet deployment pointing at its
 * own RPC does not also rewrite the testnet object's URLs — and on testnet,
 * where nothing else changes, this is exactly the override it always was.
 */
function withOverrides<T extends StellarNetwork>(base: T, active: boolean): T {
  if (!active) return base
  return {
    ...base,
    horizonUrl: process.env['NEXT_PUBLIC_STELLAR_HORIZON_URL'] ?? base.horizonUrl,
    sorobanRpcUrl: process.env['NEXT_PUBLIC_SOROBAN_RPC_URL'] ?? base.sorobanRpcUrl,
  }
}

/**
 * Stellar testnet. Values verified against the live network rather than docs:
 * `getNetwork` on the Soroban RPC returns this passphrase and friendbot URL.
 *
 * Unlike Arc there is no numeric chain id — Stellar identifies a network by its
 * passphrase, which is what wallets compare against. Anything checking "is the
 * user on the right network" must compare passphrases, not ids.
 */
export const stellarTestnet: StellarNetwork & { friendbotUrl: string } = withOverrides(
  {
    network: 'stellar-testnet',
    name: 'Stellar Testnet',
    freighterNetwork: 'TESTNET',
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    friendbotUrl: 'https://friendbot.stellar.org',
    blockExplorerUrl: 'https://stellar.expert/explorer/testnet',
    // Circle's testnet issuer.
    usdc: {
      code: 'USDC',
      issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      decimals: 7,
    },
  },
  NETWORK === 'testnet'
)

/**
 * Stellar mainnet — the public network. No friendbot: an account exists only
 * once someone has paid the reserve into it.
 *
 * The public Soroban RPC is fine to start; `NEXT_PUBLIC_SOROBAN_RPC_URL`
 * swaps in a provider's endpoint without a code change.
 */
export const stellarMainnet: StellarNetwork = withOverrides(
  {
    network: 'stellar-mainnet',
    name: 'Stellar Mainnet',
    freighterNetwork: 'PUBLIC',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://mainnet.sorobanrpc.com',
    blockExplorerUrl: 'https://stellar.expert/explorer/public',
    // Circle's mainnet issuer, the one centre.io publishes.
    usdc: {
      code: 'USDC',
      issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      decimals: 7,
    },
  },
  NETWORK === 'mainnet'
)

/**
 * The network this deployment is on. Everything that talks to Stellar reads
 * this; `stellarTestnet` stays exported for the few places that mean testnet
 * specifically — the live tests, which fund throwaway accounts from friendbot.
 */
export const stellarNetwork: StellarNetwork =
  NETWORK === 'mainnet' ? stellarMainnet : stellarTestnet

/** The active network's USDC. Same shape as before; the issuer follows the flag. */
export const STELLAR_USDC = stellarNetwork.usdc

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
  network: stellarNetwork.network,
  networkLabel: NETWORK === 'mainnet' ? 'Stellar mainnet' : 'Stellar testnet',
  nativeCurrency: STELLAR_NATIVE,
  blockExplorerUrl: stellarNetwork.blockExplorerUrl,
  enabled: true,
}
