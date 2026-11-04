import type { NearConnector } from '@hot-labs/near-connect'

import { isUserRejection, orderWallets } from './connector'
import { walletErrorMessage } from './error-message'
import type { StoreConnector } from './store-connector'
import { createWalletStore } from './wallet-store'

const store = createWalletStore('intent.wallet.near')

let instance: Promise<NearConnector> | undefined
let restoring: Promise<void> | undefined

/** Loaded on first use: the connector touches the browser, and most visitors never pick NEAR. */
function connector(): Promise<NearConnector> {
  instance ??= import('@hot-labs/near-connect').then(({ NearConnector: Connector }) => {
    const built = new Connector({
      network: 'mainnet',
      footerBranding: null,
      // A command-line tool, not something a person connects from a web page.
      excludedWallets: ['near-cli'],
    })
    built.on('wallet:signOut', () => {
      store.remember(undefined)
      store.set({
        address: undefined,
        walletName: undefined,
        walletIcon: undefined,
        isRestoring: false,
      })
    })
    return built
  })
  return instance
}

/**
 * NEAR wallets through NEAR Connect. Its wallet list comes from a manifest it
 * fetches, so a failed fetch reads as an empty list rather than an exception.
 */
export const nearConnector: StoreConnector = {
  store,
  isConnected: () => store.get().address !== undefined,
  listWallets: async () => {
    const near = await connector()
    await near.whenManifestLoaded
    return orderWallets(
      near.availableWallets.map(({ manifest }) => ({
        id: manifest.id,
        name: manifest.name,
        icon: manifest.icon,
        // Each one runs in a sandbox the connector hosts, so there is nothing to install first.
        detected: true,
      }))
    )
  },
  connect: async (walletId) => {
    const near = await connector()
    const wallet = await near.connect({ walletId })
    const [account] = await wallet.getAccounts({ network: 'mainnet' })
    if (account === undefined) {
      throw new Error(`${wallet.manifest.name} has no NEAR mainnet account. Add one and try again.`)
    }
    store.remember(walletId)
    store.set({
      address: account.accountId,
      walletName: wallet.manifest.name,
      walletIcon: wallet.manifest.icon,
      isRestoring: false,
    })
  },
  restore: () => {
    restoring ??= (async () => {
      if (store.remembered() === undefined || store.get().address !== undefined) {
        store.set({ isRestoring: false })
        return
      }
      try {
        const near = await connector()
        const { wallet, accounts } = await near.getConnectedWallet()
        const [account] = accounts
        if (account === undefined) throw new Error('no account')
        store.set({
          address: account.accountId,
          walletName: wallet.manifest.name,
          walletIcon: wallet.manifest.icon,
          isRestoring: false,
        })
      } catch {
        store.remember(undefined)
        store.set({ isRestoring: false })
      }
    })()
    return restoring
  },
  signPrepared: async (payload) => {
    if (payload.family !== 'near') {
      return { ok: false, reason: 'wallet_error', detail: 'That is not a NEAR transaction.' }
    }
    const signerId = store.get().address
    if (signerId === undefined) {
      return { ok: false, reason: 'wallet_error', detail: 'Reconnect your wallet and try again.' }
    }
    try {
      const near = await connector()
      const wallet = await near.wallet()
      const outcomes = await wallet.signAndSendTransactions({
        network: 'mainnet',
        signerId,
        transactions: payload.transactions,
      })
      return {
        ok: true,
        signed: { family: 'near', hashes: outcomes.map((o) => o.transaction.hash as string) },
      }
    } catch (e) {
      const detail = walletErrorMessage(e)
      return isUserRejection(detail)
        ? { ok: false, reason: 'rejected' }
        : { ok: false, reason: 'wallet_error', detail }
    }
  },
  disconnect: async () => {
    const near = await connector()
    store.remember(undefined)
    store.set({
      address: undefined,
      walletName: undefined,
      walletIcon: undefined,
      isRestoring: false,
    })
    await near.disconnect().catch(() => undefined)
  },
}
