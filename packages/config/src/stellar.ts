import type { ChainDescriptor, SupportedNetwork } from '@intent/types'

import { liveObject } from './live-object'
import { activeNetwork, defaultNetwork, type StellarNetworkName } from './network-select'

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

const DEFAULT = defaultNetwork()

/**
 * A private Horizon or RPC, for the deployment's default network only. Applied
 * to that one rather than to both, so a mainnet deployment pointing at its own
 * RPC does not also rewrite the testnet object's URLs — and with one network
 * served, this is exactly the override it always was.
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
  DEFAULT === 'testnet'
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
  DEFAULT === 'mainnet'
)

/** The network object for a named network. */
export function stellarNetworkFor(network: StellarNetworkName): StellarNetwork {
  return network === 'mainnet' ? stellarMainnet : stellarTestnet
}

/**
 * The network of the call in progress. Everything that talks to Stellar reads
 * this; it resolves per access, so one server can answer for either network.
 * `stellarTestnet` stays exported for the few places that mean testnet
 * specifically — the live tests, which fund throwaway accounts from friendbot.
 */
export const stellarNetwork: StellarNetwork = liveObject(() => stellarNetworkFor(activeNetwork()))

/** The active network's USDC. Same shape as before; the issuer follows the network. */
export const STELLAR_USDC: StellarNetwork['usdc'] = liveObject(
  () => stellarNetworkFor(activeNetwork()).usdc
)

/** Stellar's native asset. Distinct from USDC — XLM pays fees and reserves. */
export const STELLAR_NATIVE = {
  name: 'Lumens',
  symbol: 'XLM',
  decimals: 7,
}

export function stellarDescriptorFor(network: StellarNetworkName): ChainDescriptor {
  const net = stellarNetworkFor(network)
  return {
    slug: 'stellar',
    family: 'stellar',
    name: 'Stellar',
    network: net.network,
    networkLabel: network === 'mainnet' ? 'Stellar mainnet' : 'Stellar testnet',
    nativeCurrency: STELLAR_NATIVE,
    blockExplorerUrl: net.blockExplorerUrl,
    enabled: true,
  }
}

export const stellarDescriptor: ChainDescriptor = liveObject(() =>
  stellarDescriptorFor(activeNetwork())
)
