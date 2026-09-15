'use client'

import { accountExplorerUrl, stellarDescriptor, stellarTestnet } from '@intent/config'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'

import type { ChainAdapter, ChainWallet, SignOutcome, SignRequest } from '../chain-adapter'
import { StellarWalletsKit, ensureKit } from '../stellar-kit'
import { fetchStellarBalances } from '../stellar-account'
import { clearSession, ensureSession } from '../api/auth'

/**
 * Remembers that a session was established, so a reload can restore it.
 *
 * The kit keeps its own record of the selected wallet, which is why a plain
 * "forget the address" disconnect did not work: the wallet was still
 * authorised, so the next read reconnected instantly and the button appeared to
 * do nothing. This flag records the user's *intent* to be disconnected, and is
 * the thing restore checks first.
 */
const SESSION_KEY = 'intent.stellar.session'

interface StoredSession {
  address: string
  /**
   * Whether the user asked to be connected.
   *
   * Not "did the backend issue a session". Those are different questions, and
   * conflating them broke restore: a backend sign-in that failed wrote `false`
   * here, the restore gate below returned early on it, and the wallet appeared
   * disconnected in every component except the one that had run `connect()`.
   *
   * A wallet connection is between the user and their wallet. The server having
   * no session for it is a separate, recoverable condition.
   */
  verified: boolean
}

/**
 * One connection, shared by every component that asks for it.
 *
 * `useStellarWallet` is a plain hook, so each caller used to get its own
 * `useState` — and the chain context shares only the adapter object, never the
 * wallet state. Five components call it. Connecting in the header updated the
 * header alone, so the swap history beside it still reported "connect a wallet"
 * while the address and balance sat in the toolbar above.
 *
 * A module-level store fixes that: one address, one set of subscribers, every
 * caller re-rendering on the same change.
 */
const listeners = new Set<() => void>()

let sharedAddress: string | undefined
let sharedNetwork: string | undefined

function publish(): void {
  for (const notify of listeners) notify()
}

function setSharedAddress(next: string | undefined): void {
  if (sharedAddress === next) return
  sharedAddress = next
  publish()
}

function setSharedNetwork(next: string | undefined): void {
  if (sharedNetwork === next) return
  sharedNetwork = next
  publish()
}

/** Subscribes a component to connection changes. */
function useSharedConnection(): { address: string | undefined; network: string | undefined } {
  const [, force] = useState(0)

  useEffect(() => {
    const notify = (): void => force((n) => n + 1)
    listeners.add(notify)
    return () => {
      listeners.delete(notify)
    }
  }, [])

  return { address: sharedAddress, network: sharedNetwork }
}

function readSession(): StoredSession | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = window.localStorage.getItem(SESSION_KEY)
    return raw === null ? undefined : (JSON.parse(raw) as StoredSession)
  } catch {
    // Private-mode browsers throw on localStorage; the session still works for
    // this tab, it just will not survive a reload.
    return undefined
  }
}

function writeSession(session: StoredSession | undefined): void {
  try {
    if (session === undefined) window.localStorage.removeItem(SESSION_KEY)
    else window.localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    /* see readSession */
  }
}

/** The message the user signs to prove they control the account. */
function buildLoginMessage(address: string): string {
  return [
    'Intent — sign in',
    '',
    `Account: ${address}`,
    `Network: ${stellarTestnet.name}`,
    `Issued: ${new Date().toISOString()}`,
    '',
    'Signing proves you control this account. It authorises no transaction and moves no funds.',
  ].join('\n')
}

/**
 * Stellar wallet, via the Stellar Wallets Kit (Freighter, xBull, Lobstr, Rabet,
 * Albedo, Hana).
 *
 * Three things differ from the EVM side:
 *
 * - There is no numeric chain id. "Wrong network" compares network passphrases,
 *   which is what Stellar wallets actually agree on.
 * - Connecting is two steps, not one. A wallet handing over its public key is
 *   not authentication — any site the user has ever visited can read it back
 *   silently. The signature step is what proves control, and is the reason
 *   connecting now prompts the wallet.
 * - Disconnect must clear the kit's own state as well as ours, or the wallet
 *   stays authorised and the next read silently reconnects.
 */
function useStellarWallet(): ChainWallet {
  // Shared, not local. Five components call this hook, and with per-caller
  // state only the one that ran `connect()` ever saw an address — the header
  // showed the wallet while the history panel beside it asked the user to
  // connect one.
  const { address, network } = useSharedConnection()
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  // Restore a prior connection.
  //
  // Gated on the user having asked to connect, and on the wallet still
  // reporting the same account — not on the backend having issued a session.
  // Those are different things: a server that is down, or a sign-in that
  // failed, must not make a perfectly good wallet look disconnected.
  useEffect(() => {
    let cancelled = false

    async function restore(): Promise<void> {
      ensureKit()
      const session = readSession()
      if (session === undefined) return

      try {
        const { address: current } = await StellarWalletsKit.getAddress()
        if (cancelled) return

        if (current === session.address) {
          setSharedAddress(current)
          const net = await StellarWalletsKit.getNetwork()
          if (!cancelled) setSharedNetwork(net.networkPassphrase)
        } else {
          // The wallet switched accounts while we were away; the old record
          // does not describe the new one.
          writeSession(undefined)
        }
      } catch {
        // Wallet locked, uninstalled, or permission revoked. Drop the record
        // rather than showing a connected UI we cannot back up.
        writeSession(undefined)
      }
    }

    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  const connect = useCallback(() => {
    async function run(): Promise<void> {
      ensureKit()
      setIsConnecting(true)
      setError(undefined)

      try {
        // Step 1: the user picks a wallet from the kit's modal.
        const { address: picked } = await StellarWalletsKit.authModal()

        // Step 2: prove control of it, once.
        //
        // This used to sign a locally-built message, discard the signature, and
        // then have `ensureSession` prompt a *second* time for the server's
        // challenge — two wallet popups per connect, the first proving nothing
        // to anyone. The server's challenge is the only signature that
        // establishes anything, so it is the only one asked for.
        //
        // Failure is not fatal: swapping and placing orders are on-chain and
        // need no server. Only saved history does, so a declined or unreachable
        // sign-in still leaves a usable wallet rather than blocking the
        // connection.
        setSharedAddress(picked)

        try {
          await ensureSession(picked)
          // Marked verified only once a signature actually succeeded. This flag
          // is what lets a reload restore the session without prompting again,
          // so setting it on an unsigned connection would restore a session
          // nobody proved.
          writeSession({ address: picked, verified: true })
        } catch {
          // The wallet is connected and usable; the backend simply has no
          // session for it. Recorded as unverified so a reload asks again
          // rather than silently restoring an unproven address.
          writeSession({ address: picked, verified: false })
        }

        const net = await StellarWalletsKit.getNetwork()
        setSharedNetwork(net.networkPassphrase)
      } catch (e) {
        // The kit throws when the user closes the modal or rejects the
        // signature — both are ordinary outcomes, not faults.
        const message = e instanceof Error ? e.message : 'Could not connect'
        setError(/reject|denied|declin|close/i.test(message) ? undefined : message)
        writeSession(undefined)
        setSharedAddress(undefined)
      } finally {
        setIsConnecting(false)
      }
    }
    void run()
  }, [])

  const disconnect = useCallback(() => {
    async function run(): Promise<void> {
      // Order matters: clear our record first so the restore effect cannot race
      // the kit's teardown and re-establish the session.
      writeSession(undefined)
      // The backend token outlives the wallet connection unless it is dropped
      // here: disconnecting and reconnecting a different account would
      // otherwise keep acting as the first one.
      clearSession()
      // Shared, so every component that shows a wallet clears together. With
      // per-caller state, disconnecting in the header left the rest of the app
      // still believing it was connected.
      setSharedAddress(undefined)
      setSharedNetwork(undefined)
      setError(undefined)
      await StellarWalletsKit.disconnect().catch(() => undefined)
    }
    void run()
  }, [])

  const isWrongNetwork =
    address !== undefined && network !== undefined && network !== stellarTestnet.networkPassphrase

  const { data: balances } = useQuery({
    queryKey: ['stellar-balances', address],
    queryFn: () => fetchStellarBalances(address as string),
    enabled: address !== undefined && !isWrongNetwork,
    refetchInterval: 15_000,
  })

  const switchNetwork = useCallback(() => {
    // Stellar wallets expose no programmatic network switch; the user changes
    // it in the wallet. Saying so beats a button that silently does nothing.
    setError(`Switch your wallet to ${stellarTestnet.name}, then reconnect.`)
  }, [])

  return {
    address,
    isConnected: address !== undefined,
    isConnecting,
    isWrongNetwork,
    balance: balances?.xlm,
    balanceSymbol: stellarDescriptor.nativeCurrency.symbol,
    // An unfunded account does not exist on-chain yet, which is Stellar's
    // equivalent of a zero balance and the cue to hit friendbot.
    needsFunding:
      address !== undefined && !isWrongNetwork && balances !== undefined && !balances.exists,
    // The kit's modal lists every wallet and flags the ones that need
    // installing, so there is no single "wallet missing" state to report.
    isWalletUnavailable: false,
    error,
    connect,
    disconnect,
    switchNetwork,
    isSwitching: false,
  }
}

/**
 * Hands a prepared transaction to whichever wallet the user connected with.
 *
 * The kit already routes this to Freighter, xBull, Lobstr, Rabet, Albedo or
 * Hana, so nothing here is wallet-specific. A user declining is an ordinary
 * outcome and is reported as `rejected` rather than thrown: cancelling a swap
 * is not an error.
 */
async function signStellarTransaction(req: SignRequest): Promise<SignOutcome> {
  ensureKit()

  try {
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(req.xdr, {
      address: req.address,
      networkPassphrase: stellarTestnet.networkPassphrase,
    })

    if (signedTxXdr === undefined || signedTxXdr === '') {
      return { ok: false, reason: 'rejected' }
    }
    return { ok: true, signedXdr: signedTxXdr }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'could not sign'
    // Wallets word a decline differently; treating it as an error would show a
    // failure message for something the user chose to do.
    if (/reject|denied|declin|cancel|close/i.test(message)) {
      return { ok: false, reason: 'rejected' }
    }
    return { ok: false, reason: 'wallet_error', detail: message }
  }
}

export const stellarAdapter: ChainAdapter = {
  descriptor: stellarDescriptor,
  useWallet: useStellarWallet,
  accountUrl: (address) => accountExplorerUrl('stellar', address),
  faucetUrl: 'https://friendbot.stellar.org',
  signTransaction: signStellarTransaction,
}
