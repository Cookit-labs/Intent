'use client'

import type { ChainWallet } from '../lib/chain-adapter'
import { useChain } from '../providers/chain-provider'

/**
 * Wallet state for the active chain.
 *
 * This used to call wagmi directly. It now delegates to the chain's adapter, so
 * a component asking for the wallet gets Arc's EVM wallet or Stellar's Freighter
 * wallet without knowing which — the two share no underlying machinery.
 *
 * Balance is always the chain's *native* asset (Arc: USDC, Stellar: XLM), with
 * `balanceSymbol` naming it so callers never hardcode a ticker.
 */
export type WalletState = ChainWallet

export function useWallet(): WalletState {
  const { adapter } = useChain()
  return adapter.useWallet()
}
