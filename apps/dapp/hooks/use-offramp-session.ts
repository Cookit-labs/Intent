'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { lookupAnchor } from '../lib/offramp/anchors'
import type { AnchorId } from '../lib/offramp/anchors'
import { ensureAuthSession } from '../lib/offramp/ensure-session'
import type { Sep24Status, WithdrawLimits } from '../lib/offramp/sep24'
import {
  AnchorHttpError,
  isDeclined,
  isReadyToPay,
  readTransaction,
  startWithdraw,
} from '../lib/offramp/sep24'
import { clearSession, saveSession } from '../lib/offramp/session-store'
import { USDC } from '../lib/swap/assets'
import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'

/**
 * One withdrawal with one anchor, from authentication to "ready to pay".
 *
 * Nothing here moves funds. The hook ends at `ready`, which means the anchor
 * has named an account and a memo; building and signing the payment is the
 * sequence hook's job, through the server. What this hook owns is the part
 * that only the browser can do — the wallet signing the SEP-10 challenge and
 * the user completing the anchor's own page — and the polling that notices
 * when that page is done.
 *
 * Polling is the source of truth. The anchor may `postMessage` when the user
 * finishes, and the popup is opened without `noopener` so it can, but many
 * anchors never do and the user can close the window early. A status read
 * every three seconds catches every case the callback would and several it
 * would not.
 */

export type OfframpPhase =
  | 'idle'
  | 'authenticating'
  | 'starting'
  | 'interactive'
  | 'ready'
  | 'declined'
  | 'failed'

export interface OfframpSessionState {
  phase: OfframpPhase
  anchorId?: AnchorId
  anchorName?: string
  limits?: WithdrawLimits
  token?: string
  transactionId?: string
  interactiveUrl?: string
  /** Whether the automatic popup attempt actually produced a window. */
  popupOpen: boolean
  status?: Sep24Status
  moreInfoUrl?: string
  error?: string
}

export interface OfframpSession extends OfframpSessionState {
  /** Authenticates, starts the withdrawal, opens the anchor's page, polls. */
  begin: (anchorId: AnchorId, amount?: string) => void
  /** Re-opens the anchor's page if the user closed it. */
  reopen: () => void
  reset: () => void
}

const POLL_MS = 3_000
/** 10 misses at 3s each: 30s of a dead endpoint before giving up. */
const MAX_POLL_FAILURES = 10
const EMPTY: OfframpSessionState = { phase: 'idle', popupOpen: false }

/** Phases in which a withdrawal is already running; `begin` refuses to start a second one over them. */
const IN_PROGRESS_PHASES = new Set<OfframpPhase>([
  'authenticating',
  'starting',
  'interactive',
  'ready',
])

/**
 * Best-effort: this only actually opens a window when called synchronously
 * from a user gesture (a click handler), which `begin`'s internal call is
 * not — it runs after an anchor-info fetch, a wallet signing prompt, and a
 * start-withdrawal call, so most browsers block it and this returns `null`.
 * The state's `popupOpen` field reports whether it worked; the card's own
 * "open" button, which *is* a click, is the reliable path.
 */
function openAnchorPage(url: string): Window | null {
  // No `noopener`: it would sever the handle the anchor uses to postMessage
  // back.
  return window.open(url, 'intent-anchor', 'popup,width=520,height=760')
}

export function useOfframpSession(): OfframpSession {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<OfframpSessionState>(EMPTY)
  const popupRef = useRef<Window | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  // Mirrors `state.phase` for the re-entrancy guard in `begin`, which reads
  // it from inside a `useCallback` closure that must not go stale — and must
  // not depend on `state.phase` directly, or `begin` would be recreated on
  // every phase change.
  const phaseRef = useRef<OfframpPhase>(state.phase)

  useEffect(() => {
    phaseRef.current = state.phase
  }, [state.phase])

  const stopPolling = useCallback(() => {
    if (pollRef.current !== undefined) clearInterval(pollRef.current)
    pollRef.current = undefined
  }, [])

  const reset = useCallback(() => {
    stopPolling()
    popupRef.current?.close()
    popupRef.current = null
    setState(EMPTY)
  }, [stopPolling])

  useEffect(() => stopPolling, [stopPolling])

  const poll = useCallback(
    (
      toml: import('../lib/offramp/toml').AnchorToml,
      token: string,
      id: string,
      anchorId: string,
      account: string
    ) => {
      stopPolling()
      let consecutiveFailures = 0
      pollRef.current = setInterval(() => {
        void (async () => {
          try {
            const tx = await readTransaction(toml, { authToken: token, id })
            consecutiveFailures = 0
            setState((s) => ({
              ...s,
              status: tx.status,
              ...(tx.moreInfoUrl !== undefined ? { moreInfoUrl: tx.moreInfoUrl } : {}),
            }))
            if (isReadyToPay(tx.status)) {
              stopPolling()
              setState((s) => ({ ...s, phase: 'ready' }))
            } else if (isDeclined(tx.status)) {
              stopPolling()
              setState((s) => ({
                ...s,
                phase: 'declined',
                error: tx.message ?? `The anchor ended this withdrawal: ${tx.status}.`,
              }))
            }
          } catch (e) {
            // A 401 means the token died — reported, and the stranded session
            // cleared so a fresh `begin` does not try to resume it.
            if (e instanceof AnchorHttpError && e.status === 401) {
              stopPolling()
              clearSession(window.sessionStorage, anchorId, account)
              setState((s) => ({
                ...s,
                phase: 'failed',
                error: 'The anchor session expired. Start the withdrawal again.',
              }))
              return
            }
            if (e instanceof AnchorHttpError) {
              // One failed read is not a failed withdrawal; the next tick
              // tries again — but not forever, or a permanently-down anchor
              // polls indefinitely with the UI stuck on `interactive`.
              consecutiveFailures += 1
              if (consecutiveFailures >= MAX_POLL_FAILURES) {
                stopPolling()
                setState((s) => ({
                  ...s,
                  phase: 'failed',
                  error: 'The anchor has stopped answering. Nothing was sent; you can start again.',
                }))
              }
              return
            }
            // Not an HTTP error — a shape error (an unknown status or memo
            // type `readTransaction` refused to interpret). Retrying will not
            // heal that; stop immediately rather than spend the full ceiling.
            stopPolling()
            setState((s) => ({
              ...s,
              phase: 'failed',
              error: `The anchor answered in a form this app cannot use: ${e instanceof Error ? e.message : String(e)}`,
            }))
          }
        })()
      }, POLL_MS)
    },
    [stopPolling]
  )

  const begin = useCallback(
    (anchorId: AnchorId, amount?: string) => {
      // A withdrawal already running is not restarted out from under itself:
      // two concurrent `run()`s would each call `startWithdraw`, open a
      // second popup, and interleave `setState` calls from whichever loses.
      if (IN_PROGRESS_PHASES.has(phaseRef.current)) return

      stopPolling()
      popupRef.current?.close()
      popupRef.current = null

      if (!isConnected || address === undefined) {
        setState({ ...EMPTY, phase: 'failed', error: 'Connect a wallet to withdraw.' })
        return
      }
      if (adapter.signTransaction === undefined) {
        setState({
          ...EMPTY,
          phase: 'failed',
          error: 'This wallet cannot sign the anchor sign-in on this chain.',
        })
        return
      }
      const account = address

      async function run(): Promise<void> {
        const entry = lookupAnchor(anchorId)
        if (entry === undefined) {
          setState({
            ...EMPTY,
            phase: 'failed',
            anchorId,
            error: `${anchorId} is not an anchor this app uses.`,
          })
          return
        }
        // MoneyGram's sign-in demands a client_domain: this app reachable at a
        // domain the anchor can verify, serving its own stellar.toml, with a
        // server key co-signing every challenge. This deployment has none, so
        // the refusal is said here rather than discovered mid-flow.
        if (entry.requiresClientDomain) {
          setState({
            ...EMPTY,
            phase: 'failed',
            anchorId,
            anchorName: entry.name,
            error: `${entry.name} needs this app to be reachable at a domain it can verify (a SEP-10 client domain). That is not set up for this deployment, so nothing was started.`,
          })
          return
        }

        setState({ ...EMPTY, phase: 'authenticating', anchorId })

        // The anchor-info fetch, the lookup of a reusable token, and the
        // wallet challenge when none is reusable — shared with the status
        // refresh under Open positions, so both authenticate the same way.
        const ensured = await ensureAuthSession({
          anchorId,
          account,
          sign: async (xdr) => {
            const out = await adapter.signTransaction?.({ xdr, address: account })
            if (out === undefined) throw new Error('This wallet cannot sign here.')
            if (!out.ok) {
              throw new Error(
                out.reason === 'rejected'
                  ? 'You declined the anchor sign-in.'
                  : (out.detail ?? 'The wallet could not sign.')
              )
            }
            return out.signedXdr
          },
        })
        const toml = ensured.toml
        const session = ensured.session
        setState((s) => ({
          ...s,
          anchorName: ensured.entry.name,
          ...(ensured.limits !== undefined ? { limits: ensured.limits } : {}),
        }))

        setState((s) => ({ ...s, phase: 'starting', token: session.token }))

        // Resume a withdrawal the anchor is still holding open, else start one.
        let transactionId = session.transactionId
        let interactiveUrl = session.interactiveUrl
        if (transactionId === undefined) {
          const started = await startWithdraw(toml, {
            authToken: session.token,
            assetCode: USDC.code,
            ...(amount !== undefined ? { amount } : {}),
          })
          transactionId = started.id
          interactiveUrl = started.url
          saveSession(window.sessionStorage, anchorId, account, {
            ...session,
            transactionId,
            interactiveUrl,
          })
        }

        // Best-effort: see `openAnchorPage`'s comment. This call is not a
        // user gesture by the time it runs, so it is expected to be blocked
        // more often than not; `popupOpen` tells the UI whether it worked.
        const popup = interactiveUrl !== undefined ? openAnchorPage(interactiveUrl) : null
        popupRef.current = popup

        setState((s) => ({
          ...s,
          phase: 'interactive',
          transactionId,
          popupOpen: popup !== null,
          ...(interactiveUrl !== undefined ? { interactiveUrl } : {}),
        }))
        poll(toml, session.token, transactionId, anchorId, account)
      }

      void run().catch((e: unknown) => {
        stopPolling()
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: e instanceof Error ? e.message : 'The withdrawal could not be started.',
        }))
      })
    },
    [address, isConnected, adapter, poll, stopPolling]
  )

  const reopen = useCallback(() => {
    const url = state.interactiveUrl
    if (url === undefined) return
    if (popupRef.current !== null && !popupRef.current.closed) {
      popupRef.current.focus()
      return
    }
    const popup = openAnchorPage(url)
    popupRef.current = popup
    setState((s) => ({ ...s, popupOpen: popup !== null }))
  }, [state.interactiveUrl])

  // A declined session is not worth resuming. A `failed` session is not
  // cleared here: the 401 path clears it explicitly because that is the one
  // failure that means the token itself is dead; every other failure (a
  // transient poll error past the ceiling, a network blip on resume) may
  // still describe a transaction the anchor is holding open, and wiping it
  // would strand that transaction's id where nothing could find it again.
  useEffect(() => {
    if (state.phase === 'declined' && state.anchorId !== undefined && address !== undefined) {
      clearSession(window.sessionStorage, state.anchorId, address)
    }
  }, [state.phase, state.anchorId, address])

  return { ...state, begin, reopen, reset }
}
