import type { SignedOutcome, SigningPayload } from '../chains/types'
import type { WalletConnector } from './connector'
import type { WalletStore } from './wallet-store'

/** A connector whose connection lives in a `WalletStore`. */
export interface StoreConnector extends WalletConnector {
  store: WalletStore
  /** Reconnects the remembered wallet without prompting. Safe to call repeatedly. */
  restore: () => Promise<void>
  disconnect: () => Promise<void>
  signPrepared: (payload: SigningPayload) => Promise<SignedOutcome>
}
