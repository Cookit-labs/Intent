'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { lookupAnchor } from '../lib/offramp/anchors'
import type { AnchorId } from '../lib/offramp/anchors'
import { authenticate } from '../lib/offramp/sep10'
import type { Sep24Status, WithdrawLimits } from '../lib/offramp/sep24'
import {
  AnchorHttpError,
  isDeclined,
  isReadyToPay,
  readTransaction,
  startWithdraw,
} from '../lib/offramp/sep24'
import { clearSession, loadSession, saveSession } from '../lib/offramp/session-store'
import type { AnchorToml } from '../lib/offramp/toml'
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
const EMPTY: OfframpSessionState = { phase: 'idle' }

interface AnchorInfo {
  anchor: { id: AnchorId; name: string; homeDomain: string; what: string }
  toml: AnchorToml
  limits: WithdrawLimits | null
}

function openAnchorPage(url: string): Window | null {
  // No `noopener`: it would sever the handle the anchor uses to postMessage
  // back. Opened from a click, or the browser blocks it.
  return window.open(url, 'intent-anchor', 'popup,width=520,height=760')
}

export function useOfframpSession(): OfframpSession {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<OfframpSessionState>(EMPTY)
  const tomlRef = useRef<AnchorToml | undefined>(undefined)
  const popupRef = useRef<Window | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const stopPolling = useCallback(() => {
    if (pollRef.current !== undefined) clearInterval(pollRef.current)
    pollRef.current = undefined
  }, [])

  const reset = useCallback(() => {
    stopPolling()
    popupRef.current = null
    tomlRef.current = undefined
    setState(EMPTY)
  }, [stopPolling])

  useEffect(() => stopPolling, [stopPolling])

  const poll = useCallback(
    (toml: AnchorToml, token: string, id: string) => {
      stopPolling()
      pollRef.current = setInterval(() => {
        void (async () => {
          try {
            const tx = await readTransaction(toml, { authToken: token, id })
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
            // One failed read is not a failed withdrawal; the next tick tries
            // again. A 401 means the token died, which is reported.
            if (e instanceof AnchorHttpError && e.status === 401) {
              stopPolling()
              setState((s) => ({
                ...s,
                phase: 'failed',
                error: 'The anchor session expired. Start the withdrawal again.',
              }))
            }
          }
        })()
      }, POLL_MS)
    },
    [stopPolling]
  )

  const begin = useCallback(
    (anchorId: AnchorId, amount?: string) => {
      if (!isConnected || address === undefined) {
        setState({ ...EMPTY, phase: 'failed', error: 'Connect a wallet to withdraw.' })
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

        const infoRes = await fetch(`/api/offramp/anchor?id=${anchorId}`)
        const info = (await infoRes.json()) as Partial<AnchorInfo> & { error?: string }
        if (info.toml === undefined || info.anchor === undefined) {
          setState({
            ...EMPTY,
            phase: 'failed',
            anchorId,
            error: info.error ?? 'The anchor could not be reached.',
          })
          return
        }
        tomlRef.current = info.toml
        const anchorInfo = info.anchor
        setState((s) => ({
          ...s,
          anchorName: anchorInfo.name,
          ...(info.limits !== null && info.limits !== undefined ? { limits: info.limits } : {}),
        }))

        // A token from a reload, if it is still alive. Otherwise the wallet
        // signs a challenge — a sequence-0 transaction that can never be
        // submitted, verified before the prompt is raised.
        let session = loadSession(window.sessionStorage, anchorId, account)
        if (session === undefined) {
          const auth = await authenticate({
            anchor: entry,
            toml: info.toml,
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
          session = { token: auth.token, expiresAt: auth.expiresAt }
          saveSession(window.sessionStorage, anchorId, account, session)
        }
        setState((s) => ({ ...s, phase: 'starting', token: session?.token }))

        // Resume a withdrawal the anchor is still holding open, else start one.
        let transactionId = session.transactionId
        let interactiveUrl = session.interactiveUrl
        if (transactionId === undefined) {
          const started = await startWithdraw(info.toml, {
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

        setState((s) => ({
          ...s,
          phase: 'interactive',
          transactionId,
          ...(interactiveUrl !== undefined ? { interactiveUrl } : {}),
        }))
        if (interactiveUrl !== undefined) popupRef.current = openAnchorPage(interactiveUrl)
        poll(info.toml, session.token, transactionId)
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
    popupRef.current = openAnchorPage(url)
  }, [state.interactiveUrl])

  // A declined or failed session is not worth resuming.
  useEffect(() => {
    if (
      (state.phase === 'declined' || state.phase === 'failed') &&
      state.anchorId !== undefined &&
      address !== undefined
    ) {
      clearSession(window.sessionStorage, state.anchorId, address)
    }
  }, [state.phase, state.anchorId, address])

  return { ...state, begin, reopen, reset }
}
