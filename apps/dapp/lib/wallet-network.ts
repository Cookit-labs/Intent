import { stellarNetwork, type StellarNetworkName } from '@intent/config'

/**
 * "Wrong network" for a Stellar wallet.
 *
 * Stellar has no chain id. A wallet reports the passphrase of the network it
 * is on, and that is compared with the network this deployment is pointed at
 * — never with a hardcoded testnet, which would tell a mainnet user to leave
 * mainnet.
 */

/** Whether a wallet reporting this passphrase is on another network than the app. */
export function isWrongStellarNetwork(walletPassphrase: string | undefined): boolean {
  return walletPassphrase !== undefined && walletPassphrase !== stellarNetwork.networkPassphrase
}

/**
 * What to tell a user whose wallet is elsewhere. Stellar wallets expose no
 * programmatic switch, so the message names the network and asks.
 */
export function switchNetworkMessage(): string {
  return `Switch your wallet to ${stellarNetwork.name}, then reconnect.`
}

const PASSPHRASES: Record<string, 'testnet' | 'mainnet'> = {
  'Test SDF Network ; September 2015': 'testnet',
  'Public Global Stellar Network ; September 2015': 'mainnet',
}

/** Which Stellar network a wallet's passphrase names, or nothing if it is neither. */
export function stellarNetworkOf(
  walletPassphrase: string | undefined
): 'testnet' | 'mainnet' | undefined {
  return walletPassphrase === undefined ? undefined : PASSPHRASES[walletPassphrase]
}

/** What the header says when the wallet and the app are on different networks. */
export function mismatchLabel(walletNetwork: 'testnet' | 'mainnet' | undefined): string {
  return walletNetwork === undefined ? 'Wrong network' : `Wallet is on Stellar ${walletNetwork}`
}

export interface MismatchPrompt {
  title: string
  body: string
  /** The button that goes to the network the wallet is already on. */
  useWalletNetworkLabel: string
}

/** What the dialog says when the wallet is on a different network than the page. */
export function mismatchPrompt(
  selected: StellarNetworkName,
  wallet: StellarNetworkName
): MismatchPrompt {
  return {
    title: `Your wallet is on Stellar ${wallet}`,
    body: `Switch it to Stellar ${selected} to continue, or use Stellar ${wallet} here instead.`,
    useWalletNetworkLabel: `Use Stellar ${wallet} instead`,
  }
}

/** Where in a wallet the network is changed. An app cannot change it for the user. */
export function switchSteps(walletName: string | undefined, target: StellarNetworkName): string {
  const label = target === 'mainnet' ? 'Mainnet' : 'Testnet'
  if (walletName === 'Freighter') {
    return `In Freighter, open the menu, choose Network, then pick ${label}.`
  }
  if (walletName !== undefined) {
    return `In ${walletName}, open its settings and change the network to ${label}.`
  }
  return `In your wallet, open its settings and change the network to Stellar ${target}.`
}

/**
 * Whether to refuse to sign. Only when the wallet says it is on a different
 * network: a wallet that does not report one is still handed the passphrase
 * with the request, and the ones that honor it sign for the right network.
 */
export function refusesToSign(
  walletPassphrase: string | undefined,
  selectedPassphrase: string
): boolean {
  return walletPassphrase !== undefined && walletPassphrase !== selectedPassphrase
}
