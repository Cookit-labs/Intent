/** One wallet in the connect dialog's list. */
export interface WalletOption {
  id: string
  name: string
  icon?: string | undefined
  /** Ready to connect now. When false, `installUrl` says where to get it. */
  detected: boolean
  installUrl?: string | undefined
}

/**
 * What the connect dialog needs from a chain, and nothing else.
 *
 * The dialog draws its own wallet list on every chain, so each library is used
 * only for its data and its connect call, never for its modal.
 */
export interface WalletConnector {
  listWallets: () => Promise<WalletOption[]>
  /** Prompts the wallet. Throws if the wallet refuses or the user declines. */
  connect: (walletId: string) => Promise<void>
  /** Whether this chain already has a connected wallet. */
  isConnected: () => boolean
}

/** Wallets ready to connect first, keeping each library's own order within a group. */
export function orderWallets(options: readonly WalletOption[]): WalletOption[] {
  return [...options.filter((o) => o.detected), ...options.filter((o) => !o.detected)]
}

/** Wallets word a decline differently, and a decline is not a failure to report. */
export function isUserRejection(message: string): boolean {
  return /reject|denied|declin|cancel|close/i.test(message)
}
