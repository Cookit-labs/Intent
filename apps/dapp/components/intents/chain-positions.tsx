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
  type PositionRow as Row,
  type PositionsReport,
} from '../../lib/chains/positions-reply'
import { useChain } from '../../providers/chain-provider'
import { ChainActionConfirm } from './chain-action-confirm'
import { ChainOrdersCard } from './chain-orders-card'
import { ManageSheet, PositionList, PositionRow } from './position-card'

/**
 * What this wallet still has out on a chain other than Stellar, above what already finished.
 *
 * Read from each venue when the page opens, and never kept: a position grows and can be changed from
 * another app. So money put in somewhere else shows here too, and can be managed here. Managing runs
 * on its own action, and each choice builds the same review the chat signs through.
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

function Notice({ children }: { children: string }): JSX.Element {
  return <p className="text-muted-foreground px-1 text-xs leading-relaxed">{children}</p>
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

  const rows = rowsAt(positions.data === undefined ? [] : positionRows(positions.data), venue)
  const resting = orders.data ?? []
  const unreadVenues = positions.data?.unread.map((v) => v.name) ?? []
  const [openKey, setOpenKey] = useState<string | null>(null)
  const open = rows.find((row) => row.key === openKey)

  // Asked for by name, so it opens ready to use.
  const onlyKey = venue !== undefined && rows.length === 1 ? rows[0]?.key : undefined
  useEffect(() => {
    if (onlyKey !== undefined) setOpenKey(onlyKey)
  }, [onlyKey])

  const { phase } = action
  useEffect(() => {
    if (phase !== 'settled') return
    void queryClient.invalidateQueries({ queryKey: ['chain-positions', slug, address] })
    void queryClient.invalidateQueries({ queryKey: ['chain-activity', slug, address] })
  }, [phase, queryClient, slug, address])

  // Anything but an idle or finished card holds the buttons, and an unknown outcome most of all:
  // the wallet may have sent, so nothing new starts until that card is dismissed.
  const busy = phase !== 'idle' && phase !== 'settled' && phase !== 'failed'

  function run(request: Parameters<typeof action.prepare>[0], asked: string): void {
    // Each press is the person starting something new, which is what lifts the signed latch.
    action.release()
    action.prepare(request, asked)
  }

  function close(): void {
    setOpenKey(null)
    if (phase === 'settled' || phase === 'failed' || phase === 'review') action.reset()
  }

  function movesOf(row: Row) {
    const { out, into } = row
    return {
      out:
        out === undefined
          ? undefined
          : {
              label: out.label,
              onAmount: (amount: string) =>
                run(positionRequest(row, out, amount), `${out.label} ${amount} ${row.symbol}`),
            },
      into:
        into === undefined
          ? undefined
          : {
              label: into.label,
              onAmount: (amount: string) =>
                run(positionRequest(row, into, amount), `${into.label} ${amount} ${row.symbol}`),
            },
      all:
        row.whole === undefined
          ? undefined
          : { label: row.whole.label, onPress: () => run(row.whole!.request, row.whole!.label) },
    }
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

  const moves = open === undefined ? undefined : movesOf(open)

  return (
    <div className="flex flex-col gap-3">
      {rows.length > 0 ? (
        <PositionList count={count}>
          {rows.map((row) => {
            const manageable =
              row.out !== undefined || row.into !== undefined || row.whole !== undefined
            return (
              <PositionRow
                key={row.key}
                venueId={row.venueId}
                venueName={row.venueName}
                symbol={row.symbol}
                amount={row.amount}
                label={row.label}
                note={row.note}
                onOpen={manageable ? () => setOpenKey(row.key) : undefined}
              />
            )
          })}
        </PositionList>
      ) : null}

      {positions.isError ? (
        <Notice>
          Your positions couldn’t be read just now, so this may be missing money you hold. It will
          try again shortly.
        </Notice>
      ) : null}
      {unreadVenues.length > 0 ? (
        <Notice>{`${unreadVenues.join(', ')} couldn’t be read just now, so this may be missing money you hold there.`}</Notice>
      ) : null}
      {orders.isError ? <Notice>Your open orders couldn’t be read just now.</Notice> : null}

      {resting.length > 0 ? <ChainOrdersCard action={action} asked="Your limit orders" /> : null}

      {open !== undefined && moves !== undefined ? (
        <ManageSheet
          open
          onClose={close}
          venueId={open.venueId}
          venueName={open.venueName}
          symbol={open.symbol}
          held={open.amount}
          label={open.label}
          out={moves.out}
          into={moves.into}
          all={moves.all}
          busy={busy}
          review={phase !== 'idle' ? <ChainActionConfirm action={action} bare /> : undefined}
          onBack={phase === 'review' || phase === 'failed' ? action.reset : undefined}
        />
      ) : null}
    </div>
  )
}
