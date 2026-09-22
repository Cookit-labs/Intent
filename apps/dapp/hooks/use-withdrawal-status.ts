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
} {
  const { adapter } = useChain()
  const { address } = useWallet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(
    async (turnId: string, anchor: { id: string; transactionId: string }, chain: string) => {
      if (address === undefined || !isAnchorId(anchor.id)) return
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
        if (turn === undefined) return
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
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not read the anchor.')
      } finally {
        setBusy(false)
      }
    },
    [address, adapter]
  )

  return { refresh, busy, ...(error !== undefined ? { error } : {}) }
}
