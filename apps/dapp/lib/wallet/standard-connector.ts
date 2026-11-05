import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from '@wallet-standard/features'

import type { SignedOutcome, SignedPayload, SigningPayload } from '../chains/types'
import { isUserRejection, orderWallets, type WalletOption } from './connector'
import { walletErrorMessage } from './error-message'
import type { StoreConnector } from './store-connector'
import { createWalletStore } from './wallet-store'

/** How long a remembered extension gets to announce itself after a reload. */
const REGISTER_WAIT_MS = 1_500

interface KnownWallet {
  name: string
  installUrl: string
}

/**
 * Solana and Sui wallets both announce themselves through the Wallet Standard,
 * so one connector serves both, told apart by the chain each wallet declares.
 */
export function createStandardConnector({
  storageKey,
  chain,
  known,
  sign,
}: {
  storageKey: string
  /** The Wallet Standard chain id, such as `solana:mainnet`. */
  chain: `${string}:${string}`
  /** Shown with an install link when not detected. */
  known: readonly KnownWallet[]
  /** Calls the wallet's signing feature, which differs by chain. Throws if it cannot. */
  sign: (wallet: Wallet, account: WalletAccount, payload: SigningPayload) => Promise<SignedPayload>
}): StoreConnector {
  const store = createWalletStore(storageKey)
  let stopWatching: (() => void) | undefined
  let restoring: Promise<void> | undefined

  function installed(): Wallet[] {
    return getWallets()
      .get()
      .filter((w) => w.chains.includes(chain) && StandardConnect in w.features)
  }

  function accountOn(accounts: readonly WalletAccount[]): WalletAccount | undefined {
    return accounts.find((a) => a.chains.includes(chain)) ?? accounts[0]
  }

  function adopt(wallet: Wallet, account: WalletAccount): void {
    store.set({
      address: account.address,
      walletName: wallet.name,
      walletIcon: wallet.icon,
      isRestoring: false,
    })
    store.remember(wallet.name)
    stopWatching?.()
    const events = (wallet.features as Partial<StandardEventsFeature>)[StandardEvents]
    // Switching account inside the wallet must not leave the app on the old one.
    stopWatching = events?.on('change', ({ accounts }) => {
      if (accounts === undefined) return
      const next = accountOn(accounts)
      if (next === undefined) forget()
      else store.set({ address: next.address })
    })
  }

  function forget(): void {
    stopWatching?.()
    stopWatching = undefined
    store.remember(undefined)
    store.set({
      address: undefined,
      walletName: undefined,
      walletIcon: undefined,
      isRestoring: false,
    })
  }

  async function connectWith(wallet: Wallet, silent: boolean): Promise<void> {
    const feature = (wallet.features as StandardConnectFeature)[StandardConnect]
    const { accounts } = await feature.connect({ silent })
    const account = accountOn(accounts)
    if (account === undefined) {
      throw new Error(`${wallet.name} has no account on this chain. Add one and try again.`)
    }
    adopt(wallet, account)
  }

  /** An extension can announce itself after the page loads, so a remembered one gets a moment. */
  async function waitFor(name: string): Promise<Wallet | undefined> {
    const present = installed().find((w) => w.name === name)
    if (present !== undefined) return present
    return new Promise((resolve) => {
      const off = getWallets().on('register', () => {
        const found = installed().find((w) => w.name === name)
        if (found === undefined) return
        off()
        window.clearTimeout(timer)
        resolve(found)
      })
      const timer = window.setTimeout(() => {
        off()
        resolve(undefined)
      }, REGISTER_WAIT_MS)
    })
  }

  return {
    store,
    isConnected: () => store.get().address !== undefined,
    listWallets: async () => {
      const present = installed()
      const options: WalletOption[] = present.map((w) => ({
        id: w.name,
        name: w.name,
        icon: w.icon,
        detected: true,
      }))
      for (const k of known) {
        if (present.some((w) => w.name === k.name)) continue
        options.push({ id: k.name, name: k.name, detected: false, installUrl: k.installUrl })
      }
      return orderWallets(options)
    },
    connect: async (walletId) => {
      const wallet = installed().find((w) => w.name === walletId)
      if (wallet === undefined) throw new Error(`${walletId} is not installed in this browser.`)
      await connectWith(wallet, false)
    },
    restore: () => {
      restoring ??= (async () => {
        const name = store.remembered()
        if (name === undefined || store.get().address !== undefined) {
          store.set({ isRestoring: false })
          return
        }
        try {
          const wallet = await waitFor(name)
          if (wallet === undefined) throw new Error('not present')
          await connectWith(wallet, true)
        } catch {
          // Locked, removed or no longer authorised: back to the connect page.
          forget()
        }
      })()
      return restoring
    },
    signPrepared: async (payload): Promise<SignedOutcome> => {
      const wallet = installed().find((w) => w.name === store.get().walletName)
      const account = wallet?.accounts.find((a) => a.address === store.get().address)
      if (wallet === undefined || account === undefined) {
        return { ok: false, reason: 'wallet_error', detail: 'Reconnect your wallet and try again.' }
      }
      try {
        return { ok: true, signed: await sign(wallet, account, payload) }
      } catch (e) {
        const detail = walletErrorMessage(e)
        return isUserRejection(detail)
          ? { ok: false, reason: 'rejected' }
          : { ok: false, reason: 'wallet_error', detail }
      }
    },
    disconnect: async () => {
      const current = installed().find((w) => w.name === store.get().walletName)
      forget()
      const feature = (current?.features as Partial<StandardDisconnectFeature> | undefined)?.[
        StandardDisconnect
      ]
      await feature?.disconnect().catch(() => undefined)
    },
  }
}
