'use client'

import { Button, Card } from '@intent/ui'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'

import { useWallet } from '../../hooks/use-wallet'
import type { RestingOrder } from '../../lib/chains/limit'
import { orderLine } from '../../lib/chains/orders-view'
import { positionRows, type PositionsReport } from '../../lib/chains/positions-reply'
import { useChain } from '../../providers/chain-provider'
import { TokenIcon } from '../ui/token-icon'

/**
 * What this wallet still has out on a chain other than Stellar, above what already finished.
 *
 * Read from each venue when the page opens, and never kept: a position grows and can be changed from
 * another app. The way out goes through the chat, which already builds, checks and signs it.
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

function amount(raw: string): string {
  const n = Number(raw)
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : raw
}

function Unread({ children }: { children: string }): JSX.Element {
  return <Card className="text-muted-foreground p-4 text-sm">{children}</Card>
}

function ToChat({
  segment,
  words,
  label,
}: {
  segment: string
  words: string
  label: string
}): JSX.Element {
  return (
    <Button asChild size="sm" variant="outline" className="shrink-0">
      <Link href={`/${segment}/intents/new?say=${encodeURIComponent(words)}`}>{label}</Link>
    </Button>
  )
}

export function ChainPositions(): JSX.Element | null {
  const { address, isConnected } = useWallet()
  const { slug, segment } = useChain()
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

  const rows = positions.data === undefined ? [] : positionRows(positions.data)
  const resting = orders.data ?? []
  const unreadVenues = positions.data?.unread.map((venue) => venue.name) ?? []
  const count = rows.length + resting.length

  // A read that failed is not "nothing open", which is the one thing this must not imply.
  const failed = positions.isError || orders.isError || unreadVenues.length > 0
  if (!ready || (count === 0 && !failed)) return null

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

      {rows.map((row) => (
        <Card key={row.key} className="flex flex-wrap items-center gap-4 p-4">
          <TokenIcon symbol={row.symbol} size={28} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">{row.title}</span>
              <span className="text-muted-foreground text-xs">{row.note}</span>
            </div>
            <div className="mt-1.5 text-sm font-medium tabular-nums">
              {amount(row.amount)} {row.symbol}
            </div>
          </div>
          {row.exit !== undefined ? (
            <ToChat segment={segment} words={row.exit.words} label={row.exit.label} />
          ) : null}
        </Card>
      ))}

      {resting.map((order) => (
        <Card key={order.id} className="flex flex-wrap items-center gap-4 p-4">
          <TokenIcon symbol={order.tokenIn} size={28} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">Limit order</span>
              <span className="text-muted-foreground text-xs">resting</span>
            </div>
            <div className="mt-1.5 text-sm font-medium tabular-nums">{orderLine(order)}</div>
          </div>
          <ToChat segment={segment} words="my orders" label="Manage" />
        </Card>
      ))}
    </div>
  )
}
