interface NamedWallet {
  productName: string
  productUrl: string
}

/**
 * Freighter was renamed Varial on 29 October 2026, and the wallet kit still calls it Freighter.
 *
 * Only what people see changes. The kit's module, the wallet's own API and the `freighter` id a
 * connected wallet is saved under stay as they are, so nobody is disconnected.
 */
export function asVarial<T extends NamedWallet>(wallet: T): T {
  wallet.productName = 'Varial'
  wallet.productUrl = 'https://varialwallet.com'
  return wallet
}
