import { stellarNetwork } from '@intent/config'

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
