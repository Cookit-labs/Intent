/** The connected wallet of one chain, for the chains whose libraries keep no React state. */
export interface WalletStoreState {
  address: string | undefined
  walletName: string | undefined
  walletIcon: string | undefined
  /** A remembered wallet is being reconnected, so "not connected" is not yet an answer. */
  isRestoring: boolean
}

export interface WalletStore {
  get: () => WalletStoreState
  getServer: () => WalletStoreState
  set: (next: Partial<WalletStoreState>) => void
  subscribe: (listener: () => void) => () => void
  /** The wallet to reconnect after a reload, if any. */
  remembered: () => string | undefined
  remember: (walletId: string | undefined) => void
}

const SERVER_STATE: WalletStoreState = {
  address: undefined,
  walletName: undefined,
  walletIcon: undefined,
  isRestoring: true,
}

/**
 * A store outside React, so every component reading a chain's wallet shares one
 * connection and it survives moving between screens.
 */
export function createWalletStore(
  key: string,
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = browserStorage
): WalletStore {
  function remembered(): string | undefined {
    try {
      return storage()?.getItem(key) ?? undefined
    } catch {
      // Private-mode browsers throw here. The wallet still works for this tab.
      return undefined
    }
  }

  const listeners = new Set<() => void>()
  let state: WalletStoreState = { ...SERVER_STATE, isRestoring: remembered() !== undefined }

  return {
    get: () => state,
    getServer: () => SERVER_STATE,
    set: (next) => {
      state = { ...state, ...next }
      for (const notify of listeners) notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    remembered,
    remember: (walletId) => {
      try {
        if (walletId === undefined) storage()?.removeItem(key)
        else storage()?.setItem(key, walletId)
      } catch {
        /* see remembered() */
      }
    },
  }
}

function browserStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage
}
