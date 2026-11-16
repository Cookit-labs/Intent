'use client'

import type { OffRampAttentionRow, OffRampReport } from '../../lib/server/admin-metrics'
import { ChainLabel } from './by-chain'
import { EmptyNote, Kpi, Panel } from './parts'
import { formatCount, formatUsd } from './stats'

export type OffRampView = Omit<OffRampReport, 'attention'> & {
  attention: (OffRampAttentionRow & { explorerUrl: string })[]
}

const STATUS_LABEL: Record<string, string> = {
  waiting: 'Waiting for deposit',
  processing: 'Paying out',
  paid: 'Paid',
  expired: 'Expired',
  failed: 'Failed',
  refunded: 'Refunded',
}

const PROVIDER_LABEL: Record<string, string> = { linq: 'Linq', weave: 'Weave' }

const naira = (n: number): string =>
  `₦${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

function age(iso: string): string {
  const hours = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000))
  if (hours < 1) return 'under an hour'
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** Off-ramp orders on every chain: made, deposited into, paid, and any stuck after a deposit. */
export function OffRampSection({ report }: { report: OffRampView }): JSX.Element {
  const orders = report.byChain.reduce((t, r) => t + r.orders, 0)
  const paid = report.byChain.reduce((t, r) => t + r.paid, 0)
  const paidUsd = report.byChain.reduce((t, r) => t + r.paidUsd, 0)
  const paidNgn = report.byChain.reduce((t, r) => t + r.paidNgn, 0)

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi label="Off-ramp orders" value={formatCount(orders)} />
        <Kpi label="Paid out" value={formatCount(paid)} />
        <Kpi label="USDC paid out" value={formatUsd(paidUsd)} />
        <Kpi label="Naira paid out" value={naira(paidNgn)} />
        <Kpi
          label="Needs attention"
          value={formatCount(report.attention.length)}
          note="Deposit sent, not paid out"
        />
      </div>

      <Panel
        title="Needs attention"
        hint="The deposit left the user's wallet and the payout has not completed. Not limited to the date range."
      >
        {report.attention.length === 0 ? (
          <EmptyNote>Every off-ramp with a deposit has been paid or refunded.</EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-normal">Waiting</th>
                  <th className="py-2 pr-4 font-normal">Chain</th>
                  <th className="py-2 pr-4 font-normal">Provider</th>
                  <th className="py-2 pr-4 font-normal">Status</th>
                  <th className="py-2 pr-4 text-right font-normal">Sent</th>
                  <th className="py-2 pr-4 text-right font-normal">Payout</th>
                  <th className="py-2 pr-4 font-normal">Bank</th>
                  <th className="py-2 text-right font-normal">Deposit</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {report.attention.map((o) => (
                  <tr key={o.id}>
                    <td className="py-2.5 pr-4">{age(o.at)}</td>
                    <td className="whitespace-nowrap py-2.5 pr-4">
                      <ChainLabel chain={o.chain} />
                    </td>
                    <td className="py-2.5 pr-4">{PROVIDER_LABEL[o.provider] ?? o.provider}</td>
                    <td className="py-2.5 pr-4">
                      {STATUS_LABEL[o.status] ?? o.status}
                      <span className="text-muted-foreground block text-xs">
                        {o.providerStatus}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                      {Number(o.amount)} USDC
                    </td>
                    <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                      {o.estimate.toLocaleString('en-US')} {o.currency}
                    </td>
                    <td className="py-2.5 pr-4">
                      {o.institution} ••••{o.accountTail}
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
        <Panel title="By chain" hint="Orders made, deposited into and paid.">
          {report.byChain.length === 0 ? (
            <EmptyNote>No off-ramps were made in this period.</EmptyNote>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-normal">Chain</th>
                  <th className="py-2 pr-4 text-right font-normal">Orders</th>
                  <th className="py-2 pr-4 text-right font-normal">Deposited</th>
                  <th className="py-2 pr-4 text-right font-normal">Paid</th>
                  <th className="py-2 text-right font-normal">USDC paid</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {report.byChain.map((r) => (
                  <tr key={r.chain}>
                    <td className="whitespace-nowrap py-2.5 pr-4">
                      <ChainLabel chain={r.chain} />
                    </td>
                    <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                      {formatCount(r.orders)}
                    </td>
                    <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                      {formatCount(r.deposited)}
                    </td>
                    <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                      {formatCount(r.paid)}
                    </td>
                    <td className="py-2.5 text-right font-mono tabular-nums">
                      {formatUsd(r.paidUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="By provider" hint="Who paid the bank.">
          {report.byProvider.length === 0 ? (
            <EmptyNote>No off-ramps were made in this period.</EmptyNote>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-normal">Provider</th>
                  <th className="py-2 pr-4 text-right font-normal">Orders</th>
                  <th className="py-2 pr-4 text-right font-normal">Paid</th>
                  <th className="py-2 text-right font-normal">USDC paid</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {report.byProvider.map((r) => (
                  <tr key={r.provider}>
                    <td className="py-2.5 pr-4">{PROVIDER_LABEL[r.provider] ?? r.provider}</td>
                    <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                      {formatCount(r.orders)}
                    </td>
                    <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                      {formatCount(r.paid)}
                    </td>
                    <td className="py-2.5 text-right font-mono tabular-nums">
                      {formatUsd(r.paidUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  )
}
