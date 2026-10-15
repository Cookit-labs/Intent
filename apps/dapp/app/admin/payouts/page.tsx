'use client'

import { useCallback, useEffect, useState } from 'react'

import { EmptyNote, Kpi, PageTitle, Panel } from '../../../components/admin/parts'
import { useScope } from '../../../components/admin/scope'
import { formatCount, formatUsd } from '../../../components/admin/stats'
import type { NairaAttentionRow, NairaReport } from '../../../lib/server/admin-metrics'

type Attention = NairaAttentionRow & { explorerUrl: string }
type Report = Omit<NairaReport, 'attention'> & { attention: Attention[] }

const REFRESH_MS = 30_000

const STATUS_LABEL: Record<string, string> = {
  waiting: 'Waiting for deposit',
  processing: 'Paying out',
  paid: 'Paid',
  expired: 'Expired',
  failed: 'Failed',
}

const ROUTE_LABEL: Record<string, string> = {
  xlm: 'XLM direct',
  usdc: 'USDC after a swap',
}

const naira = (n: number): string =>
  `₦${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

function age(iso: string): string {
  const hours = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000))
  if (hours < 1) return 'under an hour'
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export default function AdminPayoutsPage(): JSX.Element {
  const { scope, range } = useScope()
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [tick, setTick] = useState(0)

  const network = scope.network
  const tracked = scope.chain === 'stellar' && network !== null

  useEffect(() => {
    setReport(null)
    setError(undefined)
    if (!tracked) return
    const controller = new AbortController()
    fetch(`/api/admin/metrics?view=payouts&chain=stellar&network=${network}&range=${range}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { naira?: Report; error?: string }
        if (!res.ok || body.naira === undefined) throw new Error(body.error ?? 'unavailable')
        setReport(body.naira)
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setError(
          e instanceof Error && e.message === 'no_database'
            ? 'No database is connected, so there is nothing to count yet.'
            : 'The payouts could not be loaded. Try again in a moment.'
        )
      })
    return () => controller.abort()
  }, [network, range, tracked, tick])

  useEffect(() => {
    if (!tracked) return
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS)
    return () => clearInterval(id)
  }, [tracked])

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  return (
    <>
      <PageTitle
        title="Payouts"
        hint="Cash-outs to naira: what was paid, and what was sent but not paid out yet."
      />

      {!tracked ? (
        <Panel title={`${scope.name} payouts`}>
          <EmptyNote>
            Naira payouts only run on Stellar, so there is nothing to show here.
          </EmptyNote>
        </Panel>
      ) : error !== undefined ? (
        <Panel title="Could not load the payouts">
          <p className="text-muted-foreground text-sm">{error}</p>
          <button
            type="button"
            onClick={refresh}
            className="text-brand w-fit text-sm underline-offset-2 hover:underline"
          >
            Try again
          </button>
        </Panel>
      ) : report === null ? (
        <div aria-busy="true" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="border-border bg-muted/40 h-24 animate-pulse rounded-2xl border"
            />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Kpi label="Orders" value={formatCount(report.orders)} />
            <Kpi label="Paid out" value={formatCount(report.paid.count)} />
            <Kpi label="Naira paid out" value={naira(report.paid.ngn)} />
            <Kpi
              label="Cashed out"
              value={formatUsd(report.cashedOut.usd)}
              note={
                report.cashedOut.unvalued > 0
                  ? `${report.cashedOut.unvalued} cash-out${report.cashedOut.unvalued === 1 ? '' : 's'} could not be priced`
                  : `${formatCount(report.cashedOut.count)} payment${report.cashedOut.count === 1 ? '' : 's'} sent`
              }
            />
            <Kpi
              label="Needs attention"
              value={formatCount(report.attention.length)}
              note="Payment sent, not paid out"
            />
          </div>

          <Panel
            title="Needs attention"
            hint="The payment left the user's wallet and the payout has not completed. Not limited to the date range."
          >
            {report.attention.length === 0 ? (
              <EmptyNote>Every payment that was sent has been paid out.</EmptyNote>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-normal">Waiting</th>
                      <th className="py-2 pr-4 font-normal">Status</th>
                      <th className="py-2 pr-4 font-normal">Route</th>
                      <th className="py-2 pr-4 text-right font-normal">Sent</th>
                      <th className="py-2 pr-4 text-right font-normal">Naira</th>
                      <th className="py-2 pr-4 font-normal">Bank</th>
                      <th className="py-2 text-right font-normal">Payment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {report.attention.map((o) => (
                      <tr key={o.id}>
                        <td className="py-2.5 pr-4">{age(o.at)}</td>
                        <td className="py-2.5 pr-4">{STATUS_LABEL[o.status] ?? o.status}</td>
                        <td className="py-2.5 pr-4">{ROUTE_LABEL[o.coin] ?? o.coin}</td>
                        <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                          {Number(o.amount)} {o.coin.toUpperCase()}
                        </td>
                        <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                          {naira(o.amountNgn)}
                        </td>
                        <td className="py-2.5 pr-4">
                          {o.bankName} ••••{o.accountTail}
                        </td>
                        <td className="py-2.5 text-right">
                          <a
                            href={o.explorerUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand underline-offset-2 hover:underline"
                          >
                            View
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="By status" hint="Expired orders with no payment sent were abandoned.">
              {report.byStatus.length === 0 ? (
                <EmptyNote>No payouts were set up in this period.</EmptyNote>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-normal">Status</th>
                      <th className="py-2 pr-4 text-right font-normal">Orders</th>
                      <th className="py-2 pr-4 text-right font-normal">Payment sent</th>
                      <th className="py-2 text-right font-normal">Naira</th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {report.byStatus.map((s) => (
                      <tr key={s.status}>
                        <td className="py-2.5 pr-4">{STATUS_LABEL[s.status] ?? s.status}</td>
                        <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                          {formatCount(s.count)}
                        </td>
                        <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                          {formatCount(s.sent)}
                        </td>
                        <td className="py-2.5 text-right font-mono tabular-nums">{naira(s.ngn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel title="By route" hint="Paid orders and the naira they paid out.">
              {report.byCoin.length === 0 ? (
                <EmptyNote>No payouts were set up in this period.</EmptyNote>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-normal">Route</th>
                      <th className="py-2 pr-4 text-right font-normal">Orders</th>
                      <th className="py-2 pr-4 text-right font-normal">Paid</th>
                      <th className="py-2 text-right font-normal">Naira paid</th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {report.byCoin.map((c) => (
                      <tr key={c.coin}>
                        <td className="py-2.5 pr-4">{ROUTE_LABEL[c.coin] ?? c.coin}</td>
                        <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                          {formatCount(c.orders)}
                        </td>
                        <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                          {formatCount(c.paid)}
                        </td>
                        <td className="py-2.5 text-right font-mono tabular-nums">
                          {naira(c.paidNgn)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>
        </>
      )}
    </>
  )
}
