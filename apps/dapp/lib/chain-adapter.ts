import type { ChainDescriptor, ChainSlug } from '@intent/types'

/**
 * The wallet surface every chain must provide, and the only wallet API that
 * components are allowed to see.
 *
 * The point of this interface is that Arc and Stellar share no machinery: Arc
 * goes through wagmi/viem/RainbowKit with `0x` addresses and a numeric chain
 * id, while Stellar goes through Freighter and Horizon with `G...` addresses
 * and a network passphrase. Without a common shape, every screen would branch
 * on the chain. With it, screens call `useWallet()` and stay chain-blind.
 *
 * Kept deliberately narrow — only what the UI renders today. Signing and
 * contract calls are absent because neither chain has deployed contracts yet;
 * adding them later means extending this in one place.
 */
export interface WalletSnapshot {
  address: string | undefined
  isConnected: boolean
  isConnecting: boolean
  /** Connected, but the wallet is pointed at a different network. */
  isWrongNetwork: boolean
  /** Formatted native balance (Arc: USDC, Stellar: XLM). Undefined until read. */
  balance: string | undefined
  /** Symbol matching `balance`, so callers never hardcode a ticker. */
  balanceSymbol: string
  /** Connected, on the right network, holding zero — they need the faucet. */
  needsFunding: boolean
  /** True when the wallet software itself is missing (extension not installed). */
  isWalletUnavailable: boolean
  /** Populated when connect/switch failed, for display. */
  error: string | undefined
}

export interface WalletActions {
  connect: () => void
  disconnect: () => void
  /** Move the wallet to this chain's expected network. */
  switchNetwork: () => void
  isSwitching: boolean
}

export type ChainWallet = WalletSnapshot & WalletActions

export interface ChainAdapter {
  descriptor: ChainDescriptor
  /**
   * React hook returning live wallet state. A hook rather than a plain object
   * because both implementations subscribe to external state (wagmi store,
   * Freighter polling) and must re-render on change.
   */
  useWallet: () => ChainWallet
  /** Explorer link for an account on this chain. */
  accountUrl: (address: string) => string
  /** Where a user gets test funds, if the network has a faucet. */
  faucetUrl?: string
}

export const EMPTY_WALLET: ChainWallet = {
  address: undefined,
  isConnected: false,
  isConnecting: false,
  isWrongNetwork: false,
  balance: undefined,
  balanceSymbol: '',
  needsFunding: false,
  isWalletUnavailable: false,
  error: undefined,
  connect: () => undefined,
  disconnect: () => undefined,
  switchNetwork: () => undefined,
  isSwitching: false,
}

export type { ChainSlug }
