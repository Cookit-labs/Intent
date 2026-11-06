'use client'

import { Button, Card } from '@intent/ui'
import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { ChainAction } from '../../hooks/use-chain-action'
import { useWallet } from '../../hooks/use-wallet'
import type { RestingOrder } from '../../lib/chains/limit'
import { exitsFor, freshExit, GONE, orderLine, type OrderExit } from '../../lib/chains/orders-view'
import { useChain } from '../../providers/chain-provider'

const UNAVAILABLE = 'Your orders could not be read just now. Nothing was signed or sent.'

/**
 * The account's resting limit orders, read from the venue when this opens and again after an exit
 * settles, and never kept. Each press reads the order once more before anything is built.
 */
export function ChainOrdersCard({
  action,
  asked,
}: {
  action: ChainAction
  asked: string
}): JSX.Element {
  const { slug } = useChain()
  const { address } = useWallet()
  const [orders, setOrders] = useState<RestingOrder[] | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [note, setNote] = useState<string | undefined>(undefined)
  const settledHash = action.phase === 'settled' ? action.hash : undefined

  const read = useCallback(async (): Promise<RestingOrder[] | undefined> => {
    if (address === undefined) return undefined
    try {
      const res = await fetch(`/api/chain/${slug}/orders?account=${encodeURIComponent(address)}`)
      const body = (await res.json()) as { orders?: RestingOrder[] }
      return res.ok && Array.isArray(body.orders) ? body.orders : undefined
    } catch {
      return undefined
    }
  }, [address, slug])

  useEffect(() => {
    let current = true
    void read().then((found) => {
      if (!current) return
      if (found === undefined) {
        setError(address === undefined ? 'Connect a wallet to see your orders.' : UNAVAILABLE)
        return
      }
      setError(undefined)
      setOrders(found)
    })
    return () => {
      current = false
    }
  }, [read, address, settledHash])

  async function press(listed: RestingOrder, wanted: OrderExit): Promise<void> {
    setNote(undefined)
    const fresh = await read()
    if (fresh === undefined) {
      setNote(UNAVAILABLE)
      return
    }
    setOrders(fresh)
    const now = fresh.find((o) => o.id === listed.id)
    const exit = freshExit(listed, now, wanted)
    if (exit === 'gone') {
      setNote(GONE)
      return
    }
    action.prepareExit(listed.id, exit, asked)
  }

  const busy =
    action.phase === 'building' || action.phase === 'signing' || action.phase === 'submitting'

  return (
    <Card className="flex flex-col gap-3 p-5">
      <span className="text-sm font-medium">Your limit orders</span>
      {orders === null && error === undefined ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
          Reading your orders
        </p>
      ) : null}
      {error !== undefined ? (
        <p role="alert" className="text-sm leading-relaxed">
          {error}
        </p>
      ) : null}
      {orders !== null && orders.length === 0 ? (
        <p className="text-muted-foreground text-sm">You have no resting limit orders here.</p>
      ) : null}
      {orders !== null && orders.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {orders.map((order) => (
            <li key={order.id} className="flex flex-col gap-1">
              <span className="text-sm [overflow-wrap:anywhere]">{orderLine(order)}</span>
              <span className="text-muted-foreground text-xs">via {order.venueId}</span>
              {order.note !== undefined ? (
                <span className="text-muted-foreground text-xs">{order.note}</span>
              ) : null}
              <div className="flex items-center gap-2">
                {exitsFor(order).map((exit) => (
                  <Button
                    key={exit}
                    size="sm"
                    variant={exit === 'cancel' ? 'ghost' : 'default'}
                    disabled={busy}
                    onClick={() => void press(order, exit)}
                  >
                    {exit === 'cancel' ? 'Cancel order' : 'Collect'}
                  </Button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {note !== undefined ? (
        <p role="status" className="text-sm leading-relaxed">
          {note}
        </p>
      ) : null}
    </Card>
  )
}
