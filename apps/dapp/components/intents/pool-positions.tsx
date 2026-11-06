'use client'

import { Button, Card } from '@intent/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2 } from 'lucide-react'
import { useEffect } from 'react'

import { usePoolWithdraw } from '../../hooks/use-pool-withdraw'
import type { HeldPoolShare } from '../../lib/swap/liquidity-pools'

/**
 * Shares held in Stellar's built-in liquidity pools, with the way back out.
 *
 * Read from the account's balances, so a share deposited anywhere shows here.
 */

export async function loadPoolShares(account: string): Promise<HeldPoolShare[]> {
  const res = await fetch(`/api/pools?account=${encodeURIComponent(account)}`)
  if (!res.ok) throw new Error('could not read pool shares')
  const body = (await res.json()) as { shares?: HeldPoolShare[] }
  return body.shares ?? []
}

function figure(raw: string): string {
  const n = Number(raw)
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : raw
}

export function PoolPositions({ account }: { account: string | undefined }): JSX.Element | null {
  const withdraw = usePoolWithdraw()
  const queryClient = useQueryClient()
  const { data, error } = useQuery({
    queryKey: ['pool-shares', account],
    queryFn: () => loadPoolShares(account as string),
    enabled: account !== undefined,
    refetchInterval: 60_000,
  })

  useEffect(() => {
    if (withdraw.phase !== 'settled') return
    void queryClient.invalidateQueries({ queryKey: ['pool-shares', account] })
  }, [withdraw.phase, queryClient, account])

  if (account === undefined) return null
  if (error !== null) {
    return (
      <Card className="text-muted-foreground p-4 text-sm">
        Could not read your pool shares from the network.
      </Card>
    )
  }

  const shares = data ?? []
  if (shares.length === 0 && withdraw.phase === 'idle') return null
  const busy = withdraw.phase === 'signing' || withdraw.phase === 'submitting'

  return (
    <>
      {shares.map((share) => (
        <Card key={share.poolId} className="flex items-center gap-4 p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">Liquidity pool share</span>
              <span className="text-muted-foreground text-xs">earning trading fees</span>
            </div>
            <div className="mt-1.5 text-sm font-medium tabular-nums">
              {share.amounts.map((a) => `${figure(a.amount)} ${a.code}`).join(' + ')}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => withdraw.prepare(share.poolId)}
            disabled={withdraw.phase !== 'idle'}
          >
            Withdraw all
          </Button>
        </Card>
      ))}

      {withdraw.phase === 'building' ? (
        <Card className="text-muted-foreground flex items-center gap-2 p-5 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reading what your share is worth…
        </Card>
      ) : null}

      {withdraw.phase === 'review' || busy ? (
        <Card className="flex flex-col gap-3 p-5">
          <div className="text-sm font-semibold">Withdraw this pool share</div>
          <p className="text-muted-foreground text-sm">
            Both assets come back to your wallet, in the mix the pool holds now rather than the mix
            you put in. You receive at least{' '}
            {(withdraw.floors ?? []).map((f) => `${figure(f.amount)} ${f.code}`).join(' and ')}. If
            the pool moves further than that first, the network refuses it and your share stays put.
          </p>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={withdraw.confirm} disabled={busy}>
              {busy ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {withdraw.phase === 'signing' ? 'Waiting for your wallet…' : 'Submitting…'}
                </span>
              ) : (
                'Withdraw'
              )}
            </Button>
            {!busy ? (
              <Button variant="outline" size="sm" onClick={withdraw.reset}>
                Cancel
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      {withdraw.phase === 'settled' || withdraw.phase === 'failed' ? (
        <Card className="flex flex-col gap-3 p-5">
          <p className="text-muted-foreground text-sm">
            {withdraw.phase === 'settled'
              ? 'Withdrawn. Both assets are back in your wallet.'
              : `${withdraw.error ?? 'Something went wrong.'} Your share has not moved.`}
          </p>
          <div className="flex items-center gap-3">
            {withdraw.explorerUrl !== undefined ? (
              <a
                href={withdraw.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
              >
                View transaction
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
            <Button variant="outline" size="sm" onClick={withdraw.reset}>
              Done
            </Button>
          </div>
        </Card>
      ) : null}
    </>
  )
}
