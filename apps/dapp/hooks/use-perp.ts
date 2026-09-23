'use client'

import { stellarTestnet } from '@intent/config'
import { useCallback, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import type { PerpIntent } from '../lib/parse-perp'
import { verifyKeyChallenge } from '../lib/perps/key-challenge'
import { clearKey, loadKey, saveKey } from '../lib/perps/key-store'
import type { NoetherKey } from '../lib/perps/noether-client'
import { sessionToken } from '../lib/perps/noether-client'
import { MAX_LEVERAGE } from '../lib/perps/order-flow'

/**
 * Opening a leveraged position on Noether.
 *
 * Its own hook, like `use-supply`, because it is its own shape: no route was
 * quoted, no agents competed, and there is a step none of the other flows
 * have — a sign-in with the venue before anything is built. Noether's
 * gateway prepares an order only for a wallet holding one of its API keys,
 * and a key is minted by signing a challenge, so the first position in a
 * tab costs two wallet prompts and every later one costs one.
 *
 * The sign-in prompt is the one that moves nothing, and the card says so:
 * a second prompt right after "long XLM" reads as a second trade.
 */

export type PerpPhase =
  | 'idle'
  | 'authenticating'
  | 'building'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'settled'
  | 'failed'
  // The gateway will not issue this wallet a key. Its own state rather than
  // `failed`, because nothing went wrong: the venue is in closed beta.
  | 'not-in-beta'

export interface PerpOrder {
  side: 'long' | 'short'
  asset: string
  leverage: number
  /** True when the text named no leverage and 1x was assumed. */
  leverageDefaulted: boolean
  /** Display units of the market's USDC. */
  collateral: string
}

/** What the server read and simulated, shown verbatim on the card. */
export interface PerpPrepared {
  markPrice: string
  markPriceUsd: number
  entryPrice: string
  liquidationPrice: string
  size: string
  acceptablePrice: string
  version: string
  usdcToken: string
}

export interface PerpState {
  phase: PerpPhase
  order?: PerpOrder
  xdr?: string
  prepared?: PerpPrepared
  hash?: string
  explorerUrl?: string
  error?: string
}

export interface Perp extends PerpState {
  /** Signs in if needed, prepares the position and holds it for review. */
  prepare: (intent: PerpIntent) => void
  confirm: () => void
  reset: () => void
}

const EMPTY: PerpState = { phase: 'idle' }

/** Gateway codes that mean the stored key is no longer good. */
const STALE_KEY_CODES = new Set(['missing_bearer', 'malformed_bearer', 'invalid_bearer'])

export function usePerp(): Perp {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<PerpState>(EMPTY)

  const reset = useCallback(() => setState(EMPTY), [])

  const prepare = useCallback(
    (intent: PerpIntent) => {
      if (!isConnected || address === undefined) {
        setState({ phase: 'failed', error: 'Connect a wallet to open a position.' })
        return
      }
      if (intent.collateral === undefined) {
        setState({
          phase: 'failed',
          error: 'Name the collateral to put up, for example "long XLM 5x with 50 USDC".',
        })
        return
      }
      // Leverage is read as stated and refused here, not capped. Someone who
      // asked for 25x and got 10x would hold a different position from the
      // one they approved.
      const leverage = intent.leverage ?? 1
      if (leverage > MAX_LEVERAGE) {
        setState({
          phase: 'failed',
          error: `Noether allows up to ${MAX_LEVERAGE}x; ${leverage}x was asked for. Nothing was prepared.`,
        })
        return
      }
      const signer = address
      const order: PerpOrder = {
        side: intent.side,
        asset: intent.asset,
        leverage,
        leverageDefaulted: intent.leverage === undefined,
        collateral: intent.collateral,
      }

      async function signIn(): Promise<NoetherKey | undefined> {
        setState({ phase: 'authenticating', order })

        const res = await fetch(`/api/perps/session?account=${encodeURIComponent(signer)}`)
        const begun = (await res.json()) as {
          xdr?: string
          challengeHex?: string
          error?: string
          code?: string
        }
        if (!res.ok || begun.xdr === undefined || begun.challengeHex === undefined) {
          setState({
            phase: begun.code === 'not_in_beta' ? 'not-in-beta' : 'failed',
            order,
            error: begun.error ?? 'Noether could not start the sign-in.',
          })
          return undefined
        }

        // Every check before the wallet is involved. The server built this,
        // but the browser verifies it anyway: a prompt for a challenge that
        // fails any of these is exactly what this check exists to stop.
        try {
          verifyKeyChallenge(begun.xdr, {
            address: signer,
            challengeHex: begun.challengeHex,
            networkPassphrase: stellarTestnet.networkPassphrase,
          })
        } catch (e) {
          setState({
            phase: 'failed',
            order,
            error: e instanceof Error ? e.message : 'The sign-in challenge could not be verified.',
          })
          return undefined
        }

        const signed = await adapter.signTransaction?.({ xdr: begun.xdr, address: signer })
        if (signed === undefined) {
          setState({ phase: 'failed', order, error: 'This chain cannot sign here.' })
          return undefined
        }
        if (!signed.ok) {
          setState({
            phase: 'failed',
            order,
            error:
              signed.reason === 'rejected'
                ? 'You declined the Noether sign-in. Nothing was signed and nothing was prepared.'
                : (signed.detail ?? 'The wallet could not sign the sign-in.'),
          })
          return undefined
        }

        const exchanged = await fetch('/api/perps/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: signer,
            challengeHex: begun.challengeHex,
            signedXdr: signed.signedXdr,
          }),
        })
        const body = (await exchanged.json()) as { key?: NoetherKey; error?: string; code?: string }
        if (!exchanged.ok || body.key === undefined) {
          setState({
            phase: body.code === 'not_in_beta' ? 'not-in-beta' : 'failed',
            order,
            error: body.error ?? 'Noether did not issue a key.',
          })
          return undefined
        }
        saveKey(window.sessionStorage, signer, body.key)
        return body.key
      }

      async function run(): Promise<void> {
        let key = loadKey(window.sessionStorage, signer)
        if (key === undefined) {
          key = await signIn()
          if (key === undefined) return
        }

        setState({ phase: 'building', order })
        const res = await fetch('/api/perps/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: signer,
            asset: order.asset,
            side: order.side,
            collateral: order.collateral,
            leverage: order.leverage,
            authToken: sessionToken(key),
          }),
        })
        const built = (await res.json()) as {
          xdr?: string
          markPrice?: string
          markPriceUsd?: number
          acceptablePrice?: string
          version?: string
          contracts?: { usdcToken?: string }
          position?: { entryPrice: string; liquidationPrice: string; size: string }
          error?: string
          code?: string
        }
        if (!res.ok || built.xdr === undefined || built.position === undefined) {
          // A key the gateway no longer accepts is forgotten, so the next
          // attempt signs in afresh rather than failing the same way.
          if (built.code !== undefined && STALE_KEY_CODES.has(built.code)) {
            clearKey(window.sessionStorage, signer)
          }
          setState({
            phase: 'failed',
            order,
            error: built.error ?? 'Noether could not prepare the position.',
          })
          return
        }

        setState({
          phase: 'review',
          order,
          xdr: built.xdr,
          prepared: {
            markPrice: built.markPrice ?? '0',
            markPriceUsd: built.markPriceUsd ?? 0,
            entryPrice: built.position.entryPrice,
            liquidationPrice: built.position.liquidationPrice,
            size: built.position.size,
            acceptablePrice: built.acceptablePrice ?? '0',
            version: built.version ?? 'unknown',
            usdcToken: built.contracts?.usdcToken ?? '',
          },
        })
      }

      void run().catch(() => {
        setState({ phase: 'failed', order, error: 'Could not reach the network.' })
      })
    },
    [address, isConnected, adapter]
  )

  const confirm = useCallback(() => {
    const envelope = state.xdr
    if (envelope === undefined || state.order === undefined || address === undefined) return
    const signer = address
    // Bound after the guard, because `run` is hoisted above it and the
    // narrowing does not reach a hoisted declaration.
    const order: PerpOrder = state.order

    async function run(): Promise<void> {
      setState((s) => ({ ...s, phase: 'signing' }))

      const signed = await adapter.signTransaction?.({ xdr: envelope as string, address: signer })
      if (signed === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: 'This chain cannot sign here.' }))
        return
      }
      if (!signed.ok) {
        // Declining returns to review: the position is still on offer.
        if (signed.reason === 'rejected') {
          setState((s) => ({ ...s, phase: 'review' }))
          return
        }
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: signed.detail ?? 'The wallet could not sign this position.',
        }))
        return
      }

      const key = loadKey(window.sessionStorage, signer)
      if (key === undefined) {
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: 'The Noether sign-in expired before submission. Start over to sign in again.',
        }))
        return
      }

      setState((s) => ({ ...s, phase: 'submitting' }))
      const res = await fetch('/api/perps/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signedXdr: signed.signedXdr,
          account: signer,
          asset: order.asset,
          side: order.side,
          collateral: order.collateral,
          leverage: order.leverage,
          authToken: sessionToken(key),
        }),
      })
      const result = (await res.json()) as {
        ok?: boolean
        hash?: string
        explorerUrl?: string
        error?: string
      }
      if (result.ok !== true) {
        setState((s) => ({
          ...s,
          phase: 'failed',
          ...(result.hash !== undefined ? { hash: result.hash } : {}),
          error: result.error ?? 'The position did not open.',
        }))
        return
      }
      setState((s) => ({
        ...s,
        phase: 'settled',
        ...(result.hash !== undefined ? { hash: result.hash } : {}),
        ...(result.explorerUrl !== undefined ? { explorerUrl: result.explorerUrl } : {}),
      }))
    }

    void run().catch(() => {
      setState((s) => ({
        ...s,
        phase: 'failed',
        error: 'Something went wrong signing the position.',
      }))
    })
  }, [state.xdr, state.order, address, adapter])

  return { ...state, prepare, confirm, reset }
}
