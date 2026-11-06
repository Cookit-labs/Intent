'use client'

import { useCallback, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import { FAILURE_MESSAGES } from '../lib/swap/submit'

/** Taking a share back out of a Stellar liquidity pool: build, review, sign, submit. */

export type PoolWithdrawPhase =
  | 'idle'
  | 'building'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'settled'
  | 'failed'

export interface PoolWithdrawState {
  phase: PoolWithdrawPhase
  poolId?: string
  xdr?: string
  /** The least of each asset this accepts. */
  floors?: { code: string; amount: string }[]
  explorerUrl?: string
  error?: string
}

export interface PoolWithdraw extends PoolWithdrawState {
  prepare: (poolId: string) => void
  confirm: () => void
  reset: () => void
}

const EMPTY: PoolWithdrawState = { phase: 'idle' }

export function usePoolWithdraw(): PoolWithdraw {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<PoolWithdrawState>(EMPTY)

  const reset = useCallback(() => setState(EMPTY), [])

  const prepare = useCallback(
    (poolId: string) => {
      if (!isConnected || address === undefined) {
        setState({ phase: 'failed', error: 'Connect a wallet to withdraw.' })
        return
      }

      async function run(): Promise<void> {
        setState({ phase: 'building', poolId })
        try {
          const res = await fetch('/api/pools/withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: address, poolId }),
          })
          const built = (await res.json()) as {
            xdr?: string
            floors?: { code: string; amount: string }[]
            error?: string
          }
          if (built.xdr === undefined) {
            setState({ phase: 'failed', error: built.error ?? 'This could not be built.' })
            return
          }
          setState({
            phase: 'review',
            poolId,
            xdr: built.xdr,
            ...(built.floors !== undefined ? { floors: built.floors } : {}),
          })
        } catch {
          setState({ phase: 'failed', error: 'Could not reach the network.' })
        }
      }

      void run()
    },
    [address, isConnected]
  )

  const confirm = useCallback(() => {
    const envelope = state.xdr
    if (envelope === undefined || address === undefined) return
    const signer = address

    async function run(): Promise<void> {
      setState((s) => ({ ...s, phase: 'signing' }))

      const signed = await adapter.signTransaction?.({ xdr: envelope as string, address: signer })
      if (signed === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: 'This chain cannot withdraw yet.' }))
        return
      }
      if (!signed.ok) {
        if (signed.reason === 'rejected') {
          setState((s) => ({ ...s, phase: 'review' }))
          return
        }
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: signed.detail ?? 'The wallet could not sign this withdrawal.',
        }))
        return
      }

      setState((s) => ({ ...s, phase: 'submitting' }))

      const res = await fetch('/api/pools/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedXdr: signed.signedXdr, account: signer }),
      })
      const result = (await res.json()) as {
        ok?: boolean
        explorerUrl?: string
        reason?: keyof typeof FAILURE_MESSAGES
      }

      if (result.ok !== true) {
        setState((s) => ({
          ...s,
          phase: 'failed',
          error:
            result.reason !== undefined
              ? FAILURE_MESSAGES[result.reason]
              : 'The withdrawal did not go through.',
        }))
        return
      }

      setState((s) => ({
        ...s,
        phase: 'settled',
        ...(result.explorerUrl !== undefined ? { explorerUrl: result.explorerUrl } : {}),
      }))
    }

    void run().catch(() => {
      setState((s) => ({
        ...s,
        phase: 'failed',
        error: 'Something went wrong signing the withdrawal.',
      }))
    })
  }, [state.xdr, address, adapter])

  return { ...state, prepare, confirm, reset }
}
