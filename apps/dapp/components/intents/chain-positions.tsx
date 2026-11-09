'use client'

import { Card } from '@intent/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { useChainAction } from '../../hooks/use-chain-action'
import { useWallet } from '../../hooks/use-wallet'
import type { RestingOrder } from '../../lib/chains/limit'
import {
  positionRequest,
  positionRows,
  rowsAt,
  type PositionsReport,
} from '../../lib/chains/positions-reply'
import { useChain } from '../../providers/chain-provider'
import { ChainActionConfirm } from './chain-action-confirm'
import { ChainOrdersCard } from './chain-orders-card'
import { ManagePanel, PositionCard } from './position-card'

/**
 * What this wallet still has out on a chain other than Stellar, above what already finished.
 *
 * Read from each venue when the page opens, and never kept: a position grows and can be changed from
 * another app. So money put in somewhere else shows here too, and can be managed here. Managing runs
 * on its own action, and each press builds the same review card the chat signs through.
 */

async function loadPositions(chain: string, account: string): Promise<PositionsReport> {
  const res = await fetch(`/api/chain/${chain}/positions?account=${encodeURIComponent(account)}`)
  if (!res.ok) throw new Error('could not read positions')
  const body = (await res.json()) as Partial<PositionsReport>
  return { venues: body.venues ?? [], unread: body.unread ?? [] }
}

async function loadOrders(chain: string, account: string): Promise<RestingOrder[]> {
  const res = await fetch(`/api/chain/${chain}/orders?account=${encodeURIComponent(account)}`)
  if (!res.ok) throw new Error('could not read orders')
  const body = (await res.json()) as { orders?: RestingOrder[] }
  return body.orders ?? []
}

function Unread({ children }: { children: string }): JSX.Element {
  return <Card className="text-muted-foreground p-4 text-sm">{children}</Card>
}

export function ChainPositions({
  venue,
  inChat = false,
}: {
  /** A venue named in chat, whose position opens ready to manage. */
  venue?: string | undefined
  /** Says so when nothing is open, where a page can simply leave the section out. */
  inChat?: boolean
}): JSX.Element | null {
  const { address, isConnected } = useWallet()
  const { slug, descriptor } = useChain()
  const queryClient = useQueryClient()
  const action = useChainAction()
  const ready = isConnected && address !== undefined

  const positions = useQuery({
    queryKey: ['chain-positions', slug, address],
    queryFn: () => loadPositions(slug, address as string),
    enabled: ready,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const orders = useQuery({
    queryKey: ['chain-orders', slug, address],
    queryFn: () => loadOrders(slug, address as string),
    enabled: ready,
    refetchInterval: 15_000,
  })

  const all = positions.data === undefined ? [] : positionRows(positions.data)
  const rows = rowsAt(all, venue)
  const resting = orders.data ?? []
  const unreadVenues = positions.data?.unread.map((v) => v.name) ?? []

  const [openKey, setOpenKey] = useState<string | null>(null)
  // The row a card belongs to. None means the orders card pressed it.
  const [actingKey, setActingKey] = useState<string | null>(null)

  // Asked for by name, so it opens ready to use.
  const onlyKey = venue !== undefined && rows.length === 1 ? rows[0]?.key : undefined
  useEffect(() => {
    if (onlyKey !== undefined) setOpenKey(onlyKey)
  }, [onlyKey])

  const { phase } = action
  const settled = phase === 'settled'
  useEffect(() => {
    if (!settled) return
    void queryClient.invalidateQueries({ queryKey: ['chain-positions', slug, address] })
    void queryClient.invalidateQueries({ queryKey: ['chain-activity', slug, address] })
  }, [settled, queryClient, slug, address])
  useEffect(() => {
    if (phase === 'idle') setActingKey(null)
  }, [phase])

  // Anything but an idle or finished card holds the buttons, and an unknown outcome most of all:
  // the wallet may have sent, so nothing new starts until that card is dismissed.
  const busy = phase !== 'idle' && phase !== 'settled' && phase !== 'failed'

  function run(key: string, request: Parameters<typeof action.prepare>[0], asked: string): void {
    setActingKey(key)
    // Each press is the person starting something new, which is what lifts the signed latch.
    action.release()
    action.prepare(request, asked)
  }

  const count = rows.length + resting.length
  const failed = positions.isError || orders.isError || unreadVenues.length > 0
  if (!ready) return null
  if (count === 0 && !failed) {
    if (!inChat || positions.isLoading) return null
    return (
      <Card className="text-muted-foreground p-4 text-sm">
        You have nothing open on {descriptor.name}. Tokens in your wallet aren’t listed here.
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted-foreground flex items-baseline justify-between text-xs">
        <span>Open positions</span>
        <span>{count}</span>
      </div>

      {positions.isError ? (
        <Unread>
          Could not read your positions from the network, so this list may be missing money you hold
          there. It will try again shortly.
        </Unread>
      ) : null}
      {unreadVenues.length > 0 ? (
        <Unread>
          {`Could not read ${unreadVenues.join(', ')} from the network, so this list may be missing money you hold there. It will try again shortly.`}
        </Unread>
      ) : null}
      {orders.isError ? <Unread>Could not read your open orders from the network.</Unread> : null}

      {rows.map((row) => {
        const { out, into, whole } = row
        const manageable = out !== undefined || into !== undefined || whole !== undefined
        return (
          <PositionCard
            key={row.key}
            symbol={row.symbol}
            title={row.title}
            note={row.note}
            amount={row.amount}
            open={openKey === row.key}
            onToggle={
              manageable ? () => setOpenKey((key) => (key === row.key ? null : row.key)) : undefined
            }
          >
            <ManagePanel
              symbol={row.symbol}
              held={row.amount}
              busy={busy}
              out={
                out === undefined
                  ? undefined
                  : {
                      label: out.label,
                      onAmount: (amount) =>
                        run(
                          row.key,
                          positionRequest(row, out, amount),
                          `${out.label} ${amount} ${row.symbol}`
                        ),
                    }
              }
              into={
                into === undefined
                  ? undefined
                  : {
                      label: into.label,
                      onAmount: (amount) =>
                        run(
                          row.key,
                          positionRequest(row, into, amount),
                          `${into.label} ${amount} ${row.symbol}`
                        ),
                    }
              }
              all={
                whole === undefined
                  ? undefined
                  : {
                      label: whole.label,
                      onPress: () => run(row.key, whole.request, whole.label),
                    }
              }
            />
            {actingKey === row.key && phase !== 'idle' ? (
              <ChainActionConfirm action={action} />
            ) : null}
          </PositionCard>
        )
      })}

      {resting.length > 0 ? <ChainOrdersCard action={action} asked="Your limit orders" /> : null}
      {actingKey === null && phase !== 'idle' ? <ChainActionConfirm action={action} /> : null}
    </div>
  )
}
