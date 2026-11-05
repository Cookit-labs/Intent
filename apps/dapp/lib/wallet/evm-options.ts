import { orderWallets, type WalletOption } from './connector'

export interface EvmConnectorInfo {
  id: string
  name: string
  type: string
  icon?: string | undefined
}

/** Offered with an install link when the browser has no such wallet. */
const KNOWN_EVM_WALLETS = [
  { name: 'MetaMask', installUrl: 'https://metamask.io/download' },
  { name: 'Rabby Wallet', installUrl: 'https://rabby.io' },
]

/**
 * The wallet list for an EVM chain.
 *
 * wagmi reports each browser wallet by name (EIP-6963) and also keeps a generic
 * "injected" connector. The generic one is only useful when nothing named turned
 * up, and otherwise is the same wallet listed twice.
 */
export function evmWalletOptions(connectors: readonly EvmConnectorInfo[]): WalletOption[] {
  const named = connectors.filter((c) => c.id !== 'injected')
  const anyBrowserWallet = named.some((c) => c.type === 'injected')
  const usable = anyBrowserWallet ? named : connectors

  const seen = new Set<string>()
  const options: WalletOption[] = []
  for (const c of usable) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    options.push({ id: c.id, name: c.name, icon: c.icon, detected: true })
  }
  for (const k of KNOWN_EVM_WALLETS) {
    if (seen.has(k.name)) continue
    options.push({ id: k.name, name: k.name, detected: false, installUrl: k.installUrl })
  }
  return orderWallets(options)
}
