'use client'

import { useCallback, useState } from 'react'

import { loadTurns, updateTurn } from '../lib/chat-history'
import type { AnchorId } from '../lib/offramp/anchors'
import { isAnchorId } from '../lib/offramp/anchors'
import { ensureAuthSession } from '../lib/offramp/ensure-session'
import { readTransaction } from '../lib/offramp/sep24'
import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'

/**
 * Asks the anchor where a withdrawal stands, and records the answer.
 *
 * The anchor's transaction endpoint needs a SEP-10 token, and tokens live
 * fifteen minutes. A withdrawal checked a day later therefore needs the
 * wallet to sign a fresh challenge — one prompt, moving nothing — which is
 * why this is a button and not a background poll.
 */
export function useWithdrawalStatus(): {
  refresh: (
    turnId: string,
    anchor: { id: string; transactionId: string },
    chain: string
  ) => Promise<void>
  busy: boolean
  error?: string
  /**
   * Bumped after every write to history, so a caller can key an effect on
   * the data actually changing rather than on `busy` toggling — which also
   * fires on a guard path that never wrote anything.
   */
  refreshed: number
} {
  const { adapter } = useChain()
  const { address } = useWallet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [refreshed, setRefreshed] = useState(0)

  const refresh = useCallback(
    async (turnId: string, anchor: { id: string; transactionId: string }, chain: string) => {
      if (address === undefined) {
        setError('Connect a wallet to check a withdrawal.')
        return
      }
      if (!isAnchorId(anchor.id)) {
        setError(`${anchor.id} is not an anchor this app uses.`)
        return
      }
      const account = address
      const anchorId: AnchorId = anchor.id
      setBusy(true)
      setError(undefined)
      try {
        const ensured = await ensureAuthSession({
          anchorId,
          account,
          sign: async (xdr) => {
            const out = await adapter.signTransaction?.({ xdr, address: account })
            if (out === undefined || !out.ok)
              throw new Error('The wallet did not sign the anchor sign-in.')
            return out.signedXdr
          },
        })
        const tx = await readTransaction(ensured.toml, {
          authToken: ensured.session.token,
          id: anchor.transactionId,
        })
        // `updateTurn` takes a partial, so the bundle is read, mapped and
        // written back whole.
        const turn = loadTurns(chain).find((t) => t.id === turnId)
        if (turn === undefined) {
          setError('This withdrawal is no longer in your history.')
          return
        }
        updateTurn(turnId, {
          bundle: (turn.bundle ?? []).map((step) =>
            step.anchor?.transactionId === anchor.transactionId
              ? {
                  ...step,
                  anchor: {
                    ...step.anchor,
                    lastStatus: tx.status,
                    ...(tx.moreInfoUrl !== undefined ? { moreInfoUrl: tx.moreInfoUrl } : {}),
                  },
                }
              : step
          ),
        })
        setRefreshed((n) => n + 1)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not read the anchor.')
      } finally {
        setBusy(false)
      }
    },
    [address, adapter]
  )

  return { refresh, busy, refreshed, ...(error !== undefined ? { error } : {}) }
}
